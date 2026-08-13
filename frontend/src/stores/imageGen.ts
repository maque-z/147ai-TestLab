import { defineStore } from 'pinia'
import { computed, reactive, ref } from 'vue'
import type {
  ImageConfig, GenerateRequest, GenMode, ImageJob, ParamMatrix, RefImage,
} from '@/types'
import * as imageGenApi from '@/api/imageGen'
import { b64ToBlobUrl, imageMime, revokeJob, useBatchRunner } from '@/utils/batch'
import { DEFAULT_PROMPT } from '@/utils/defaultPrompt'

/** Binary inputs for an edit batch. Present == run against /edit instead of
 *  /generate; the param matrix expands identically either way. */
export interface EditInputs {
  images: File[]
  mask: Blob | null
}

const DEFAULT_CONFIG: ImageConfig = {
  baseurl: '',
  api_key: '',
  model_id: 'gpt-image-2',
  timeout: 480,
}

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

export const useImageGenStore = defineStore('imageGen', () => {
  // Controllers, progress counters and the run loop — shared with the Gemini
  // surface so the two cannot drift on cancellation semantics. See utils/batch.ts.
  const runner = useBatchRunner<ImageJob>()
  const config = ref<ImageConfig>({ ...DEFAULT_CONFIG })

  // One pool per endpoint, each capped separately. Kept apart so the two tabs
  // do not compete for the same 50 slots: switching to 编辑 must not mean the
  // 生成 results are already gone.
  const generateJobs = ref<ImageJob[]>([])
  const editJobs = ref<ImageJob[]>([])

  const configLoaded = ref(false)

  // The config drawer is opened from the top bar, which lives in the layout,
  // but rendered inside the view — so the flag has to be shared.
  const configOpen = ref(false)

  // ---- Batch form state ----
  // Held here rather than in the panel because the run button lives in the top
  // bar, in a different component tree: both sides need the same matrix.
  const mode = ref<GenMode>('generate')

  // Which pane the panel shows. 'test' is the fixed compatibility suite, which
  // runs its own requests from its own store — kept out of GenMode so the batch
  // code paths never have to consider a third endpoint that does not exist.
  const view = ref<'batch' | 'test'>('batch')

  const prompt = ref(DEFAULT_PROMPT)
  const refImages = ref<RefImage[]>([])
  const mask = ref<Blob | null>(null)
  const paramsCollapsed = ref(false)

  // Everything starts unselected: the default run is one request with nothing but
  // the prompt, which is the baseline every other combination is compared against.
  const matrix = reactive<ParamMatrix>({
    sizes: [],
    qualities: [],
    formats: [],
    moderations: [],
    n: 1,
    output_compression: null,
    concurrency: 50,
  })

  /** An empty group still yields one request — the API's own default. */
  const rowCount = (arr: unknown[]) => arr.length || 1
  /** Clearing the number input yields null, which would make the counts NaN. */
  const perRequest = computed(() => matrix.n || 1)

  const totalRequests = computed(() =>
    rowCount(matrix.sizes) * rowCount(matrix.qualities) *
    rowCount(matrix.formats) * rowCount(matrix.moderations)
  )
  const totalImages = computed(() => totalRequests.value * perRequest.value)

  /** Why the run button is disabled, surfaced as its tooltip rather than left for
   *  the user to guess. */
  const blockReason = computed(() => {
    if (!prompt.value.trim()) return '请先填写提示词'
    if (mode.value === 'edit' && !refImages.value.length) return '编辑模式至少需要 1 张参考图'
    return ''
  })
  const canRun = computed(() => !blockReason.value && totalRequests.value > 0)

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

  /** The pool a given endpoint's cards live in. */
  function poolFor(m: GenMode) {
    return m === 'edit' ? editJobs : generateJobs
  }

  /** Kick off a batch from the current form state. Called from the top bar, which
   *  is why every input it needs lives in this store. Concurrent batches are
   *  allowed: a second run starts while the first is still in flight. */
  async function run() {
    if (!canRun.value) return
    // Collapse to hand the viewport to the results the run is about to produce.
    paramsCollapsed.value = true
    await generateMatrix(
      prompt.value,
      {
        ...matrix,
        sizes: [...matrix.sizes],
        qualities: [...matrix.qualities],
        formats: [...matrix.formats],
        moderations: [...matrix.moderations],
        n: perRequest.value,
      },
      mode.value === 'edit'
        ? { images: refImages.value.map(r => r.file), mask: mask.value }
        : undefined,
    )
  }

  async function generateMatrix(promptText: string, matrixIn: ParamMatrix, edit?: EditInputs) {
    const combos = buildCombos(matrixIn)
    if (!combos.length) return

    const jobMode: GenMode = edit ? 'edit' : 'generate'

    // Seed every slot as pending so the grid shows placeholders immediately
    const seeded: ImageJob[] = combos.map(c => ({
      id: ++jobSeq,
      status: 'pending',
      mode: jobMode,
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
    // One request per combination. Everything about status, cancellation and
    // progress is the runner's job; this closure only issues the call and writes
    // what came back onto the card.
    await runner.run(
      poolFor(jobMode),
      seeded,
      async (job, i, signal) => {
        const combo = combos[i]
        const req = { prompt: promptText, ...combo } as GenerateRequest
        // Each combination is a separate upstream call, so an edit batch
        // re-uploads its reference images once per combination — there is no
        // way around that short of the Files API, which gateways rarely proxy.
        const res = edit
          ? await imageGenApi.edit(req, edit.images, edit.mask, signal)
          : await imageGenApi.generate(req, signal)

        // Every image from this request goes on the same card, so its count
        // against the requested n is visible without hunting across the grid.
        // The images of one response are decoded in parallel — they are
        // independent, and awaiting them one at a time would serialise what the
        // browser can overlap.
        job.images = await Promise.all(res.images.map(async img => {
          // Magic-byte format is authoritative; the API's claim is recorded
          // separately. `job.format` stays as requested so the card can show
          // requested → actual.
          const actual = img.image_format ?? undefined
          return {
            src: img.b64_json
              // Falls back to the requested format, then png — see imageMime.
              ? await b64ToBlobUrl(img.b64_json, imageMime(actual, job.format))
              : img.url,
            bytes: img.byte_size ?? undefined,
            actualFormat: actual,
            revisedPrompt: img.revised_prompt ?? undefined,
          }
        }))
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

        // A 200 carrying no image is a result, not a transport failure, so it is
        // labelled here rather than thrown at the runner.
        if (job.images.length) {
          job.status = 'done'
        } else {
          job.status = 'error'
          job.error = 'API 未返回图片'
        }
      },
      matrixIn.concurrency,
    )
  }

  /** Clear only the active tab's pool. Running batches are untouched. */
  function clearJobs() {
    const pool = poolFor(mode.value)
    pool.value.forEach(revokeJob)
    pool.value = []
  }

  return {
    config, generateJobs, editJobs, configLoaded, configOpen,
    mode, view, prompt, refImages, mask, matrix, paramsCollapsed,
    // Named one by one rather than spread. The runner also exposes its own `run`,
    // which takes a pool and a send callback — spreading it would put that on the
    // store next to this store's `run()`, with only key order deciding which one
    // the top-bar button ends up calling.
    generating: runner.generating,
    doneCount: runner.doneCount,
    totalCount: runner.totalCount,
    stop: runner.stop,
    stopJob: runner.stopJob,
    perRequest, totalRequests, totalImages, blockReason, canRun,
    loadConfig, updateConfig, run, generateMatrix, clearJobs,
  }
})
