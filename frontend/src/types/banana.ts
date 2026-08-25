/** Types for the two documented Gemini image-generation surfaces.
 *
 *  native — POST {base}/v1beta/models/{model}:generateContent
 *  openai — POST {base}/v1/chat/completions  with modalities ["text","image"]
 */

export interface BananaConfig {
  id?: number
  user_id?: number
  baseurl: string
  api_key: string
  model_id: string
  custom_models: string[]
  timeout: number
  updated_at?: string
}

/** Which surface a batch targets. Two separate endpoints, two separate job
 *  pools, one shared results grid — same arrangement as generate/edit. */
export type BananaMode = 'native' | 'openai'
export type BananaOperation = 'generate' | 'edit'

export type BananaSafetyThreshold =
  | 'HARM_BLOCK_THRESHOLD_UNSPECIFIED'
  | 'BLOCK_LOW_AND_ABOVE'
  | 'BLOCK_MEDIUM_AND_ABOVE'
  | 'BLOCK_ONLY_HIGH'
  | 'BLOCK_NONE'
  | 'OFF'

export interface BananaSafetySetting {
  category: string
  threshold: BananaSafetyThreshold
}

export interface BananaReferenceImage {
  mime_type: string
  data: string
}

/** Every param optional: omitted means "let the API apply its own default",
 *  which is a distinct case from any value the user could pick. */
export interface BananaGenerateRequest {
  prompt: string
  model_id?: string
  response_modalities?: string[]
  aspect_ratio?: string
  image_size?: string
  temperature?: number
  candidate_count?: number
  max_output_tokens?: number
  stop_sequences?: string[]
  top_p?: number
  top_k?: number
  seed?: number
  safety_settings?: BananaSafetySetting[]
  thinking_level?: string
  include_thoughts?: boolean
  thinking_budget?: number
  reference_images?: BananaReferenceImage[]
  /** Internal probe input; backend sends it as a final inlineData part. */
  mask_image?: BananaReferenceImage
}

export interface BananaChatRequest {
  prompt: string
  model_id?: string
  modalities?: string[]
  temperature?: number
}

export interface BananaImage {
  b64_json?: string
  url?: string
  /** inlineData.mimeType as claimed by the upstream. */
  declared_mime?: string
  /** Format sniffed from magic bytes — authoritative when the two disagree. */
  image_format?: string
  byte_size?: number
  /** Read from the file header server-side, so the documented pixel size is
   *  checkable without waiting for a browser decode. */
  width?: number
  height?: number
  candidate_index?: number
  /** Whether the returned PNG container declares an alpha channel. */
  has_alpha_channel?: boolean
}

export interface BananaGenerateResponse {
  images: BananaImage[]
  /** Text parts. Text with no image is the documented symptom of
   *  responseModalities missing "IMAGE". */
  texts: string[]
  model: string
  prompt: string
  elapsed_ms: number
  request_id?: string
  aspect_ratio?: string
  image_size?: string
  /** STOP is normal; SAFETY / IMAGE_SAFETY / PROHIBITED_CONTENT / OTHER /
   *  MAX_TOKENS are the documented refusals. */
  finish_reasons: string[]
  candidate_count?: number
  prompt_tokens?: number
  candidates_tokens?: number
  total_tokens?: number
  /** modelVersion — reveals a gateway silently swapping models. */
  upstream_model?: string
  /** Set when a 200 came back carrying no image at all. */
  block_reason?: string
}

/** The matrix the UI expands into one upstream request per combination.
 *  An empty array means the param is left unset, which contributes exactly one
 *  (default) row to the cross product rather than zero. */
export interface BananaMatrix {
  models: string[]
  /** Exact `imageSize|aspectRatio` cells selected in the documented size table. */
  sizePairs: string[]
  /** Each entry is one responseModalities array, joined by "," for identity. */
  modalities: string[]
  temperature: number | null
  candidateCount: number | null
  safetySettings: Record<string, BananaSafetyThreshold | null>
  maxOutputTokens: number | null
  stopSequences: string[]
  topP: number | null
  topK: number | null
  seed: number | null
  thinkingLevel: string | null
  includeThoughts: boolean
  thinkingBudget: number | null
  concurrency: number
}

/** One image inside a job. */
export interface BananaJobImage {
  src?: string
  bytes?: number
  actualFormat?: string
  declaredMime?: string
  /** Server-side header read; the browser fills these in if it could not parse. */
  width?: number
  height?: number
  /** Whether decoded pixels contain any transparent samples. */
  hasAlpha?: boolean
  /** Server-side container-level alpha declaration. */
  hasAlphaChannel?: boolean
}

/** One card in the results grid.
 *
 *  Requested and actual values are kept in separate fields rather than one being
 *  overwritten by the other — the point of the card is to show where the API did
 *  something different from what the documentation says it would.
 */
export interface BananaJob {
  id: number
  status: 'pending' | 'running' | 'done' | 'error' | 'cancelled'
  mode: BananaMode
  operation: BananaOperation

  // ---- requested; undefined == left to the API ----
  model: string
  aspectRatio?: string
  imageSize?: string
  modalities?: string
  temperature?: number
  candidateCount?: number
  safetySettings?: Record<string, BananaSafetyThreshold | null>
  maxOutputTokens?: number
  stopSequences?: string[]
  topP?: number
  topK?: number
  seed?: number
  thinkingLevel?: string
  includeThoughts?: boolean
  thinkingBudget?: number
  refCount?: number
  hasMask?: boolean

  // ---- actual (measured or reported) ----
  images: BananaJobImage[]
  activeIndex: number
  texts?: string[]
  finishReasons?: string[]
  actualCandidates?: number
  actualModel?: string
  blockReason?: string

  elapsedMs?: number
  finishedAt?: number
  promptTokens?: number
  candidatesTokens?: number
  totalTokens?: number
  requestId?: string
  error?: string
}

export type BananaTestDimension =
  | 'size' | 'model' | 'modalities' | 'candidate' | 'edit' | 'mask' | 'probe'
  | 'sampling' | 'tokens' | 'thinking' | 'safety'

export interface BananaTestCase {
  id: string
  label: string
  dimension: BananaTestDimension
  req: Omit<BananaGenerateRequest, 'prompt' | 'reference_images' | 'mask_image'>
  isEdit?: boolean
  usesMask?: boolean
  expectedPixels?: string
  expectedImages?: number
  expectNoImage?: boolean
  informational?: boolean
}

export type BananaTestVerdict = 'pass' | 'fail' | 'info' | 'ratelimit'

export interface BananaTestResult {
  case: BananaTestCase
  status: 'pending' | 'running' | 'done' | 'error' | 'cancelled'
  verdict?: BananaTestVerdict
  detail?: string
  src?: string
  width?: number
  height?: number
  imageCount?: number
  candidateCount?: number
  actualModel?: string
  requestId?: string
  elapsedMs?: number
  error?: string
}

export interface BananaTestLogEntry {
  id: number
  ts: string
  level: 'info' | 'ok' | 'warn' | 'error' | 'rule'
  text: string
}
