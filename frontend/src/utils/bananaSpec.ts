/** The documented behaviour of the Gemini image models, encoded so the UI can
 *  state what the docs promise and the cards can flag where reality differs.
 *
 *  Every table here is transcribed from the platform's own API documentation for
 *  `/v1beta/models/{model}:generateContent`. Nothing is inferred: where the docs
 *  give no figure, the helpers below return null and the UI says "文档未列出"
 *  rather than inventing an expectation to check against.
 */

/** Models the native surface documents, with the traits the doc's model table
 *  states for each. */
export const NATIVE_MODELS = [
  { id: 'gemini-3.1-flash-image',          note: '官方 · Nano Banana 2 · 512/1K/2K/4K' },
  { id: 'gemini-3-pro-image',              note: '官方 · Nano Banana Pro · 1K/2K/4K' },
  { id: 'gemini-3.1-flash-lite-image',     note: '更快更省 · 仅 1K · 比例最多' },
  { id: 'gemini-2.5-flash-image',          note: 'Flash 系列' },
  { id: 'gemini-3.1-flash-image-preview',  note: '网关兼容别名 · 旧 preview 名称' },
  { id: 'gemini-3-pro-image-preview',      note: '网关兼容别名 · 旧 preview 名称' },
  { id: 'gemini-2.5-flash-image-preview',  note: '网关兼容别名 · 旧 preview 名称' },
] as const

/** The OpenAI-compatible doc names exactly one model for image output. */
export const OPENAI_MODELS = [
  { id: 'gemini-2.0-flash-preview-image-generation', note: '实验模型 · 需 modalities' },
] as const

/** imageSize values, and which models the doc says accept each one.
 *
 *  Case matters: the doc states a lowercase "2k" is ignored outright. It is
 *  offered as a probe because that is a falsifiable claim worth checking, not
 *  because anyone would want to send it.
 */
export const IMAGE_SIZES = [
  { value: '512', models: ['gemini-3.1-flash-image', 'gemini-3.1-flash-image-preview'] },
  { value: '1K',  models: '*' },
  { value: '2K',  models: ['gemini-3.1-flash-image', 'gemini-3-pro-image', 'gemini-3.1-flash-image-preview', 'gemini-3-pro-image-preview'] },
  { value: '4K',  models: ['gemini-3.1-flash-image', 'gemini-3-pro-image', 'gemini-3.1-flash-image-preview', 'gemini-3-pro-image-preview'] },
  { value: '2k',  models: [], probe: '文档称小写会被忽略；2026-08 实测 api.147ai.cn 仍按 2K 执行' },
] as const

/** Ratios every model supports, then the four the doc restricts to Flash 2 (3.1). */
export const COMMON_RATIOS = [
  '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9',
] as const

export const FLASH2_ONLY_RATIOS = ['1:4', '4:1', '1:8', '8:1'] as const

export const ALL_RATIOS = [...COMMON_RATIOS, ...FLASH2_ONLY_RATIOS]

/** The 3.1 models, which the doc's ratio table calls "Flash 2（3.1）". */
const FLASH2_MODELS = [
  'gemini-3.1-flash-image',
  'gemini-3.1-flash-lite-image',
  'gemini-3.1-flash-image-preview',
]

/** responseModalities combinations worth sending. The doc requires "IMAGE" and
 *  recommends pairing it with "TEXT"; omitting the field entirely is the third
 *  case, and is what the doc says produces text only. */
export const MODALITY_SETS = [
  { value: 'TEXT,IMAGE', label: 'TEXT + IMAGE', note: '文档推荐' },
  { value: 'IMAGE',      label: 'IMAGE',        note: '仅图像' },
] as const

export const SAFETY_THRESHOLDS = [
  'HARM_BLOCK_THRESHOLD_UNSPECIFIED',
  'BLOCK_NONE',
  'BLOCK_ONLY_HIGH',
  'BLOCK_MEDIUM_AND_ABOVE',
  'BLOCK_LOW_AND_ABOVE',
  'OFF',
] as const

export const SAFETY_CATEGORIES = [
  { value: 'HARM_CATEGORY_HARASSMENT', label: '骚扰' },
  { value: 'HARM_CATEGORY_HATE_SPEECH', label: '仇恨言论' },
  { value: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', label: '露骨色情' },
  { value: 'HARM_CATEGORY_DANGEROUS_CONTENT', label: '危险内容' },
  { value: 'HARM_CATEGORY_CIVIC_INTEGRITY', label: '公民诚信' },
  { value: 'HARM_CATEGORY_JAILBREAK', label: '越狱提示' },
] as const

export const THINKING_LEVELS = [
  { value: 'THINKING_LEVEL_UNSPECIFIED', label: '跟随默认', note: '由模型决定思考等级' },
  { value: 'MINIMAL', label: '最少', note: '响应更快' },
  { value: 'LOW', label: '低', note: '轻量推理' },
  { value: 'MEDIUM', label: '中', note: '平衡质量与速度' },
  { value: 'HIGH', label: '高', note: '复杂构图与文字' },
] as const

/** Gemini 3 image models expose thinkingConfig. Gemini 2.5 image and unknown
 * gateway aliases must not receive it blindly: the upstream rejects the whole
 * request with "Thinking is not enabled for this model". Unknown custom names
 * are left enabled because a gateway may expose a Gemini 3-compatible alias.
 */
export function supportsThinking(model: string): boolean {
  const id = model.trim().toLowerCase()
  if (!id || id.includes('2.5')) return false
  return id.includes('gemini-3') || id.includes('nano-banana')
}

export const DEFAULT_SAFETY_SETTINGS = Object.fromEntries(
  SAFETY_CATEGORIES.map(category => [category.value, null]),
)

/** finishReason values the doc lists, with what each one means. */
export const FINISH_REASONS: Record<string, string> = {
  STOP: '正常完成',
  MAX_TOKENS: '超出 token 限制',
  SAFETY: '文本安全拦截',
  IMAGE_SAFETY: '图片安全拦截',
  PROHIBITED_CONTENT: '禁止内容',
  OTHER: '其他拦截',
}

/** Documented output pixels, keyed by imageSize then aspectRatio.
 *
 *  Google maps by equal area rather than longest edge, so these cannot be
 *  derived from the ratio — they are transcribed from the doc's three tables.
 *  The 512 row is only documented for 3.1 Flash Image; other models are
 *  flagged by sizeSupported even though the shared table keeps the pixels visible.
 */
export const DOC_PIXELS: Record<string, Record<string, string>> = {
  '512': {
    '1:1': '512x512', '1:4': '256x1024', '4:1': '1024x256', '1:8': '192x1536', '8:1': '1536x192',
    '2:3': '424x632', '3:2': '632x424', '3:4': '448x600', '4:3': '600x448',
    '4:5': '464x576', '5:4': '576x464', '9:16': '384x688', '16:9': '688x384', '21:9': '792x168',
  },
  '1K': {
    '1:1': '1024x1024', '1:4': '512x2048', '1:8': '384x3072',
    '2:3': '848x1264', '3:2': '1264x848', '3:4': '896x1200',
    '4:1': '2048x512', '4:3': '1200x896', '4:5': '928x1152',
    '5:4': '1152x928', '8:1': '3072x384', '9:16': '768x1376',
    '16:9': '1376x768', '21:9': '1584x672',
  },
  '2K': {
    '1:1': '2048x2048', '1:4': '1024x4096', '1:8': '768x6144',
    '2:3': '1696x2528', '3:2': '2528x1696', '3:4': '1792x2400',
    '4:1': '4096x1024', '4:3': '2400x1792', '4:5': '1856x2304',
    '5:4': '2304x1856', '8:1': '6144x768', '9:16': '1536x2752',
    '16:9': '2752x1536', '21:9': '3168x1344',
  },
  '4K': {
    '1:1': '4096x4096', '1:4': '2048x8192', '1:8': '1536x12288',
    '2:3': '3392x5056', '3:2': '5056x3392', '3:4': '3584x4800',
    '4:1': '8192x2048', '4:3': '4800x3584', '4:5': '3712x4608',
    '5:4': '4608x3712', '8:1': '12288x1536', '9:16': '3072x5504',
    '16:9': '5504x3072', '21:9': '6336x2688',
  },
}

/** Whether the doc says this model accepts this imageSize. */
export function sizeSupported(model: string, size: string): boolean {
  const entry = IMAGE_SIZES.find(s => s.value === size)
  if (!entry) return false
  if (entry.models === '*') return true
  return (entry.models as readonly string[]).includes(model)
}

/** Whether the doc says this model accepts this aspectRatio. */
export function ratioSupported(model: string, ratio: string): boolean {
  if ((COMMON_RATIOS as readonly string[]).includes(ratio)) return true
  if ((FLASH2_ONLY_RATIOS as readonly string[]).includes(ratio)) {
    return FLASH2_MODELS.includes(model)
  }
  return false
}

/** What the doc says an unsupported imageSize actually produces.
 *
 *  Flash models are documented as silently falling back to 1K rather than
 *  erroring, so the card can predict the fallback and then check it happened —
 *  a silent downgrade is the failure this module exists to make visible.
 */
export function effectiveSize(model: string, size: string | undefined): string {
  // Unset: the doc gives 1K as the default for every model.
  if (!size) return '1K'
  if (sizeSupported(model, size)) return size

  // A case variant of a supported value. The doc says these are ignored and fall
  // back to 1K, but 2026-08-11 testing against api.147ai.cn found "2k" honoured
  // as 2K (1:1 → 2048×2048, reproduced twice). Since the observed behaviour
  // contradicts the doc, treat any case variant as its canonical value: that
  // predicts what actually came back for the one variant that was measured, and
  // the case-sensitivity claim is reported by the card rather than baked in here.
  //
  // Only "2k" was tested. The other variants ("1k", "4k") are extrapolated from
  // it — if the gateway turns out to treat them differently, the card will show
  // the mismatch rather than hiding it, which is the failure mode to prefer.
  const canonical = IMAGE_SIZES.find(
    s => s.value.toUpperCase() === size.toUpperCase() && s.value !== size,
  )
  if (canonical && sizeSupported(model, canonical.value)) {
    return canonical.value
  }

  // Genuinely unsupported for this model — the doc's documented silent downgrade.
  return '1K'
}

/** The pixels the doc promises for a model/ratio/size combination, or null when
 *  the doc publishes no figure for it (512, and the extreme Flash-2 ratios). */
export function docPixels(
  model: string,
  ratio: string | undefined,
  size: string | undefined,
): string | null {
  const effRatio = ratio ?? '1:1'   // documented default
  const effSize = effectiveSize(model, size)
  return DOC_PIXELS[effSize]?.[effRatio] ?? null
}

/** "1024x1024" → "1024×1024" for display. */
export function fmtPixels(p: string): string {
  return p.replace('x', '×')
}

/** Reduce measured pixels to the nearest of the documented ratios, so a card can
 *  say which ratio actually came back. Nearest rather than exact: the documented
 *  pixel sizes are equal-area approximations and rarely reduce to the ratio
 *  exactly (1184×864 is 37:27, not 4:3). */
export function nearestRatio(w: number, h: number): string {
  const target = w / h
  let best = ALL_RATIOS[0]
  let bestDiff = Infinity
  for (const r of ALL_RATIOS) {
    const [a, b] = r.split(':').map(Number)
    const diff = Math.abs(a / b - target)
    if (diff < bestDiff) {
      bestDiff = diff
      best = r
    }
  }
  return best
}
