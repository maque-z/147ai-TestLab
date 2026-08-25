import { defineStore } from 'pinia'
import { computed, reactive, ref } from 'vue'
import type {
  BananaConfig, BananaGenerateRequest, BananaChatRequest,
  BananaMatrix, BananaMode, BananaOperation, BananaJob, BananaReferenceImage, RefImage,
  BananaSafetySetting,
} from '@/types'
import * as bananaApi from '@/api/bananaGen'
import { DEFAULT_SAFETY_SETTINGS, NATIVE_MODELS, OPENAI_MODELS, supportsThinking } from '@/utils/bananaSpec'
import { b64ToBlobUrl, imageMime, revokeJob, sampleAlpha, useBatchRunner } from '@/utils/batch'
import { DEFAULT_PROMPT } from '@/utils/defaultPrompt'

const DEFAULT_CONFIG: BananaConfig = {
  baseurl: '',
  api_key: '',
  model_id: 'gemini-3.1-flash-image',
  custom_models: [],
  timeout: 480,
}

let jobSeq = 0

/** An unselected param means "let the API decide", so it still contributes
 *  exactly one row to the cross product — with the value left undefined. */
function orDefault<T>(arr: T[]): (T | undefined)[] {
  return arr.length ? arr : [undefined]
}

/** Expand the matrix into one combination per upstream request. */
function buildCombos(
  m: BananaMatrix,
  referenceImages?: BananaReferenceImage[],
  maskImage?: BananaReferenceImage,
): Omit<BananaGenerateRequest, 'prompt'>[] {
  const combos: Omit<BananaGenerateRequest, 'prompt'>[] = []
  for (const model_id of orDefault(m.models)) {
    for (const sizePair of orDefault(m.sizePairs)) {
      const [image_size, aspect_ratio] = sizePair?.split('|') ?? []
      for (const modality of orDefault(m.modalities)) {
        combos.push({
          model_id,
          aspect_ratio,
          image_size,
            // Stored joined for identity; sent as the array the doc specifies.
            response_modalities: modality ? modality.split(',') : undefined,
            temperature: m.temperature ?? undefined,
            candidate_count: m.candidateCount ?? undefined,
            safety_settings: Object.entries(m.safetySettings)
              .filter(([, threshold]) => !!threshold)
              .map(([category, threshold]) => ({ category, threshold }) as BananaSafetySetting),
            max_output_tokens: m.maxOutputTokens ?? undefined,
            stop_sequences: m.stopSequences.length ? [...m.stopSequences] : undefined,
            top_p: m.topP ?? undefined,
            top_k: m.topK ?? undefined,
            seed: m.seed ?? undefined,
            // Thinking is only valid for Gemini 3 image models. Do not let one
            // unsupported model invalidate an otherwise valid multi-model batch.
            thinking_level: m.thinkingLevel && supportsThinking(model_id ?? '') ? m.thinkingLevel : undefined,
            include_thoughts: m.includeThoughts && m.thinkingLevel && supportsThinking(model_id ?? '') ? true : undefined,
            thinking_budget: m.thinkingBudget != null && supportsThinking(model_id ?? '') ? m.thinkingBudget : undefined,
          reference_images: referenceImages?.length ? referenceImages : undefined,
          mask_image: maskImage,
        })
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
  const view = ref<'batch' | 'test'>('batch')
  const operation = ref<BananaOperation>('generate')
  const referenceImages = ref<RefImage[]>([])
  const mask = ref<Blob | null>(null)
  const prompt = ref(DEFAULT_PROMPT)
  const paramsCollapsed = ref(false)

  // Everything starts unselected except the model, which is required: it goes in
  // the URL path, so there is no "let the API decide" for it.
  const matrix = reactive<BananaMatrix>({
    models: [NATIVE_MODELS[0].id],
    sizePairs: [],
    modalities: ['TEXT,IMAGE'],
    temperature: null,
    candidateCount: null,
    safetySettings: { ...DEFAULT_SAFETY_SETTINGS },
    maxOutputTokens: null,
    stopSequences: [],
    topP: null,
    topK: null,
    seed: null,
    thinkingLevel: null,
    includeThoughts: false,
    thinkingBudget: null,
    concurrency: 50,
  })

  /** Models selectable on the current surface. The OpenAI-compatible doc names
   *  exactly one, so the two lists are not interchangeable. */
  const availableModels = computed(() => {
    const documented = mode.value === 'openai' ? OPENAI_MODELS : NATIVE_MODELS
    // Include the saved default too. Existing installations may have a gateway
    // alias saved before it was added to custom_models; hiding it would recreate
    // the dropdown/page mismatch this store is meant to prevent.
    const clean = (value: unknown) => typeof value === 'string' ? value.trim() : ''
    const customIds = mode.value === 'native'
      ? [config.value.model_id, ...(config.value.custom_models || [])]
          .map(clean)
          .filter(Boolean)
      : []
    const custom = customIds.map(id => ({
          id,
          note: '手动添加 · 文档未列出',
        }))
    const seen = new Set<string>()
    return [...documented, ...custom].filter(model => {
      const id = clean(model.id)
      if (!id || seen.has(id)) return false
      seen.add(id)
      return true
    })
  })

  /** An empty group still yields one request — the API's own default. */
  const rowCount = (arr: unknown[]) => arr.length || 1

  const totalRequests = computed(() => {
    if (mode.value === 'openai') return 1
    return rowCount(matrix.models) * rowCount(matrix.sizePairs) * rowCount(matrix.modalities)
  })

  /** candidateCount asks for more than one image per request, so the image total
   *  is not the request total. */
  const totalImages = computed(() => totalRequests.value * (matrix.candidateCount || 1))

  const blockReason = computed(() => {
    if (!prompt.value.trim()) return '请先填写提示词'
    if (mode.value === 'native' && !matrix.models.length) return '请至少选择 1 个模型'
    if (mode.value === 'openai' && operation.value === 'edit') return 'OpenAI 兼容接口不支持 Gemini 编辑模式'
    if (mode.value === 'native' && operation.value === 'edit' && !referenceImages.value.length) return '编辑模式至少需要 1 张参考图'
    return ''
  })
  const canRun = computed(() => !blockReason.value && totalRequests.value > 0)

  async function loadConfig() {
    if (configLoaded.value) return
    try {
      const loaded = await bananaApi.getConfig()
      config.value = {
        ...loaded,
        model_id: loaded.model_id?.trim() || DEFAULT_CONFIG.model_id,
        custom_models: (loaded.custom_models || [])
          .map(item => item.trim())
          .filter(Boolean),
      }
      // The first render is created before this request returns. Replace that
      // provisional selection with the saved native default once, so the config
      // drawer and the model page represent the same setting.
      if (mode.value === 'native' && config.value.model_id) {
        matrix.models = [config.value.model_id]
      }
      configLoaded.value = true
    } catch {
      // keep defaults; retried on next mount
    }
  }

  async function updateConfig(cfg: BananaConfig) {
    const saved = await bananaApi.saveConfig(cfg)
    config.value = {
      ...saved,
      model_id: saved.model_id?.trim() || DEFAULT_CONFIG.model_id,
      custom_models: (saved.custom_models || [])
        .map(item => item.trim())
        .filter(Boolean),
    }
    if (mode.value === 'native' && config.value.model_id) {
      matrix.models = [config.value.model_id]
    }
  }

  function poolFor(m: BananaMode) {
    return m === 'openai' ? openaiJobs : nativeJobs
  }

  function clearJobs() {
    const pool = poolFor(mode.value)
    const removed = pool.value.filter(job => job.operation === operation.value)
    removed.forEach(revokeJob)
    pool.value = pool.value.filter(job => job.operation !== operation.value)
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
        const src = img.b64_json
          // No requested-format fallback here: this surface has no
          // output_format knob, and Gemini returns PNG by default.
          ? await b64ToBlobUrl(img.b64_json, imageMime(actual))
          : img.url
        return {
          src,
          bytes: img.byte_size ?? undefined,
          actualFormat: actual,
          declaredMime: img.declared_mime ?? undefined,
          width: img.width ?? undefined,
          height: img.height ?? undefined,
          hasAlphaChannel: img.has_alpha_channel ?? undefined,
          hasAlpha: src ? (await sampleAlpha(src)) ?? undefined : undefined,
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
    const encoded = operation.value === 'edit' && mode.value === 'native'
      ? await Promise.all(referenceImages.value.map(item => fileToReference(item.file)))
      : undefined
    const encodedMask = operation.value === 'edit' && mode.value === 'native' && mask.value
      ? await blobToReference(mask.value, 'image/png')
      : undefined
    await runMatrix(prompt.value, {
      ...matrix,
      models: [...matrix.models],
      sizePairs: [...matrix.sizePairs],
      modalities: [...matrix.modalities],
    }, mode.value, encoded, encodedMask)
  }

  async function runMatrix(
    promptText: string,
    matrixIn: BananaMatrix,
    jobMode: BananaMode,
    refs?: BananaReferenceImage[],
    maskImage?: BananaReferenceImage,
  ) {
    // The OpenAI-compatible surface documents no size or ratio knobs, so its
    // batch is a single request rather than a cross product.
    const combos: Omit<BananaGenerateRequest, 'prompt'>[] = jobMode === 'openai'
      ? [{
          model_id: matrixIn.models[0] ?? OPENAI_MODELS[0].id,
          temperature: matrixIn.temperature ?? undefined,
        }]
      : buildCombos(matrixIn, refs, maskImage)
    if (!combos.length) return

    // Seed every slot as pending so the grid shows placeholders immediately.
    const seeded: BananaJob[] = combos.map(c => ({
      id: ++jobSeq,
      status: 'pending',
      mode: jobMode,
      operation: operation.value,
      model: c.model_id ?? config.value.model_id,
      aspectRatio: c.aspect_ratio,
      imageSize: c.image_size,
      modalities: c.response_modalities?.join(','),
      temperature: c.temperature,
      candidateCount: c.candidate_count,
      safetySettings: Object.fromEntries((c.safety_settings ?? []).map(setting => [setting.category, setting.threshold])),
      maxOutputTokens: c.max_output_tokens,
      stopSequences: c.stop_sequences,
      topP: c.top_p,
      topK: c.top_k,
      seed: c.seed,
      thinkingLevel: c.thinking_level,
      includeThoughts: c.include_thoughts,
      thinkingBudget: c.thinking_budget,
      refCount: c.reference_images?.length,
      hasMask: !!c.mask_image,
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
    mode, view, operation, referenceImages, mask, prompt, matrix, paramsCollapsed,
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

async function fileToReference(file: File): Promise<BananaReferenceImage> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('参考图读取失败'))
    reader.readAsDataURL(file)
  })
  const comma = dataUrl.indexOf(',')
  return { mime_type: file.type, data: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl }
}

async function blobToReference(blob: Blob, mimeType: string): Promise<BananaReferenceImage> {
  return fileToReference(new File([blob], 'gemini-mask.png', { type: mimeType }))
}
