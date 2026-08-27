import type { UpstreamSnapshot } from '@/types'

/** Which ORIGIN ultimately produced this response.
 *
 *  The question is "最上游是谁", not "中间经过了什么" — a request is expected
 *  to pass through one or more relays, and relay traces (nginx, LiteLLM,
 *  one-api, an injected model field) say nothing about the origin. They are
 *  therefore collected as context only and never decide the verdict.
 *
 *  What decides: headers only the origin's own stack emits. `x-ms-region` /
 *  `apim-request-id` only come out of Azure; `openai-organization` /
 *  `openai-processing-ms` only out of OpenAI. A relay chain that strips them
 *  all leaves nothing to judge, and that is reported as `unknown` rather than
 *  guessed — the evidence list is shown next to every verdict so the reader
 *  can always overrule the heuristic.
 */
export type VendorKind = 'openai' | 'azure' | 'unknown'

export interface VendorVerdict {
  vendor: VendorKind
  label: string
  /** Matched signals, strongest first, capped for display. Relay traces come
   *  after the origin evidence, prefixed 中转, as background. */
  evidence: string[]
}

export const VENDOR_LABEL: Record<VendorKind, string> = {
  openai: 'OpenAI 官方',
  azure: 'Azure OpenAI',
  unknown: '无法判定',
}

/** One matched signal. `primary` marks headers only the origin's own stack
 *  emits; secondaries (Cloudflare, id formats) corroborate but never decide
 *  alone — plenty of unrelated services sit behind Cloudflare too. */
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
  /** Relay traces. Context for the reader, never part of the decision. */
  const relay: string[] = []

  // ── Azure origin ───────────────────────────────────────────────────────
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

  // ── OpenAI origin ──────────────────────────────────────────────────────
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
  // OpenAI request ids look like req_9f2c…; Azure's are GUIDs. A relay could
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

  // ── Relay traces (context only) ────────────────────────────────────────
  const litellm = names.find(n => n.startsWith('x-litellm-'))
  if (litellm) relay.push(`中转: ${litellm}（LiteLLM）`)
  const oneapi = names.find(n => n.includes('oneapi') || n.includes('one-api'))
  if (oneapi) relay.push(`中转: ${oneapi}（one-api 系）`)
  const xpb = get('x-powered-by')
  if (xpb) relay.push(`中转: x-powered-by: ${xpb}`)
  const server = get('server')
  if (server && !server.includes('cloudflare')) relay.push(`中转: server: ${server}`)
  const body = snap.body
  if (body && typeof body === 'object' && !Array.isArray(body) && 'model' in body) {
    relay.push('中转: 响应体含 model 字段（官方响应无此字段，经重新序列化）')
  }

  // ── Decide the origin ──────────────────────────────────────────────────
  const azScore = sum(azure)
  const oaScore = sum(openai)
  let vendor: VendorKind
  if (hasPrimary(azure) && hasPrimary(openai)) {
    // Both origins' own headers at once — take the stronger; a dead tie is
    // contradictory evidence, which is not a verdict.
    vendor = azScore === oaScore ? 'unknown' : azScore > oaScore ? 'azure' : 'openai'
  } else if (hasPrimary(azure)) {
    vendor = 'azure'
  } else if (hasPrimary(openai)) {
    vendor = 'openai'
  } else if (oaScore >= 4) {
    // No openai-* header survived the relays, but id format + images
    // ratelimit + edge features together still outweigh coincidence.
    vendor = 'openai'
  } else {
    vendor = 'unknown'
  }

  // Origin evidence first, relay traces after as background.
  let evidence: string[]
  if (vendor === 'azure') {
    evidence = [...byWeight(azure).map(x => x.evidence), ...relay]
  } else if (vendor === 'openai') {
    evidence = [...byWeight(openai).map(x => x.evidence), ...relay]
  } else if (hasPrimary(azure) && hasPrimary(openai)) {
    evidence = [
      '⚠ OpenAI 与 Azure 官方特征同时出现，相互矛盾',
      ...byWeight(openai).map(x => x.evidence),
      ...byWeight(azure).map(x => x.evidence),
      ...relay,
    ]
  } else {
    evidence = ['未见 OpenAI / Azure 官方特征头（可能已被中转剥离）', ...relay]
  }

  return { vendor, label: VENDOR_LABEL[vendor], evidence: evidence.slice(0, 6) }
}

/** Roll per-request verdicts up into one line for the log and the report.
 *
 *  Every probe in a suite hits the same configured baseurl, so agreement is
 *  expected and a split is itself a finding — a relay balancing across
 *  different origins mid-suite.
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

  const decisive = (['openai', 'azure'] as VendorKind[])
    .filter(k => (counts.get(k)?.length ?? 0) > 0)
  const unknownCount = counts.get('unknown')?.length ?? 0

  if (!decisive.length) {
    return `无法判定（${done.length} 次请求均未见 OpenAI / Azure 官方特征，可能已被中转剥离）`
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
  return `⚠ 混合来源 — ${parts.join(' · ')}`
}
