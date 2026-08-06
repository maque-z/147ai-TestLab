import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ImageConfig, GenerateRequest, GenMode, ImageJob, ParamMatrix } from '@/types'
import * as imageGenApi from '@/api/imageGen'

/** Binary inputs for an edit batch. Present == run against /edit instead of
 *  /generate; the param matrix expands identically either way. */
export interface EditInputs {
  images: File[]
  mask: Blob | null
}

const DEFAULT_CONFIG: ImageConfig = {
  baseurl: 'https://api.openai.com',
  api_key: '',
  model_id: 'gpt-image-2',
  timeout: 400,
}

/** Hard cap on retained cards. Blob URLs keep the bytes off the JS heap, but the
 *  DOM still has to render every card, so the list stays bounded. */
const MAX_JOBS = 200

let jobSeq = 0

/** An unselected param means "let the API decide", so it still contributes
 *  exactly one row to the cross product — with the value left undefined. */
function orDefault<T>(arr: T[]): (T | undefined)[] {
  return arr.length ? arr : [undefined]
}

/** Expand the matrix into one combination per upstream request.
 *  output_compression only applies to jpeg/webp, so png rows omit it — otherwise
 *  every compression value would produce an identical duplicate png request. */
function buildCombos(m: ParamMatrix): Omit<GenerateRequest, 'prompt'>[] {
  const combos: Omit<GenerateRequest, 'prompt'>[] = []
  for (const size of orDefault(m.sizes)) {
    for (const quality of orDefault(m.qualities)) {
      for (const output_format of orDefault(m.formats)) {
        for (const moderation of orDefault(m.moderations)) {
          combos.push({
            size,
            quality,
            output_format,
            moderation,
            n: m.n,
            // undefined keys are dropped by JSON.stringify, so the backend sees
            // "unset" rather than a value it would have to special-case.
            output_compression:
              (output_format === 'jpeg' || output_format === 'webp') &&
              m.output_compression != null
                ? m.output_compression
                : undefined,
          })
        }
      }
    }
  }
  return combos
}

/** Run tasks with at most `limit` in flight. Each worker pulls the next index off
 *  a shared cursor, so a slow task never blocks the others. */
async function runPool(tasks: (() => Promise<void>)[], limit: number, signal: AbortSignal) {
  let cursor = 0
  const worker = async () => {
    while (cursor < tasks.length) {
      // Stop claiming new work as soon as the user hits stop. Requests already in
      // flight are torn down separately by the shared signal.
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

function b64ToBlobUrl(b64: string, mime: string): string {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return URL.createObjectURL(new Blob([bytes], { type: mime }))
}

export const useImageGenStore = defineStore('imageGen', () => {
  const config = ref<ImageConfig>({ ...DEFAULT_CONFIG })
  const jobs = ref<ImageJob[]>([])
  const generating = ref(false)
  const configLoaded = ref(false)

  // The config drawer is opened from the top bar, which lives in the layout,
  // but rendered inside the view — so the flag has to be shared.
  const configOpen = ref(false)

  // Progress of the current batch only. Counting the whole list would show the
  // bar pre-filled, since jobs from earlier batches are already finished.
  const doneCount = ref(0)
  const totalCount = ref(0)

  // Held for the lifetime of one batch so stop() can abort it. Not a ref — the UI
  // tracks `generating` instead and never reads the controller itself.
  let abortCtl: AbortController | null = null

  /** Abort the running batch: tears down in-flight requests and stops the pool
   *  from claiming queued work. Already-finished cards are kept. */
  function stop() {
    abortCtl?.abort()
  }

  async function loadConfig() {
    if (configLoaded.value) return
    try {
      config.value = await imageGenApi.getConfig()
      configLoaded.value = true
    } catch {
      // keep defaults; retried on next mount
    }
  }

  async function updateConfig(cfg: ImageConfig) {
    config.value = await imageGenApi.saveConfig(cfg)
  }

  function revoke(job: ImageJob) {
    // A job holds every image the request returned, so free them all.
    job.images.forEach(img => {
      if (img.src?.startsWith('blob:')) URL.revokeObjectURL(img.src)
    })
  }

  function trim() {
    if (jobs.value.length <= MAX_JOBS) return
    jobs.value.splice(MAX_JOBS).forEach(revoke)
  }

  async function generateMatrix(prompt: string, matrix: ParamMatrix, edit?: EditInputs) {
    const combos = buildCombos(matrix)
    if (!combos.length) return

    const mode: GenMode = edit ? 'edit' : 'generate'

    // Seed every slot as pending so the grid shows placeholders immediately
    const seeded: ImageJob[] = combos.map(c => ({
      id: ++jobSeq,
      status: 'pending',
      mode,
      size: c.size,
      quality: c.quality,
      format: c.output_format,
      moderation: c.moderation,
      n: c.n ?? 1,
      compression: c.output_compression,
      model: config.value.model_id,
      refCount: edit?.images.length,
      hasMask: edit ? !!edit.mask : undefined,
      images: [],
      activeIndex: 0,
    }))
    jobs.value.unshift(...seeded)

    // Grab the reactive proxies — mutating the raw seeded objects would not
    // trigger re-renders.
    const live = jobs.value.slice(0, seeded.length)

    const ctl = new AbortController()
    abortCtl = ctl

    generating.value = true
    doneCount.value = 0
    totalCount.value = combos.length
    try {
      await runPool(
        combos.map((combo, i) => async () => {
          const job = live[i]
          job.status = 'running'
          const t0 = performance.now()
          try {
            const req = { prompt, ...combo } as GenerateRequest
            // Each combination is a separate upstream call, so an edit batch
            // re-uploads its reference images once per combination — there is no
            // way around that short of the Files API, which gateways rarely proxy.
            const res = edit
              ? await imageGenApi.edit(req, edit.images, edit.mask, ctl.signal)
              : await imageGenApi.generate(req, ctl.signal)

            // Every image from this request goes on the same card, so its count
            // against the requested n is visible without hunting across the grid.
            job.images = res.images.map(img => {
              // Magic-byte format is authoritative; the API's claim is recorded
              // separately. `job.format` stays as requested so the card can show
              // requested → actual.
              const actual = img.image_format ?? undefined
              // png is the API's own default, and the only safe guess when the
              // format was left unset — image/undefined is undecodable.
              const sub = actual ?? job.format ?? 'png'
              return {
                src: img.b64_json
                  ? b64ToBlobUrl(img.b64_json, `image/${sub === 'jpg' ? 'jpeg' : sub}`)
                  : img.url,
                bytes: img.byte_size ?? undefined,
                actualFormat: actual,
                revisedPrompt: img.revised_prompt ?? undefined,
              }
            })
            job.activeIndex = 0
            job.declaredFormat = res.declared_format ?? undefined
            job.actualModel = res.upstream_model ?? undefined
            job.elapsedMs = res.elapsed_ms
            job.finishedAt = Date.now()
            job.requestId = res.request_id ?? undefined
            job.inputTokens = res.input_tokens ?? undefined
            job.inputTextTokens = res.input_text_tokens ?? undefined
            job.inputImageTokens = res.input_image_tokens ?? undefined
            job.outputTokens = res.output_tokens ?? undefined

            if (job.images.length) {
              job.status = 'done'
            } else {
              job.status = 'error'
              job.error = 'API 未返回图片'
            }
          } catch (e: any) {
            // stop() surfaces here as an axios cancellation. That is a user action,
            // not a failure, so label it separately from a real error.
            if (ctl.signal.aborted) {
              job.status = 'cancelled'
            } else {
              job.status = 'error'
              job.error = e?.response?.data?.detail || e?.message || '生成失败'
            }
            job.elapsedMs = Math.round(performance.now() - t0)
            job.finishedAt = Date.now()
          } finally {
            doneCount.value++
          }
        }),
        matrix.concurrency,
        ctl.signal
      )
    } finally {
      // Slots the pool never claimed would otherwise sit on "pending" forever.
      live.forEach(j => {
        if (j.status === 'pending') j.status = 'cancelled'
      })
      abortCtl = null
      generating.value = false
      trim()
    }
  }

  function clearJobs() {
    jobs.value.forEach(revoke)
    jobs.value = []
  }

  return {
    config, jobs, generating, configLoaded, configOpen,
    doneCount, totalCount,
    loadConfig, updateConfig, generateMatrix, stop, clearJobs,
  }
})
