/** Shared motion helpers, built on anime.js v4.
 *
 *  Everything animation-related routes through here so timings and easings stay
 *  consistent across the app, and so there is exactly one place that honours the
 *  user's reduced-motion setting.
 */
import { animate, stagger, utils } from 'animejs'

/** Respecting this is not optional: motion can cause real discomfort, and the
 *  OS-level switch is how people tell us that. Every helper below no-ops into a
 *  final-state snap when it is on. */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

type Target = Element | Element[] | string | null | undefined

function isEmpty(t: Target): boolean {
  if (!t) return true
  if (Array.isArray(t)) return t.length === 0
  return false
}

/** Cards entering the results grid: a short rise-and-settle, staggered so a
 *  batch reads as arriving rather than blinking into place. */
export function enterCards(targets: Target, opts: { delay?: number } = {}) {
  if (isEmpty(targets)) return
  if (prefersReducedMotion()) {
    utils.set(targets as never, { opacity: 1, y: 0, scale: 1 })
    return
  }
  // Hide synchronously. anime applies `from` on its first frame, which is a rAF
  // and can land after the browser has already painted the finished card — the
  // result is a visible flash followed by a fade-in from nothing.
  utils.set(targets as never, { opacity: 0, y: 14, scale: 0.97 })
  return animate(targets as never, {
    opacity: 1,
    y: 0,
    scale: 1,
    duration: 460,
    delay: stagger(38, { start: opts.delay ?? 0 }),
    ease: 'out(3)',
  })
}

/** One-shot reveal for a panel or drawer body. */
export function fadeInUp(targets: Target, opts: { delay?: number; distance?: number } = {}) {
  if (isEmpty(targets)) return
  if (prefersReducedMotion()) {
    utils.set(targets as never, { opacity: 1, y: 0 })
    return
  }
  utils.set(targets as never, { opacity: 0, y: opts.distance ?? 10 })
  return animate(targets as never, {
    opacity: 1,
    y: 0,
    duration: 380,
    delay: opts.delay ?? 0,
    ease: 'out(3)',
  })
}

/** Opacity-only reveal.
 *
 *  Use this on elements whose `transform` is already driven by reactive state —
 *  animating transform there would fight the framework, since each re-render
 *  overwrites whatever the animation just wrote.
 */
export function fadeIn(targets: Target, duration = 220) {
  if (isEmpty(targets)) return
  if (prefersReducedMotion()) {
    utils.set(targets as never, { opacity: 1 })
    return
  }
  utils.set(targets as never, { opacity: 0 })
  return animate(targets as never, { opacity: 1, duration, ease: 'out(2)' })
}

/** Count a number up to its new value. Used for the request/image counters, so a
 *  changing total reads as movement instead of a silent swap. */
export function countTo(
  from: number,
  to: number,
  onUpdate: (v: number) => void,
  duration = 420,
) {
  if (from === to) {
    onUpdate(to)
    return
  }
  if (prefersReducedMotion()) {
    onUpdate(to)
    return
  }
  const box = { v: from }
  return animate(box, {
    v: to,
    duration,
    ease: 'out(3)',
    onUpdate: () => onUpdate(Math.round(box.v)),
    onComplete: () => onUpdate(to),
  })
}

/** A brief pulse to acknowledge a click on something that has no other feedback. */
export function pulse(targets: Target) {
  if (isEmpty(targets) || prefersReducedMotion()) return
  return animate(targets as never, {
    scale: [{ to: 1.06, duration: 110 }, { to: 1, duration: 220 }],
    ease: 'out(2)',
  })
}

/** Draw attention to an element that just failed, without a jarring shake. */
export function nudge(targets: Target) {
  if (isEmpty(targets) || prefersReducedMotion()) return
  return animate(targets as never, {
    x: [
      { to: -5, duration: 60 },
      { to: 5, duration: 60 },
      { to: -3, duration: 60 },
      { to: 0, duration: 80 },
    ],
    ease: 'inOut(2)',
  })
}
