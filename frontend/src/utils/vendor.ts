import type { ImageDataKind, UpstreamSnapshot, VendorKind, VendorVerdict } from '@/types'

export type { VendorKind, VendorVerdict }

/** Which ORIGIN ultimately produced this response.
 *
 *  The question is "最上游是谁", not "中间经过了什么" — a request is expected
 *  to pass through one or more relays, and relay traces (nginx, LiteLLM,
 *  one-api, an injected model field) say nothing about the origin. They are
 *  collected as context only and never decide the verdict.
 *
 *  Two kinds of evidence decide.
 *
 *  1. Headers only the origin's own stack emits. `x-ms-region` /
 *     `apim-request-id` only come out of Azure; `openai-organization` /
 *     `openai-processing-ms` only out of OpenAI.
 *
 *  2. The shape of the body, checked against the published reference. The
 *     OpenAI OpenAPI spec (github.com/openai/openai-openapi, schemas Image and
 *     ImagesResponse) pins the GPT image response down precisely:
 *       b64_json        "Returned by default for the GPT image models"
 *       url             "Unsupported for the GPT image models"
 *       revised_prompt  "For dall-e-3 only"
 *       top level       background / output_format / quality / size / usage,
 *                       usage being ImageGenUsage {input_tokens_details:
 *                       {text_tokens, image_tokens}}
 *     A gateway that does not proxy the Images API but rebuilds the response
 *     from somewhere else cannot match that shape exactly, and the mismatches
 *     say where it came from. The relays that matter here are the Codex /
 *     ChatGPT reverse-engineered ones: an OAuth ChatGPT account cannot call
 *     the Images API, so these bridges — codex-lb (openspec images-api-compat),
 *     CLIProxyAPI (codex_openai_images.go), sub2api (openai_images.go),
 *     AI-Zero-Token (image-service.ts, chatgpt-web-image.ts),
 *     opencode-image-generation — turn /v1/images/generations into a Responses
 *     API call carrying the image_generation tool, or drive chatgpt.com's own
 *     backend-api, and re-wrap what comes back. Fingerprints read off those
 *     sources:
 *       · data[].revised_prompt on a gpt-image model — image_generation_call
 *         carries one, and codex-lb's spec emits {created, data:[{b64_json,
 *         revised_prompt}], usage} verbatim
 *       · usage in ResponseUsage shape (input_tokens_details.cached_tokens,
 *         output_tokens_details.reasoning_tokens) instead of ImageGenUsage
 *       · size / quality echoed as "auto" — the tool passes them through; the
 *         Images API only ever returns concrete values
 *       · a model field reading gpt-image-*-codex — the tool's internal model
 *         name, surfaced through sub2api (issue #3302)
 *       · an image_generation_call item (type / result / id ig_…) or a whole
 *         Responses body (object: "response", output[]) forwarded as-is
 *       · links or asset pointers into ChatGPT's file store
 *         (oaiusercontent.com, chatgpt.com/backend-api/files, file-service://,
 *         sediment://), or image_gen_title — a ChatGPT conversation field —
 *         which is what the web path in AI-Zero-Token and sub2api scrapes
 *       · an n>1 refusal blaming the image_generation tool — codex-lb rejects
 *         n>1 with exactly that message
 *     Azure's body has one tell of its own, documented in the Azure OpenAI
 *     image REST reference and never emitted by OpenAI: content_filter_results
 *     / prompt_filter_results inside data[], and the contentFilter /
 *     ResponsibleAIPolicyViolation error codes.
 *
 *  A relay chain that strips every header and forwards an unmodified official
 *  body leaves nothing to judge, and that is reported as `unknown` rather than
 *  guessed — the evidence list is shown next to every verdict so the reader
 *  can always overrule the heuristic.
 */

export const VENDOR_LABEL: Record<VendorKind, string> = {
  openai: 'OpenAI 官方',
  azure: 'Azure OpenAI',
  reverse: 'Codex/ChatGPT 逆向',
  unknown: '无法判定',
}

/** Compact form for the card chip. */
export const VENDOR_SHORT: Record<VendorKind, string> = {
  openai: 'OpenAI',
  azure: 'Azure',
  reverse: '逆向',
  unknown: '未判定',
}

export const DATA_KIND_LABEL: Record<ImageDataKind | 'mixed', string> = {
  b64_json: 'b64_json',
  data_url: 'data:URL',
  url: 'url',
  none: '无图像数据',
  mixed: '混合',
}

/** What the caller knows about the request, for the body checks that depend
 *  on it: revised_prompt and url are legitimate on the DALL·E models, and a
 *  "revised" prompt identical to the one sent is a gateway filling the field. */
export interface VendorContext {
  model?: string
  prompt?: string
}

/** One matched signal. `primary` marks evidence that names an origin on its
 *  own; secondaries (Cloudflare, id formats, a missing field) corroborate but
 *  never decide alone — plenty of unrelated services sit behind Cloudflare too. */
interface Hit {
  weight: number
  primary?: boolean
  evidence: string
}

const sum = (hits: Hit[]) => hits.reduce((s, h) => s + h.weight, 0)
const hasPrimary = (hits: Hit[]) => hits.some(h => h.primary)
const byWeight = (hits: Hit[]) => [...hits].sort((a, b) => b.weight - a.weight)
const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

export function hostOf(url: string): string | null {
  try { return new URL(url).hostname } catch { return null }
}

/** ChatGPT's own file store and backend, as opposed to the Images API.
 *  oaiusercontent.com serves conversation attachments (files.oaiusercontent.com,
 *  sdmnt*.oaiusercontent.com); chatgpt.com/backend-api/files/… and
 *  …/conversation/…/attachment/…/download are what the web relays resolve
 *  before downloading. */
const CHATGPT_HOST = /(^|\.)(oaiusercontent\.com|chatgpt\.com)$/i
/** Asset pointers inside ChatGPT conversation JSON. */
const CHATGPT_POINTER = /\b(file-service|sediment):\/\//

interface BodyShape {
  azure: Hit[]
  reverse: Hit[]
  /** Non-decisive observations, for the evidence list of an `unknown` verdict. */
  notes: string[]
}

/** Read the body against the reference shapes described in the header comment. */
function inspectBody(snap: UpstreamSnapshot, ctx: VendorContext): BodyShape {
  const out: BodyShape = { azure: [], reverse: [], notes: [] }
  const body = snap.body
  if (!isRecord(body)) return out
  // The "GPT image models never return this" checks do not apply to DALL·E.
  const gptImage = !/dall-e/i.test(ctx.model ?? '')

  // A Responses API body handed over as-is — object: "response", output[].
  if (body.object === 'response' || Array.isArray(body.output)) {
    out.reverse.push({ weight: 3, primary: true,
      evidence: '响应体是 Responses API 原文（object/output），不是 Images API 响应' })
  }

  // ImageGenUsage is {total, input, output, input_tokens_details{text_tokens,
  // image_tokens}}. cached_tokens / reasoning_tokens exist only in the Responses
  // API's ResponseUsage — a bridge that copied usage across from that call.
  const usage = isRecord(body.usage) ? body.usage : null
  if (usage) {
    const inD = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : null
    const outD = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : null
    if ((inD && ('cached_tokens' in inD || 'cache_write_tokens' in inD))
        || (outD && 'reasoning_tokens' in outD)) {
      out.reverse.push({ weight: 3, primary: true,
        evidence: 'usage 为 Responses API 形态（cached_tokens/reasoning_tokens），非 ImageGenUsage' })
    }
  }

  // The official response has no model field at all. A gateway adding one is a
  // relay trace (the caller records it); one reading gpt-image-*-codex has
  // copied the image_generation tool's own model name (sub2api #3302).
  if (typeof body.model === 'string' && /codex/i.test(body.model)) {
    out.reverse.push({ weight: 3, primary: true,
      evidence: `model: ${body.model}（Codex image_generation 工具的内部模型名）` })
  }

  // ImagesResponse.size / quality are enums of concrete values; the tool
  // echoes whatever it was asked for, "auto" included.
  for (const k of ['size', 'quality'] as const) {
    if (body[k] === 'auto') {
      out.reverse.push({ weight: 2, primary: true,
        evidence: `${k}: auto（官方只返回具体值，Codex 工具透传 auto）` })
    }
  }

  const err = isRecord(body.error) ? body.error : null
  if (err) {
    const msg = typeof err.message === 'string' ? err.message : ''
    // codex-lb refuses n>1 with a message blaming the image_generation tool;
    // the Images API never mentions a tool.
    if (/image_generation|codex/i.test(msg)) {
      out.reverse.push({ weight: 3, primary: true,
        evidence: '错误信息提及 image_generation/codex（Responses 工具桥接的拒绝语）' })
    }
    // Azure's dalleErrorResponse: error.code contentFilter, or inner_error
    // {code: ResponsibleAIPolicyViolation, content_filter_results}.
    const inner = isRecord(err.inner_error) ? err.inner_error : null
    if (err.code === 'contentFilter' || inner?.code === 'ResponsibleAIPolicyViolation'
        || (inner && 'content_filter_results' in inner)) {
      out.azure.push({ weight: 2, primary: true,
        evidence: `error.code: ${String(err.code ?? inner?.code)}（Azure 内容过滤错误码）` })
    }
  }

  const items = Array.isArray(body.data) ? body.data.filter(isRecord) : null
  if (!items) return out

  let revised = 0, echoed = 0, dataUrls = 0, leaked = 0, filtered = 0, pointers = 0, titles = 0
  const links: string[] = []
  for (const it of items) {
    if (typeof it.revised_prompt === 'string' && it.revised_prompt) {
      revised++
      if (ctx.prompt && it.revised_prompt.trim() === ctx.prompt.trim()) echoed++
    }
    if (typeof it.url === 'string' && it.url) {
      if (it.url.startsWith('data:')) dataUrls++
      else links.push(it.url)
    }
    if (typeof it.b64_json === 'string' && it.b64_json.startsWith('data:')) dataUrls++
    if (it.type === 'image_generation_call' || 'result' in it
        || (typeof it.id === 'string' && it.id.startsWith('ig_'))) leaked++
    if ('content_filter_results' in it || 'prompt_filter_results' in it) filtered++
    if ('image_gen_title' in it) titles++
    if (Object.values(it).some(v => typeof v === 'string' && CHATGPT_POINTER.test(v))) pointers++
  }

  if (filtered) {
    out.azure.push({ weight: 3, primary: true,
      evidence: 'data[] 含 content_filter_results/prompt_filter_results（Azure 内容过滤标注）' })
  }
  if (leaked) {
    out.reverse.push({ weight: 3, primary: true,
      evidence: 'data[] 是 image_generation_call 原样项（type/result/ig_ id）' })
  }
  if (titles) {
    out.reverse.push({ weight: 3, primary: true,
      evidence: 'data[] 含 image_gen_title（ChatGPT 会话字段）' })
  }
  if (pointers) {
    out.reverse.push({ weight: 3, primary: true,
      evidence: '含 file-service:// 或 sediment:// 资源指针（ChatGPT 网页文件系统）' })
  }

  const chatgptLinks = links.filter(u => CHATGPT_HOST.test(hostOf(u) ?? ''))
  if (chatgptLinks.length) {
    out.reverse.push({ weight: 3, primary: true,
      evidence: `图片链接指向 ${hostOf(chatgptLinks[0])}（ChatGPT 网页文件存储）` })
  } else if (links.length && gptImage) {
    out.reverse.push({ weight: 2,
      evidence: `以 url 返回（${hostOf(links[0]) ?? '?'}）— 官方规范：GPT image 模型不支持 url` })
  }
  if (dataUrls && gptImage) {
    out.reverse.push({ weight: 1, evidence: '图片以 data:URL 序列化（官方为裸 base64）' })
  }
  if (revised && gptImage) {
    out.reverse.push({ weight: 2,
      evidence: 'data[].revised_prompt — 官方规范仅 dall-e-3 返回；image_generation_call 携带此字段' })
    if (echoed) {
      out.reverse.push({ weight: 1, evidence: 'revised_prompt 与原 prompt 完全相同（网关填充）' })
    }
  }

  // "Field X is missing" only means something on a successful Images response,
  // and only for the models whose response is specified to carry it.
  if (snap.status < 400 && gptImage) {
    if (!usage) {
      out.reverse.push({ weight: 1, evidence: '缺少 usage（官方 GPT image 响应必带）' })
    }
    const missing = ['output_format', 'quality', 'size'].filter(k => !(k in body))
    if (missing.length) {
      out.reverse.push({ weight: 1,
        evidence: `缺少顶层 ${missing.join('/')}（官方 ImagesResponse 携带）` })
    }
    if (!out.reverse.length && !out.azure.length) {
      out.notes.push('响应体形态符合官方 ImagesResponse，未见逆向特征')
    }
  }
  return out
}

export function detectVendor(snap: UpstreamSnapshot, ctx: VendorContext = {}): VendorVerdict {
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
  if (isRecord(snap.body) && 'model' in snap.body) {
    relay.push('中转: 响应体含 model 字段（官方响应无此字段，经重新序列化）')
  }

  // ── Body shape ─────────────────────────────────────────────────────────
  const shape = inspectBody(snap, ctx)
  azure.push(...shape.azure)
  const reverse = shape.reverse

  // ── Decide the origin ──────────────────────────────────────────────────
  const azScore = sum(azure)
  const oaScore = sum(openai)
  const rvScore = sum(reverse)
  let vendor: VendorKind
  if (hasPrimary(azure) && hasPrimary(openai)) {
    // Both origins' own headers at once — take the stronger; a dead tie is
    // contradictory evidence, which is not a verdict.
    vendor = azScore === oaScore ? 'unknown' : azScore > oaScore ? 'azure' : 'openai'
  } else if (hasPrimary(azure)) {
    vendor = 'azure'
  } else if (hasPrimary(openai)) {
    // Origin headers name the origin. A Responses-shaped body alongside them
    // is an API-key bridge through api.openai.com — still OpenAI — but a lone
    // openai-processing-ms against a body full of Codex tells is the
    // chatgpt.com backend's own headers passed through by the relay.
    vendor = hasPrimary(reverse) && rvScore > oaScore ? 'reverse' : 'openai'
  } else if (hasPrimary(reverse) || rvScore >= 4) {
    vendor = 'reverse'
  } else if (oaScore >= 4) {
    // No openai-* header survived the relays, but id format + images
    // ratelimit + edge features together still outweigh coincidence.
    vendor = 'openai'
  } else {
    vendor = 'unknown'
  }

  // Origin evidence first, then body-shape context, then relay traces.
  const shapeCtx = byWeight(reverse).map(x => `形态: ${x.evidence}`)
  let evidence: string[]
  switch (vendor) {
    case 'azure':
      evidence = [...byWeight(azure).map(x => x.evidence), ...shapeCtx, ...relay]
      break
    case 'openai':
      evidence = [...byWeight(openai).map(x => x.evidence), ...shapeCtx, ...relay]
      break
    case 'reverse':
      evidence = [
        ...byWeight(reverse).map(x => x.evidence),
        ...byWeight(openai).map(x => `头: ${x.evidence}`),
        ...relay,
      ]
      break
    default:
      evidence = hasPrimary(azure) && hasPrimary(openai)
        ? [
            '⚠ OpenAI 与 Azure 官方特征同时出现，相互矛盾',
            ...byWeight(openai).map(x => x.evidence),
            ...byWeight(azure).map(x => x.evidence),
            ...relay,
          ]
        : [
            '未见 OpenAI / Azure 官方特征头（可能已被中转剥离）',
            ...shapeCtx,
            ...shape.notes,
            ...relay,
          ]
  }

  return { vendor, label: VENDOR_LABEL[vendor], evidence: evidence.slice(0, 8) }
}

/** One word for how the bytes arrived, with the host when it was a link:
 *  "b64_json", "data:URL", "url→files.oaiusercontent.com（下载失败 HTTP 403）". */
export function describeDataKind(
  r: { dataKind?: ImageDataKind | 'mixed'; sourceUrl?: string; fetchError?: string },
): string {
  const base = DATA_KIND_LABEL[r.dataKind ?? 'none']
  if (r.dataKind !== 'url') return base
  const host = r.sourceUrl ? hostOf(r.sourceUrl) ?? '?' : '?'
  return `url→${host}${r.fetchError ? `（${r.fetchError}）` : ''}`
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

  const decisive = (['openai', 'azure', 'reverse'] as VendorKind[])
    .filter(k => (counts.get(k)?.length ?? 0) > 0)
  const unknownCount = counts.get('unknown')?.length ?? 0

  if (!decisive.length) {
    return `无法判定（${done.length} 次请求均未见 OpenAI / Azure 官方特征头，响应体也无逆向特征，可能已被中转剥离）`
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
