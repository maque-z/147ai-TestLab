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
  model_id: string
  timeout: number
  updated_at?: string
}

/** Every param is optional: omitted means "let the API apply its own default",
 *  which is a distinct case from any value the user could pick. */
export interface GenerateRequest {
  prompt: string
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

export interface GeneratedImage {
  b64_json?: string
  url?: string
  revised_prompt?: string
  /** Real format sniffed from magic bytes, not the API's claimed output_format. */
  image_format?: string
  byte_size?: number
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
}

export interface TestLogEntry {
  id: number
  ts: string
  level: 'info' | 'ok' | 'warn' | 'error' | 'rule'
  text: string
}
