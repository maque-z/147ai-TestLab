/** Shared machinery for the batch surfaces.
 *
 *  Both image modules run the same shape of batch: expand a param matrix into one
 *  request per combination, fire them through a bounded pool, write each result
 *  onto its own card, and let either the whole batch or a single card be stopped.
 *  That logic used to exist twice, near-identically, in stores/imageGen.ts and
 *  stores/bananaGen.ts, with a third copy of the pool runner in stores/apiTest.ts.
 *
 *  It drifted both times it could: the two copies of the suite's concurrency
 *  constant disagreed, and TEST_CASE_COUNT was wrong by two for several commits.
 *  crud/user.py on the backend already carries a note about why the equivalent
 *  race-handling there is parameterised rather than copied — same reasoning, so
 *  the frontend now matches it.
 */

import { ref, type Ref } from 'vue'

/** Hard cap on retained cards, applied per pool rather than across all of them.
 *  Blob URLs keep the bytes off the JS heap, but the DOM still has to render
 *  every card, so each list stays bounded independently — a wide generate batch
 *  can no longer evict the edit results the user was comparing against. */
export const MAX_POOL = 50

/** The minimum a card has to look like for the helpers below to manage it.
 *  Everything else about a job differs per surface and stays in its own store. */
export interface PoolJob {
  id: number
  status: 'pending' | 'running' | 'done' | 'error' | 'cancelled'
  images: { src?: string }[]
  error?: string
  elapsedMs?: number
  finishedAt?: number
}

/** Run tasks with at most `limit` in flight. Each worker pulls the next index off
 *  a shared cursor, so a slow task never blocks the others. */
export async function runPool(
  tasks: (() => Promise<void>)[],
  limit: number,
  signal: AbortSignal,
) {
  let cursor = 0
  const worker = async () => {
    while (cursor < tasks.length) {
      // Stop claiming new work as soon as the whole batch is stopped. Requests
      // already in flight are torn down separately by their own signals.
      if (signal.aborted) return
      const i = cursor++
      await tasks[i]()
    }
  }
  // Clamp: a cleared number input yields null/0, which would spawn no workers and
  // leave every job stuck on "pending".
  const workers = Math.max(1, Math.min(limit || 1, tasks.length))
  await Promise.all(Array.from({ length: workers }, worker))
}

/** Decode a base64 image off the main thread by delegating to the browser's
 *  native fetch/blob pipeline.  The synchronous atob + charCodeAt loop blocks
 *  for tens of milliseconds per image and up to several seconds when 50 jobs
 *  resolve concurrently.  fetch(data:) is both faster and non-blocking. */
export async function b64ToBlobUrl(b64: string, mime: string): Promise<string> {
  const resp = await fetch(`data:${mime};base64,${b64}`)
  const blob = await resp.blob()
  return URL.createObjectURL(blob)
}

/** MIME subtype for a decode, given the sniffed format and a fallback.
 *  png is the safe guess when the format was left unset — `image/undefined` is
 *  undecodable — and jpg has to be spelled jpeg for the browser. */
export function imageMime(actual?: string, fallback?: string): string {
  const sub = actual ?? fallback ?? 'png'
  return `image/${sub === 'jpg' ? 'jpeg' : sub}`
}

/** Free the blob URLs a card holds. A job carries every image its request
 *  returned, so all of them are revoked. */
export function revokeJob(job: PoolJob) {
  job.images.forEach(img => {
    if (img.src?.startsWith('blob:')) URL.revokeObjectURL(img.src)
  })
}

/** Evict oldest-first down to the cap.
 *
 *  New cards are unshifted onto the front, so the tail is the oldest. Cards
 *  still pending or running are skipped rather than evicted: a concurrent
 *  batch is actively writing to those, and dropping one would make its own
 *  results vanish from under it mid-flight. That can briefly leave a pool
 *  above the cap, which is the better trade.
 */
export function trimPool<J extends PoolJob>(pool: Ref<J[]>, cap = MAX_POOL) {
  for (let i = pool.value.length - 1; i >= 0 && pool.value.length > cap; i--) {
    const job = pool.value[i]
    if (job.status === 'pending' || job.status === 'running') continue
    revokeJob(job)
    pool.value.splice(i, 1)
  }
}

/** Batch lifecycle: controllers, progress counters, and the run loop.
 *
 *  Owns everything that was identical between the two stores. What is left for a
 *  caller to supply is the one genuinely per-surface piece — `send`, which issues
 *  one request and writes its result onto the card. Status transitions,
 *  cancellation, the abort cascade and the error branch are handled here, so the
 *  two surfaces cannot drift on them again.
 */
export function useBatchRunner<J extends PoolJob>() {
  const generating = ref(false)

  // Progress of the current batch only. Counting the whole list would show the
  // bar pre-filled, since jobs from earlier batches are already finished.
  const doneCount = ref(0)
  const totalCount = ref(0)

  // One controller per active batch. Using a Set so concurrent batches are all
  // tracked; stop() signals every one of them.
  const batchCtls = new Set<AbortController>()

  // One controller per job, so a single card can be stopped without touching the
  // rest of the batch. Kept outside reactive state: a controller is not data the
  // UI renders, and wrapping it in a proxy would break its internal slots.
  const jobCtls = new Map<number, AbortController>()

  /** Abort every active batch. Queued slots that haven't started are cancelled;
   *  already-finished cards are kept. Per-job stop is available on each card. */
  function stop() {
    batchCtls.forEach(c => c.abort())
  }

  /** Abort one card. The pool keeps going, so the rest of the batch is unaffected
   *  and the queued slots behind this one still run. */
  function stopJob(id: number) {
    jobCtls.get(id)?.abort()
  }

  /** Seed `jobs` onto the front of `pool` and run one request per job.
   *
   *  `send(job, index, signal)` issues the request and writes the result. It is
   *  called only for jobs that were not cancelled while queued, always with
   *  status already set to 'running'. Throwing from it marks that card as an
   *  error (or cancelled, if its own signal fired) and leaves the batch running.
   *
   *  Returns once every job has settled. Concurrent batches are allowed: a second
   *  call while the first is still in flight adds to the same progress counters.
   */
  async function run(
    pool: Ref<J[]>,
    jobs: J[],
    send: (job: J, index: number, signal: AbortSignal) => Promise<void>,
    concurrency: number,
  ) {
    if (!jobs.length) return

    pool.value.unshift(...jobs)
    // Grab the reactive proxies — mutating the raw seeded objects would not
    // trigger re-renders.
    const live = pool.value.slice(0, jobs.length)

    const ctl = new AbortController()

    // First batch of a new idle→active transition: reset counters so stale
    // numbers from the previous run don't ghost through the progress display.
    if (batchCtls.size === 0) {
      doneCount.value = 0
      totalCount.value = 0
    }
    batchCtls.add(ctl)

    // Controllers exist before the pool starts, so a card still queued can be
    // stopped from its own button rather than only once it goes in flight.
    live.forEach(j => jobCtls.set(j.id, new AbortController()))

    generating.value = true
    // Accumulate: each concurrent batch adds to the running total so the
    // top-bar progress covers all active batches, not just the latest.
    totalCount.value += jobs.length

    try {
      await runPool(
        live.map((job, i) => async () => {
          const jobCtl = jobCtls.get(job.id)!
          // Stopped while it sat in the queue — never send the request at all.
          if (jobCtl.signal.aborted || ctl.signal.aborted) {
            job.status = 'cancelled'
            doneCount.value++
            return
          }

          // Stopping the batch has to cascade into each open request.
          const cascade = () => jobCtl.abort()
          ctl.signal.addEventListener('abort', cascade)

          job.status = 'running'
          const t0 = performance.now()
          try {
            await send(job, i, jobCtl.signal)
          } catch (e: any) {
            // stop()/stopJob() surface here as an axios cancellation. That is a
            // user action, not a failure, so label it separately.
            if (jobCtl.signal.aborted) {
              job.status = 'cancelled'
            } else {
              job.status = 'error'
              job.error = e?.response?.data?.detail || e?.message || '生成失败'
            }
            job.elapsedMs = Math.round(performance.now() - t0)
            job.finishedAt = Date.now()
          } finally {
            ctl.signal.removeEventListener('abort', cascade)
            jobCtls.delete(job.id)
            doneCount.value++
          }
        }),
        concurrency,
        ctl.signal,
      )
    } finally {
      // Slots the pool never claimed would otherwise sit on "pending" forever:
      // stop() makes the workers return without claiming the rest of the queue.
      //
      // They are counted as they are swept. Without that, doneCount stops short
      // of totalCount for good — which is invisible for a single batch, since the
      // progress readout is only rendered while generating, but a concurrent
      // batch shares these counters, so stopping one used to leave the other
      // stuck reading e.g. "3 / 9" after it had genuinely finished all 9.
      //
      // Cannot double-count: a task that entered the pool sets its own status
      // off 'pending' before it increments, so the two paths are disjoint.
      live.forEach(j => {
        if (j.status === 'pending') {
          j.status = 'cancelled'
          doneCount.value++
        }
        jobCtls.delete(j.id)
      })
      batchCtls.delete(ctl)
      generating.value = batchCtls.size > 0
      trimPool(pool)
    }
  }

  return { generating, doneCount, totalCount, stop, stopJob, run }
}
