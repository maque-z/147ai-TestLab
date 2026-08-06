export interface User {
  id: number
  username: string
  created_at: string
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
}

export interface GeneratedImage {
  b64_json?: string
  url?: string
  revised_prompt?: string
  /** Real format sniffed from magic bytes, not the API's claimed output_format. */
  image_format?: string
  byte_size?: number
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
  /** The model the API says it used — reveals a gateway silently swapping models. */
  upstream_model?: string
  /** Response-level output_format claim, which can disagree with the magic bytes. */
  declared_format?: string
}

/** The param matrix the UI expands into one upstream request per combination.
 *  An empty array means the param is left unset, which contributes exactly one
 *  (default) row to the cross product rather than zero. */
export interface ParamMatrix {
  sizes: string[]
  qualities: string[]
  formats: string[]
  moderations: string[]
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
