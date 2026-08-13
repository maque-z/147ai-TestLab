import { defineStore } from 'pinia'
import { computed, reactive, ref } from 'vue'
import type {
  BananaConfig, BananaGenerateRequest, BananaChatRequest,
  BananaMatrix, BananaMode, BananaJob,
} from '@/types'
import * as bananaApi from '@/api/bananaGen'
import { NATIVE_MODELS, OPENAI_MODELS } from '@/utils/bananaSpec'
import { b64ToBlobUrl, imageMime, revokeJob, useBatchRunner } from '@/utils/batch'
import { DEFAULT_PROMPT } from '@/utils/defaultPrompt'

const DEFAULT_CONFIG: BananaConfig = {
  baseurl: '',
  api_key: '',
  model_id: 'gemini-3-pro-image-preview',
  timeout: 480,
}

let jobSeq = 0

/** An unselected param means "let the API decide", so it still contributes
 *  exactly one row to the cross product — with the value left undefined. */
function orDefault<T>(arr: T[]): (T | undefined)[] {
  return arr.length ? arr : [undefined]
}

/** Expand the matrix into one combination per upstream request. */
function buildCombos(m: BananaMatrix): Omit<BananaGenerateRequest, 'prompt'>[] {
  const combos: Omit<BananaGenerateRequest, 'prompt'>[] = []
  for (const model_id of orDefault(m.models)) {
    for (const aspect_ratio of orDefault(m.aspectRatios)) {
      for (const image_size of orDefault(m.imageSizes)) {
        for (const modality of orDefault(m.modalities)) {
          combos.push({
            model_id,
            aspect_ratio,
            image_size,
            // Stored joined for identity; sent as the array the doc specifies.
            response_modalities: modality ? modality.split(',') : undefined,
            temperature: m.temperature ?? undefined,
            candidate_count: m.candidateCount ?? undefined,
            safety_threshold: m.safetyThreshold ?? undefined,
          })
        }
      }
    }
  }
  return combos
}

export const useBananaGenStore = defineStore('bananaGen', () => {
  // Controllers, progress counters and the run loop — shared with the gpt-image
  // surface so the two cannot drift on cancellation semantics. See utils/batch.ts.
  const runner = useBatchRunner<BananaJob>()
  const config = ref<BananaConfig>({ ...DEFAULT_CONFIG })

  // One pool per surface, capped separately, so switching tabs never discards
  // the other side's results.
  const nativeJobs = ref<BananaJob[]>([])
  const openaiJobs = ref<BananaJob[]>([])

  const configLoaded = ref(false)
  // The drawer opens from the top bar, which lives in the layout but renders
  // inside the view — so the flag has to be shared.
  const configOpen = ref(false)

  const mode = ref<BananaMode>('native')
  const prompt = ref(DEFAULT_PROMPT)
  const paramsCollapsed = ref(false)

  // Everything starts unselected except the model, which is required: it goes in
  // the URL path, so there is no "let the API decide" for it.
  const matrix = reactive<BananaMatrix>({
    models: [NATIVE_MODELS[0].id],
    aspectRatios: [],
    imageSizes: [],
    modalities: ['TEXT,IMAGE'],
    temperature: null,
    candidateCount: null,
    safetyThreshold: null,
    concurrency: 50,
  })

  /** Models selectable on the current surface. The OpenAI-compatible doc names
   *  exactly one, so the two lists are not interchangeable. */
  const availableModels = computed(() =>
    mode.value === 'openai' ? OPENAI_MODELS : NATIVE_MODELS
  )

  /** An empty group still yields one request — the API's own default. */
  const rowCount = (arr: unknown[]) => arr.length || 1

  const totalRequests = computed(() => {
    if (mode.value === 'openai') return 1
    return rowCount(matrix.models) * rowCount(matrix.aspectRatios) *
           rowCount(matrix.imageSizes) * rowCount(matrix.modalities)
  })

  /** candidateCount asks for more than one image per request, so the image total
   *  is not the request total. */
  const totalImages = computed(() => totalRequests.value * (matrix.candidateCount || 1))

  const blockReason = computed(() => {
    if (!prompt.value.trim()) return '请先填写提示词'
    if (mode.value === 'native' && !matrix.models.length) return '请至少选择 1 个模型'
    return ''
  })
  const canRun = computed(() => !blockReason.value && totalRequests.value > 0)

  async function loadConfig() {
    if (configLoaded.value) return
    try {
      config.value = await bananaApi.getConfig()
      configLoaded.value = true
    } catch {
      // keep defaults; retried on next mount
    }
  }

  async function updateConfig(cfg: BananaConfig) {
    config.value = await bananaApi.saveConfig(cfg)
  }

  function poolFor(m: BananaMode) {
    return m === 'openai' ? openaiJobs : nativeJobs
  }

  function clearJobs() {
    const pool = poolFor(mode.value)
    pool.value.forEach(revokeJob)
    pool.value = []
  }

  /** Send one combination and write the result onto its card.
   *
   *  Status, cancellation, the abort cascade and the error branch are the
   *  runner's job — see utils/batch.ts. This is only the part that differs
   *  between the two surfaces. */
  async function runOne(
    job: BananaJob,
    promptText: string,
    combo: Omit<BananaGenerateRequest, 'prompt'>,
    jobMode: BananaMode,
    signal: AbortSignal,
  ) {
    {
      const res = jobMode === 'openai'
        ? await bananaApi.chat({
            prompt: promptText,
            model_id: combo.model_id,
            // The doc names this as the switch that turns on image output.
            modalities: ['text', 'image'],
            temperature: combo.temperature,
          } as BananaChatRequest, signal)
        : await bananaApi.generate(
            { prompt: promptText, ...combo } as BananaGenerateRequest,
            signal,
          )

      // Decode in parallel — the images of one response are independent, and
      // awaiting them one at a time would serialise what the browser can overlap.
      job.images = await Promise.all(res.images.map(async img => {
        const actual = img.image_format ?? undefined
        return {
          src: img.b64_json
            // No requested-format fallback here: this surface has no
            // output_format knob, and Gemini returns PNG by default — which is
            // what imageMime lands on when the bytes could not be sniffed.
            ? await b64ToBlobUrl(img.b64_json, imageMime(actual))
            : img.url,
          bytes: img.byte_size ?? undefined,
          actualFormat: actual,
          declaredMime: img.declared_mime ?? undefined,
          width: img.width ?? undefined,
          height: img.height ?? undefined,
        }
      }))
      job.activeIndex = 0
      job.texts = res.texts
      job.finishReasons = res.finish_reasons
      job.actualCandidates = res.candidate_count ?? undefined
      job.actualModel = res.upstream_model ?? undefined
      job.blockReason = res.block_reason ?? undefined
      job.elapsedMs = res.elapsed_ms
      job.finishedAt = Date.now()
      job.requestId = res.request_id ?? undefined
      job.promptTokens = res.prompt_tokens ?? undefined
      job.candidatesTokens = res.candidates_tokens ?? undefined
      job.totalTokens = res.total_tokens ?? undefined

      if (job.images.length) {
        job.status = 'done'
      } else {
        // A 200 with no image is a real result, not a transport failure, so the
        // reason the API gave is shown rather than a generic "failed".
        job.status = 'error'
        job.error = res.block_reason
          ? `未返回图片：${res.block_reason}`
          : '未返回图片'
      }
    }
  }

  /** Kick off a batch from the current form state. Called from the top bar, which
   *  is why every input it needs lives in this store. Concurrent batches are
   *  allowed: a second run starts while the first is still in flight. */
  async function run() {
    if (!canRun.value) return
    // Collapse to hand the viewport to the results the run is about to produce.
    paramsCollapsed.value = true
    await runMatrix(prompt.value, {
      ...matrix,
      models: [...matrix.models],
      aspectRatios: [...matrix.aspectRatios],
      imageSizes: [...matrix.imageSizes],
      modalities: [...matrix.modalities],
    }, mode.value)
  }

  async function runMatrix(promptText: string, matrixIn: BananaMatrix, jobMode: BananaMode) {
    // The OpenAI-compatible surface documents no size or ratio knobs, so its
    // batch is a single request rather than a cross product.
    const combos: Omit<BananaGenerateRequest, 'prompt'>[] = jobMode === 'openai'
      ? [{
          model_id: matrixIn.models[0] ?? OPENAI_MODELS[0].id,
          temperature: matrixIn.temperature ?? undefined,
        }]
      : buildCombos(matrixIn)
    if (!combos.length) return

    // Seed every slot as pending so the grid shows placeholders immediately.
    const seeded: BananaJob[] = combos.map(c => ({
      id: ++jobSeq,
      status: 'pending',
      mode: jobMode,
      model: c.model_id ?? config.value.model_id,
      aspectRatio: c.aspect_ratio,
      imageSize: c.image_size,
      modalities: c.response_modalities?.join(','),
      temperature: c.temperature,
      candidateCount: c.candidate_count,
      safetyThreshold: c.safety_threshold,
      images: [],
      activeIndex: 0,
    }))
    await runner.run(
      poolFor(jobMode),
      seeded,
      (job, i, signal) => runOne(job, promptText, combos[i], jobMode, signal),
      matrixIn.concurrency,
    )
  }

  return {
    config, nativeJobs, openaiJobs, configLoaded, configOpen,
    mode, prompt, matrix, paramsCollapsed,
    // Named one by one rather than spread — see the note in stores/imageGen.ts:
    // the runner has its own `run`, and spreading it would collide with this
    // store's, with only key order deciding the winner.
    generating: runner.generating,
    doneCount: runner.doneCount,
    totalCount: runner.totalCount,
    stop: runner.stop,
    stopJob: runner.stopJob,
    availableModels, totalRequests, totalImages, blockReason, canRun,
    loadConfig, updateConfig, clearJobs,
    run, runMatrix,
  }
})
