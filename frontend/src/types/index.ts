// Gemini image surfaces live in their own file — different request and response
// shapes entirely — but re-exported so `@/types` stays the single import path.
export * from './banana'

export interface User {
  id: number
  username: string
  created_at: string
  is_admin: boolean
  is_active: boolean
}

export interface TokenResponse {
  access_token: string
  token_type: string
  user: User
}

export interface LoginRequest {
  username: string
  password: string
}

export interface ImageConfig {
  id?: number
  user_id?: number
  baseurl: string
  api_key: string
  /** Legacy single model. Empty on accounts created after the model moved into
   *  the parameter panel; the backend seeds selected_models from it once. */
  model_id: string
  /** The models ticked in the parameter panel, saved per account. */
  selected_models: string[]
  /** Model ids the user added by hand, saved per account. */
  custom_models: string[]
  timeout: number
  updated_at?: string
}

/** One chip in the panel's model list: a documented model with its doc note, or
 *  a hand-added id — the only kind that can be removed. */
export interface ModelOption {
  id: string
  note: string
  custom: boolean
}

/** Every param is optional: omitted means "let the API apply its own default",
 *  which is a distinct case from any value the user could pick. */
export interface GenerateRequest {
  prompt: string
  /** The model for this request — the one param with no "let the API decide":
   *  a request without one falls back to a model that no longer exists. The
   *  backend substitutes the account's saved selection when absent. */
  model_id?: string
  size?: string
  quality?: string
  n?: number
  output_format?: string
  output_compression?: number
  moderation?: string
  /** transparent / opaque / auto, default auto. The docs pair transparent with
   *  png or webp and state jpeg cannot carry it; the jpeg combination is still
   *  sent, on purpose. */
  background?: string
  /** Edits endpoint only. high / low, default low. Documented for "gpt-image-1
   *  and gpt-image-1.5 and later models" without naming gpt-image-2 — so
   *  whether it applies here is exactly what sending it answers. */
  input_fidelity?: string
}

/** How the upstream delivered one image's bytes — see GeneratedImage.data_kind.
 *  The reference fixes GPT image models to b64_json, so anything else here is
 *  a finding about the gateway rather than about the model. */
export type ImageDataKind = 'b64_json' | 'data_url' | 'url' | 'none'

export interface GeneratedImage {
  b64_json?: string
  /** Only when the upstream returned an http(s) link; a data: URL is unpacked
   *  into b64_json by the backend instead of arriving twice. */
  url?: string
  revised_prompt?: string
  /** Real format sniffed from magic bytes, not the API's claimed output_format.
   *  Absent when there were no bytes to sniff — never backfilled from the claim. */
  image_format?: string
  byte_size?: number
  /** b64_json (documented) / data_url / url (downloaded server-side) / none. */
  data_kind?: ImageDataKind
  /** The wire field that carried it: b64_json, url, or result — the last being
   *  a Responses API image_generation_call forwarded unconverted. */
  data_field?: string
  /** The link exactly as returned, when data_kind is url. */
  source_url?: string
  /** Why the link could not be downloaded, when it could not. */
  fetch_error?: string
  /** Content Credentials read off the bytes. See C2paProvenance. */
  c2pa?: C2paProvenance
}

/** How a C2PA manifest held up. `trusted` and `valid` are different claims:
 *  both mean the signature verifies, but only `trusted` means the signing
 *  certificate chains to an anchor in the bundled trust snapshot. `not_present`
 *  says nothing about the image — re-encoding strips a manifest — and
 *  `unsupported_format` means the container cannot carry one at all. */
export type C2paStatus =
  | 'trusted' | 'valid' | 'invalid' | 'not_present' | 'unreadable' | 'unsupported_format'

/** One certificate in the signing chain, leaf first. */
export interface C2paCert {
  subject: string
  issuer: string
  not_before: string
  not_after: string
  self_signed: boolean
}

/** What the c2pa.hash.data assertion said. This is the assertion that ties the
 *  image's bytes to the claim, so it is the difference between "the signature
 *  is valid" and "this image is the one that was signed". */
export interface C2paFileHash {
  present: boolean
  algorithm?: string
  exclusions: { start?: number; length?: number }[]
  /** Do the exclusions cover exactly the manifest's own bytes? */
  matches_carrier?: boolean
  /** Does SHA-256 of the file match what the generator recorded? */
  matches_file?: boolean
  detail: string
}

/** One manifest read off one image. The fields are the reader's own
 *  (backend/app/core/c2pa.py) rather than a mirrored model, so they stay in
 *  step with what it actually measures. */
export interface C2paProvenance {
  status: C2paStatus
  status_label: string
  /** How the manifest was carried: png.caBX / jpeg.APP11 / webp.C2PA. */
  carrier?: string
  /** Whether a manifest was found at all. */
  present: boolean
  /** claim_generator_info[0].name — "Azure OpenAI ImageGen" or
   *  "OpenAI Media Service API" for the two origins this tool distinguishes. */
  generator?: string
  generator_version?: string
  claim_format?: string
  title?: string
  actions: { action?: string; when?: string; software_agent?: string; digital_source_type?: string }[]
  software_agent?: string
  digital_source_type?: string
  /** The signing certificate's subject and organization. */
  subject?: string
  subject_org?: string
  issuer?: string
  chain: C2paCert[]
  /** Whether the chain reaches an anchor in the bundled trust snapshot. */
  anchored: boolean
  anchor_subject?: string
  anchor_source?: string
  algorithm?: string
  /** Did the COSE signature verify against the leaf certificate? */
  signature_ok?: boolean
  signed_at?: string
  timestamped: boolean
  hash_data?: C2paFileHash
  /** A second, non-cryptographic signal: Microsoft's invisible watermark. */
  watermark?: string
  /** Which origin the manifest names, judged from the generator string first
   *  and the certificate subject when the two disagree. */
  vendor?: 'openai' | 'azure'
  vendor_label?: string
  /** Why that verdict, strongest first — the same list the card tooltip shows. */
  evidence: string[]
  problems: string[]
  /** Which trust-anchor snapshot the anchoring was judged against. */
  anchor_set: string
}

/** Who ultimately produced a response. `reverse` is a Codex / ChatGPT-web
 *  reverse-engineered relay re-wrapping something that was never an Images API
 *  call; utils/vendor.ts holds the fingerprints and where each one comes from. */
export type VendorKind = 'openai' | 'azure' | 'reverse' | 'unknown'

export interface VendorVerdict {
  vendor: VendorKind
  label: string
  /** Matched signals, strongest first: origin evidence, then body-shape
   *  context prefixed 形态, then relay traces prefixed 中转. */
  evidence: string[]
}

/** The raw upstream HTTP exchange behind one card, for the observation modal.
 *
 *  Headers are ordered [name, value] pairs straight off the wire — a record
 *  would collapse duplicates and lose arrival order. `body` is the parsed JSON
 *  with base64 image payloads replaced server-side by short stubs (the image
 *  itself already travels in images[].b64_json); everything else is complete.
 *  `body_text` carries a body that failed to parse as JSON instead. */
export interface UpstreamSnapshot {
  status: number
  reason?: string
  http_version?: string
  headers: [string, string][]
  body?: unknown
  body_text?: string
}

export interface GenerateResponse {
  images: GeneratedImage[]
  model: string
  prompt: string
  elapsed_ms: number
  request_id?: string
  input_tokens?: number
  /** How input_tokens split between the prompt text and any reference images. */
  input_text_tokens?: number
  input_image_tokens?: number
  output_tokens?: number
  /** What was actually sent upstream; undefined where the param was left unset. */
  size?: string
  quality?: string
  background?: string
  /** The model the API says it used — reveals a gateway silently swapping models. */
  upstream_model?: string
  /** Response-level output_format claim, which can disagree with the magic bytes. */
  declared_format?: string
  /** Response-level background claim, documented as a top-level field. */
  declared_background?: string
  /** The raw exchange this response was parsed from, base64 stubbed. */
  upstream?: UpstreamSnapshot
}

/** The param matrix the UI expands into one upstream request per combination.
 *  An empty array means the param is left unset, which contributes exactly one
 *  (default) row to the cross product rather than zero. */
export interface ParamMatrix {
  /** Never empty: the model is required, so this group cannot mean "unset".
   *  Each entry is one request per combination — the batch's model comparison. */
  models: string[]
  sizes: string[]
  qualities: string[]
  formats: string[]
  moderations: string[]
  backgrounds: string[]
  /** Expanded on the edit endpoint only — /generate does not take this param, so
   *  including it there would send a field the endpoint drops in silence. */
  inputFidelities: string[]
  n: number
  output_compression: number | null
  concurrency: number
}

/** Which endpoint a batch targets. Edits additionally carry reference images
 *  and an optional mask, and go out as multipart instead of JSON. */
export type GenMode = 'generate' | 'edit'

/** One uploaded reference image, held with a preview URL and its real decoded
 *  dimensions — the mask has to match the first one exactly. */
export interface RefImage {
  id: number
  file: File
  name: string
  /** Object URL for the thumbnail; revoked when the entry is removed. */
  url: string
  bytes: number
  width?: number
  height?: number
}

export type JobStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled'

/** One image inside a job. A request with n>1 returns several of these, and they
 *  all live on the same card so the count is visible at a glance. */
export interface JobImage {
  src?: string
  bytes?: number
  /** Format sniffed from magic bytes by the backend — the authoritative one. */
  actualFormat?: string
  revisedPrompt?: string
  // measured in the browser once the <img> decodes
  width?: number
  height?: number
  /** Whether the decoded pixels actually carry transparency, sampled in the
   *  browser. The only way to catch an API that accepts background=transparent
   *  and returns an opaque image anyway. undefined == not sampled. */
  hasAlpha?: boolean
}

/** One card in the results grid.
 *
 *  Requested and actual values are kept in separate fields rather than one being
 *  overwritten by the other — the whole point of the card is to show where the API
 *  did something different from what was asked.
 */
export interface ImageJob {
  id: number
  status: JobStatus
  /** Which endpoint produced this card. */
  mode: GenMode

  // ---- requested (from the param matrix); undefined == left to the API ----
  size?: string
  quality?: string
  format?: string
  moderation?: string
  background?: string
  /** Edit mode only. */
  inputFidelity?: string
  n: number
  compression?: number
  model: string
  /** Edit mode only: how many reference images went up, and whether a mask did. */
  refCount?: number
  hasMask?: boolean

  // ---- actual (measured or reported) ----
  /** Every image this one request returned. Length vs `n` is how you tell
   *  whether the API honoured the requested count. */
  images: JobImage[]
  /** Which image the card's carousel is currently showing. */
  activeIndex: number
  /** Format the API claimed in its response body. */
  declaredFormat?: string
  /** Background the API claimed, when it claims one at all. */
  declaredBackground?: string
  /** Model the API reported using, when it reports one. */
  actualModel?: string

  elapsedMs?: number
  /** Wall-clock ms when the request came back — distinct from elapsedMs, which
   *  is how long it took. Stamped client-side so it is in the user's own clock. */
  finishedAt?: number
  inputTokens?: number
  inputTextTokens?: number
  inputImageTokens?: number
  outputTokens?: number
  requestId?: string
  error?: string
}

export interface ApiError {
  detail: string
}

// ===== API compatibility test =====

/** Which param a probe is isolating. One factor at a time: every other param is
 *  left unset, so a mismatch can only be attributed to this one. */
export type TestDimension =
  | 'size' | 'quality' | 'format' | 'compression' | 'n' | 'edit' | 'background'

/** One upstream request in the suite. `req` carries only the param under test. */
export interface TestCase {
  id: string
  label: string
  dimension: TestDimension
  req: Omit<GenerateRequest, 'prompt'>
  /** Goes to /edit with the seed reference image instead of /generate. */
  isEdit?: boolean
  /** This combination cannot work as specified (transparent alpha into a jpeg),
   *  so there is no right answer to score — the probe exists to record what the
   *  API does with it. Reported as `info`, never as pass/fail. */
  expectRefusal?: boolean
}

/** pass/fail is a claim about the API, so it is only used where the response can
 *  actually settle the question. `info` covers probes that record a value without
 *  a right answer (the default-value probe), and `ratelimit` keeps a 429 from
 *  being misread as "the param does not work". */
export type TestVerdict = 'pass' | 'fail' | 'info' | 'ratelimit'

export interface TestResult {
  /** `${model}|${case.id}` — unique across a run that repeats every case per model. */
  key: string
  /** The model this probe was sent to. */
  model: string
  case: TestCase
  status: JobStatus
  verdict?: TestVerdict
  /** One-line 请求 → 实际 for this probe, shown on the card and in the log. */
  detail?: string
  src?: string
  bytes?: number
  /** Format from magic bytes — the authoritative one, not the API's claim. */
  actualFormat?: string
  declaredFormat?: string
  /** How many images the response carried. Only `src` (the first) is rendered,
   *  so this is what makes a request that returned 2 distinguishable from 1. */
  imageCount?: number
  /** Measured in the browser after decode, not taken from the request. */
  width?: number
  height?: number
  /** Sampled from the decoded pixels — settles whether background=transparent
   *  actually produced transparency. */
  hasAlpha?: boolean
  elapsedMs?: number
  inputTokens?: number
  outputTokens?: number
  actualModel?: string
  error?: string
  /** Raw response headers + body (base64 stubbed), viewable from the card.
   *  Present for successes and for failures that got an HTTP response —
   *  the refusal probes are only readable through this. */
  upstream?: UpstreamSnapshot
  /** How the bytes arrived. The reference fixes GPT image models to b64_json,
   *  so url / data_url here is a gateway finding; `mixed` when a multi-image
   *  response disagreed with itself. */
  dataKind?: ImageDataKind | 'mixed'
  /** Wire field that carried the first image (b64_json / url / result). */
  dataField?: string
  /** The link as returned, when dataKind is url. */
  sourceUrl?: string
  /** Why the backend could not download that link, when it could not. */
  fetchError?: string
  /** Origin verdict for this exchange, judged once when the result landed so
   *  the card chip, the raw-response modal and the report quote the same
   *  evidence. */
  vendor?: VendorVerdict
  /** Content Credentials read off the returned image. This is the strongest
   *  evidence there is and it outranks the header/body heuristics above: a
   *  verifying signature names Microsoft or OpenAI in a way a relay cannot
   *  forge. Kept alongside `vendor` rather than replacing it, so a disagreement
   *  between the two is visible instead of silently resolved. */
  c2pa?: C2paProvenance
}

export interface TestLogEntry {
  id: number
  ts: string
  level: 'info' | 'ok' | 'warn' | 'error' | 'rule'
  text: string
}
