/** The documented behaviour of the GPT Image models, transcribed so the UI can
 *  state what the docs promise and the cards can flag where reality differs.
 *
 *  Same role as bananaSpec.ts on the Gemini side. Sources: the platform's image
 *  generation guide, the gpt-image-2.5-sunburst / -flare model pages and the API
 *  changelog entry of 2026-09-08. Nothing here is inferred — where the docs give
 *  no figure, the helpers return null and the UI says so rather than inventing
 *  an expectation to check against.
 */

export interface GptImageModel {
  id: string
  /** What the docs say about it, shown on the chip. */
  note: string
}

/** Models the Images API documents, newest first.
 *
 *  Dated snapshots are listed as their own entries because a gateway that
 *  accepts the alias but not the snapshot id — or quietly maps one onto the
 *  other — is exactly what sending both side by side reveals. Anything else
 *  (gpt-image-1.5, a house alias) is typed in as a custom id and saved to the
 *  account.
 */
export const GPT_IMAGE_MODELS: readonly GptImageModel[] = [
  { id: 'gpt-image-2.5-sunburst', note: '官方 2026-09-08 · 质量与编辑精度优先 · quality 到 max' },
  { id: 'gpt-image-2.5-flare',    note: '官方 2026-09-08 · 速度优先，延迟低约 50% · quality 到 max' },
  { id: 'gpt-image-2',            note: '官方 2026-04-21 · quality 最高 high · 透明背景为预览' },
  { id: 'gpt-image-2.5-sunburst-2026-09-08', note: '日期快照 · 文档称 sunburst 别名当前指向它' },
  { id: 'gpt-image-2.5-flare-2026-09-08',    note: '日期快照 · 文档称 flare 别名当前指向它' },
  { id: 'gpt-image-2-2026-04-21',            note: '日期快照 · gpt-image-2 别名当前指向它' },
]

export const DOCUMENTED_MODEL_IDS: ReadonlySet<string> = new Set(GPT_IMAGE_MODELS.map(m => m.id))

/** What a fresh account starts with. The guide's own advice for a new workflow:
 *  Flare when speed is the priority, Sunburst when quality is — and a lab that
 *  fires 50 requests at once is the speed case. */
export const DEFAULT_MODEL = 'gpt-image-2.5-flare'

/** quality values, lowest to highest, as the reference orders them. `auto` is
 *  what an unset quality resolves to, so it is not offered as a chip. */
export const QUALITY_TIERS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type QualityTier = typeof QUALITY_TIERS[number]

/** The two tiers the 2.5 models added. The guide: "Earlier GPT Image models
 *  support quality settings up to high." */
export const EXTENDED_QUALITY: ReadonlySet<string> = new Set(['xhigh', 'max'])

/** Whether the docs list xhigh/max for this model. True for gpt-image-2.5-*,
 *  false for every other gpt-image-* id, and null for a custom id: nothing is
 *  known about a gateway alias, so nothing is expected of it either way. */
export function supportsExtendedQuality(model: string): boolean | null {
  if (/^gpt-image-2\.5-/i.test(model)) return true
  if (/^gpt-image-/i.test(model)) return false
  return null
}

/** Whether the model the API reports having used contradicts the one requested.
 *  An alias resolving to its own dated snapshot (or the reverse) is the API
 *  doing what aliases are for, not a swap, so it is not flagged. */
export function modelMismatch(requested: string, reported: string): boolean {
  if (reported === requested) return false
  return !reported.startsWith(requested + '-') && !requested.startsWith(reported + '-')
}

/** Constraints on a custom WIDTHxHEIGHT, per the image generation guide, which
 *  states them once for gpt-image-2 and gpt-image-2.5 alike. */
export const SIZE_RULES = {
  step: 16,
  minRatio: 1 / 3,
  maxRatio: 3,
  maxEdge: 3840,
  minPixels: 655_360,          // 1024×640
  maxPixels: 8_294_400,        // 3840×2160, which the guide calls 4K
  experimentalPixels: 2560 * 1440,
} as const

/** Every documented rule the pair breaks, in the words the popover uses. Empty
 *  means in spec. Advisory only: an out-of-spec size is a probe, and the whole
 *  point is to see how the API answers it. */
export function sizeViolations(w: number, h: number): string[] {
  const notes: string[] = []
  if (w % SIZE_RULES.step || h % SIZE_RULES.step) notes.push('非 16 的倍数')
  const ratio = w / h
  if (ratio > SIZE_RULES.maxRatio || ratio < SIZE_RULES.minRatio) notes.push('比例超出 1:3–3:1')
  if (w > SIZE_RULES.maxEdge || h > SIZE_RULES.maxEdge) notes.push('单边超过 3840')
  const px = w * h
  if (px < SIZE_RULES.minPixels) notes.push('像素数低于 655,360（1024×640）')
  if (px > SIZE_RULES.maxPixels) notes.push('像素数超过 8,294,400（3840×2160）')
  return notes
}

/** In spec, but in the range the guide flags as experimental. */
export function isExperimentalSize(w: number, h: number): boolean {
  return w * h > SIZE_RULES.experimentalPixels
}
