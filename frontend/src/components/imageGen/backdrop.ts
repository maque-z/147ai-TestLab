import { ref } from 'vue'

/** What sits behind an image while it is being inspected for transparency.
 *
 *  A checkerboard on its own cannot answer the question this tool exists to
 *  answer. gpt-image-2's own announcement thread carries a report of requested
 *  transparency arriving as a *rendered* checkerboard rather than real alpha —
 *  and against a checkerboard backdrop those two are pixel-identical. Switching
 *  the backdrop settles it in one click: a genuinely transparent image changes
 *  with the backdrop, a painted checkerboard sits there unmoved.
 *
 *  The card's 背景 row already carries the authoritative answer, sampled from the
 *  decoded pixels. This is the same finding made visible, for the times when
 *  looking at the image is faster than reading the table.
 */
export type Backdrop = 'checker' | 'light' | 'dark' | 'magenta'

export const BACKDROPS: Backdrop[] = ['checker', 'light', 'dark', 'magenta']

export const BACKDROP_LABEL: Record<Backdrop, string> = {
  checker: '棋盘格',
  light: '白底',
  dark: '黑底',
  magenta: '品红',
}

/** Module-level rather than per-component, for two reasons: the grid and the
 *  full-screen viewer must never disagree about what they are showing, and the
 *  choice has to survive closing the viewer — otherwise every image would have
 *  to be re-checked from scratch. */
export const backdrop = ref<Backdrop>('checker')

export function cycleBackdrop() {
  backdrop.value = BACKDROPS[(BACKDROPS.indexOf(backdrop.value) + 1) % BACKDROPS.length]
}
