import type { UpstreamSnapshot } from '@/types'

/** Which vendor the raw exchange points at.
 *
 *  Decided from vendor-named headers, never from guesswork: `x-ms-region` /
 *  `apim-request-id` only come out of Azure's stack, `openai-organization` /
 *  `openai-processing-ms` only out of OpenAI's. A gateway that strips both
 *  leaves nothing to judge, and that is reported as `unknown` rather than
 *  guessed — the evidence list is shown next to every verdict so the reader
 *  can always overrule the heuristic.
 */
export type VendorKind = 'openai' | 'azure' | 'other' | 'unknown'

export interface VendorVerdict {
  vendor: VendorKind
  label: string
  /** Matched signals, strongest first, capped for display. */
  evidence: string[]
}

export const VENDOR_LABEL: Record<VendorKind, string> = {
  openai: 'OpenAI 官方',
  azure: 'Azure OpenAI',
  other: '第三方/网关重打包',
  unknown: '无法判定',
}

/** One matched signal. `primary` marks headers only the vendor's own stack
 *  emits; secondaries (Cloudflare, id formats) corroborate but never decide
 *  alone — plenty of unrelated gateways sit behind Cloudflare too. */
interface Hit {
  weight: number
  primary?: boolean
  evidence: string
}

const sum = (hits: Hit[]) => hits.reduce((s, h) => s + h.weight, 0)
const hasPrimary = (hits: Hit[]) => hits.some(h => h.primary)
const byWeight = (hits: Hit[]) => [...hits].sort((a, b) => b.weight - a.weight)

export function detectVendor(snap: UpstreamSnapshot): VendorVerdict {
  // Lowercased multi-map — duplicate names (set-cookie) all kept.
  const h = new Map<string, string[]>()
  for (const [name, value] of snap.headers ?? []) {
    const key = name.toLowerCase()
    const list = h.get(key)
    if (list) list.push(value)
    else h.set(key, [value])
  }
  const get = (n: string) => h.get(n)?.[0]
  const has = (n: string) => h.has(n)
  const names = Array.from(h.keys())

  const azure: Hit[] = []
  const openai: Hit[] = []
  const other: Hit[] = []

  // ── Azure ──────────────────────────────────────────────────────────────
  if (has('apim-request-id')) {
    azure.push({ weight: 3, primary: true, evidence: 'apim-request-id' })
  }
  const region = get('x-ms-region')
  if (region) {
    azure.push({ weight: 3, primary: true, evidence: `x-ms-region: ${region}` })
  }
  if (has('x-ms-request-id')) {
    azure.push({ weight: 2, primary: true, evidence: 'x-ms-request-id' })
  }
  const deployment = get('x-ms-deployment-name')
  if (deployment) {
    azure.push({ weight: 2, primary: true, evidence: `x-ms-deployment-name: ${deployment}` })
  }
  if (has('x-ms-rai-invoked')) {
    azure.push({ weight: 2, primary: true, evidence: 'x-ms-rai-invoked' })
  }
  const azureml = names.find(n => n.startsWith('azureml-'))
  if (azureml) {
    azure.push({ weight: 2, primary: true, evidence: azureml })
  }
  if (has('x-ms-client-request-id')) {
    azure.push({ weight: 1, evidence: 'x-ms-client-request-id' })
  }

  // ── OpenAI ─────────────────────────────────────────────────────────────
  const org = get('openai-organization')
  if (org) {
    openai.push({ weight: 3, primary: true, evidence: `openai-organization: ${org}` })
  }
  if (has('openai-project')) {
    openai.push({ weight: 2, primary: true, evidence: 'openai-project' })
  }
  const ver = get('openai-version')
  if (ver) {
    openai.push({ weight: 2, primary: true, evidence: `openai-version: ${ver}` })
  }
  if (has('openai-processing-ms')) {
    openai.push({ weight: 2, primary: true, evidence: 'openai-processing-ms' })
  }
  // OpenAI request ids look like req_9f2c…; Azure's are GUIDs. A gateway could
  // mint fake req_ ids, which is why this is not primary on its own.
  const reqId = get('x-request-id')
  if (reqId && /^req_[0-9a-zA-Z]{8,}$/.test(reqId)) {
    openai.push({ weight: 2, evidence: 'x-request-id: req_…' })
  }
  if (names.some(n => /^x-ratelimit-(limit|remaining|reset)-images$/.test(n))) {
    openai.push({ weight: 2, evidence: 'x-ratelimit-*-images' })
  }
  const cookies = h.get('set-cookie') ?? []
  const cloudflare = has('cf-ray') || has('cf-cache-status')
    || (get('server') ?? '').includes('cloudflare')
    || cookies.some(v => v.startsWith('__cf_bm') || v.startsWith('_cfuvid'))
  if (cloudflare) {
    openai.push({ weight: 1, evidence: 'Cloudflare 边缘特征' })
  }

  // ── Gateway / repackaged ───────────────────────────────────────────────
  const litellm = names.find(n => n.startsWith('x-litellm-'))
  if (litellm) {
    other.push({ weight: 3, primary: true, evidence: `${litellm}（LiteLLM 网关）` })
  }
  const oneapi = names.find(n => n.includes('oneapi') || n.includes('one-api'))
  if (oneapi) {
    other.push({ weight: 3, primary: true, evidence: `${oneapi}（one-api 系网关）` })
  }
  const xpb = get('x-powered-by')
  if (xpb) {
    other.push({ weight: 1, evidence: `x-powered-by: ${xpb}` })
  }
  const server = get('server')
  if (server && !server.includes('cloudflare')) {
    other.push({ weight: 1, evidence: `server: ${server}` })
  }
  const body = snap.body
  if (body && typeof body === 'object' && !Array.isArray(body) && 'model' in body) {
    other.push({ weight: 2, evidence: '响应体含 model 字段（官方响应无此字段）' })
  }

  // ── Decide ─────────────────────────────────────────────────────────────
  const azScore = sum(azure)
  const oaScore = sum(openai)
  let vendor: VendorKind
  if (hasPrimary(azure) && hasPrimary(openai)) {
    // Both stacks' own headers at once — a gateway splicing responses.
    vendor = azScore === oaScore ? 'other' : azScore > oaScore ? 'azure' : 'openai'
    if (azScore === oaScore) {
      other.unshift({ weight: 3, evidence: 'OpenAI 与 Azure 特征同时出现且势均力敌' })
    }
  } else if (hasPrimary(azure)) {
    vendor = 'azure'
  } else if (hasPrimary(openai)) {
    vendor = 'openai'
  } else if (oaScore >= 4) {
    // No openai-* header survived, but id format + images ratelimit + edge
    // features together still outweigh coincidence.
    vendor = 'openai'
  } else if (sum(other) >= 2) {
    vendor = 'other'
  } else {
    vendor = 'unknown'
  }

  // Winning signals first; the losing pools stay visible as context — an
  // "OpenAI" verdict alongside `server: openresty` says "OpenAI, via a proxy".
  let evidence: string[]
  if (vendor === 'azure') evidence = [...byWeight(azure), ...byWeight(other)].map(x => x.evidence)
  else if (vendor === 'openai') evidence = [...byWeight(openai), ...byWeight(other)].map(x => x.evidence)
  else if (vendor === 'other') evidence = [...byWeight(other), ...byWeight(openai), ...byWeight(azure)].map(x => x.evidence)
  else evidence = ['未见 openai-* / x-ms-* / 网关特征头（可能已被网关剥离）']

  return { vendor, label: VENDOR_LABEL[vendor], evidence: evidence.slice(0, 6) }
}

/** Roll per-request verdicts up into one line for the log and the report.
 *
 *  Every probe in a suite hits the same configured baseurl, so agreement is
 *  expected and a split is itself a finding — a gateway load-balancing across
 *  different upstreams mid-suite.
 */
export function aggregateVendor(verdicts: (VendorVerdict | null | undefined)[]): string {
  const done = verdicts.filter((v): v is VendorVerdict => !!v)
  if (!done.length) return '无原始响应可判定'

  const counts = new Map<VendorKind, VendorVerdict[]>()
  for (const v of done) {
    const list = counts.get(v.vendor)
    if (list) list.push(v)
    else counts.set(v.vendor, [v])
  }

  const decisive = (['openai', 'azure', 'other'] as VendorKind[])
    .filter(k => (counts.get(k)?.length ?? 0) > 0)
  const unknownCount = counts.get('unknown')?.length ?? 0

  if (!decisive.length) {
    return `无法判定（${done.length} 次请求均未见可辨识的上游特征）`
  }

  if (decisive.length === 1) {
    const kind = decisive[0]
    const hits = counts.get(kind)!
    // The signals that repeat across requests are the ones worth quoting.
    const freq = new Map<string, number>()
    for (const v of hits) for (const e of v.evidence) freq.set(e, (freq.get(e) ?? 0) + 1)
    const top = Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([e]) => e)
    const tail = unknownCount ? `，另有 ${unknownCount} 次无特征` : ''
    return `${VENDOR_LABEL[kind]}（${hits.length}/${done.length} 次命中：${top.join('、')}${tail}）`
  }

  const parts = decisive.map(k => `${VENDOR_LABEL[k]} ${counts.get(k)!.length} 次`)
  if (unknownCount) parts.push(`无法判定 ${unknownCount} 次`)
  return `⚠ 混合上游 — ${parts.join(' · ')}`
}
