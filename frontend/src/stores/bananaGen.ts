import { defineStore } from 'pinia'
import { computed, reactive, ref } from 'vue'
import type {
  BananaConfig, BananaGenerateRequest, BananaChatRequest,
  BananaMatrix, BananaMode, BananaJob,
} from '@/types'
import * as bananaApi from '@/api/bananaGen'
import { NATIVE_MODELS, OPENAI_MODELS } from '@/utils/bananaSpec'

const DEFAULT_CONFIG: BananaConfig = {
  baseurl: '',
  api_key: '',
  model_id: 'gemini-3-pro-image-preview',
  timeout: 480,
}

/** Hard cap on retained cards, per pool. Blob URLs keep the bytes off the JS
 *  heap, but the DOM still has to render every card, so each list stays bounded
 *  independently — same arrangement as the gpt-image pools. */
const MAX_POOL = 50

export const DEFAULT_PROMPT = `深圳一日游手绘地图插画，清新可爱手绘风格，旅行手账风，地图式俯视构图（top-down map illustration），整体布局清晰有层次，色彩明亮柔和，带轻微水彩质感。

画面中展示深圳主要景点，使用卡通手绘插画表现，每个景点独立标注，并配有清晰、规范、标准简体中文文字说明（非常重要：文字必须正确、无错别字、无乱码、可读性强）。

📍 景点与文字（要求严格按以下内容生成）
世界之窗
文字：世界文化景观缩影
深圳湾公园
文字：滨海休闲好去处
大梅沙海滨公园
文字：深圳经典海滩
东部华侨城
文字：生态旅游度假区
莲花山公园
文字：俯瞰深圳城市风光
平安金融中心
文字：深圳第一高楼
华强北
文字：电子科技天堂

🎨 风格细化（提高出图质量关键）
手绘插画风格（hand-drawn illustration）
旅行手账 / 地图插画风（travel sketch map style）
线条干净柔和（clean soft lines）
色彩清新明亮（bright pastel colors）
轻微水彩渲染（light watercolor texture）
元素可爱卡通化（cute cartoon landmarks）
布局类似旅游导览图（tourist guide map layout）

🔤 中文文字优化约束（非常关键）
所有文字必须为简体中文
字体工整清晰（类似印刷体 / 手写清晰体）
禁止乱码、拼写错误、缺字、多字
每个景点文字紧贴对应图标
文字大小适中，保证可读性
不要生成无意义符号或英文替代

highly legible Chinese text, correct spelling, no garbled characters, no distorted glyphs

🖼️ 输出要求
横版 16:9
高分辨率（4K / high resolution）
适合海报或旅游宣传册展示`

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

/** Run tasks with at most `limit` in flight. Each worker pulls the next index off
 *  a shared cursor, so a slow task never blocks the others. */
async function runPool(tasks: (() => Promise<void>)[], limit: number, signal: AbortSignal) {
  let cursor = 0
  const worker = async () => {
    while (cursor < tasks.length) {
      if (signal.aborted) return
      const i = cursor++
      await tasks[i]()
    }
  }
  // Clamp: a cleared number input yields null/0, which would spawn no workers
  // and leave every job stuck on "pending".
  const workers = Math.max(1, Math.min(limit || 1, tasks.length))
  await Promise.all(Array.from({ length: workers }, worker))
}

/** Decode base64 off the main thread via the browser's own fetch/blob pipeline.
 *  Same reason as the imageGen store — a synchronous atob loop blocks for tens of
 *  ms per image, and 4K payloads here are far larger. */
async function b64ToBlobUrl(b64: string, mime: string): Promise<string> {
  const resp = await fetch(`data:${mime};base64,${b64}`)
  const blob = await resp.blob()
  return URL.createObjectURL(blob)
}

export const useBananaGenStore = defineStore('bananaGen', () => {
  const config = ref<BananaConfig>({ ...DEFAULT_CONFIG })

  // One pool per surface, capped separately, so switching tabs never discards
  // the other side's results.
  const nativeJobs = ref<BananaJob[]>([])
  const openaiJobs = ref<BananaJob[]>([])

  const generating = ref(false)
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

  const doneCount = ref(0)
  const totalCount = ref(0)

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

  // One controller per active batch, tracked in a Set so concurrent batches are
  // all reachable; stop() signals every one of them.
  const batchCtls = new Set<AbortController>()

  // One controller per job, so a single card can be stopped without touching the
  // rest of the batch. Kept outside reactive state: a controller is not data the
  // UI renders, and wrapping it in a proxy would break its internal slots.
  const jobCtls = new Map<number, AbortController>()

  function stop() {
    batchCtls.forEach(c => c.abort())
  }

  function stopJob(id: number) {
    jobCtls.get(id)?.abort()
  }

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

  function revoke(job: BananaJob) {
    job.images.forEach(img => {
      if (img.src?.startsWith('blob:')) URL.revokeObjectURL(img.src)
    })
  }

  function poolFor(m: BananaMode) {
    return m === 'openai' ? openaiJobs : nativeJobs
  }

  /** Evict oldest-first down to the cap. New cards are unshifted onto the front,
   *  so the tail is the oldest. Cards still pending or running are skipped: a
   *  concurrent batch is actively writing to those, and dropping one would make
   *  its own results vanish mid-flight. */
  function trimPool(pool: typeof nativeJobs) {
    for (let i = pool.value.length - 1; i >= 0 && pool.value.length > MAX_POOL; i--) {
      const job = pool.value[i]
      if (job.status === 'pending' || job.status === 'running') continue
      revoke(job)
      pool.value.splice(i, 1)
    }
  }

  function clearJobs() {
    const pool = poolFor(mode.value)
    pool.value.forEach(revoke)
    pool.value = []
  }

  /** Send one combination and write the result onto its card. */
  async function runOne(
    job: BananaJob,
    promptText: string,
    combo: Omit<BananaGenerateRequest, 'prompt'>,
    jobMode: BananaMode,
    batchCtl: AbortController,
  ) {
    const jobCtl = jobCtls.get(job.id)!
    // Stopped while it sat in the queue — never send the request at all.
    if (jobCtl.signal.aborted || batchCtl.signal.aborted) {
      job.status = 'cancelled'
      doneCount.value++
      return
    }

    // Stopping the batch has to cascade into each open request.
    const cascade = () => jobCtl.abort()
    batchCtl.signal.addEventListener('abort', cascade)

    job.status = 'running'
    const t0 = performance.now()
    try {
      const res = jobMode === 'openai'
        ? await bananaApi.chat({
            prompt: promptText,
            model_id: combo.model_id,
            // The doc names this as the switch that turns on image output.
            modalities: ['text', 'image'],
            temperature: combo.temperature,
          } as BananaChatRequest, jobCtl.signal)
        : await bananaApi.generate(
            { prompt: promptText, ...combo } as BananaGenerateRequest,
            jobCtl.signal,
          )

      // Decode in parallel — the images of one response are independent, and
      // awaiting them one at a time would serialise what the browser can overlap.
      job.images = await Promise.all(res.images.map(async img => {
        const actual = img.image_format ?? undefined
        // Gemini returns PNG by default, and it is the only safe guess when the
        // bytes could not be sniffed — image/undefined is undecodable.
        const sub = actual ?? 'png'
        return {
          src: img.b64_json
            ? await b64ToBlobUrl(img.b64_json, `image/${sub === 'jpg' ? 'jpeg' : sub}`)
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
    } catch (e: any) {
      // stop()/stopJob() surface here as an axios cancellation. That is a user
      // action, not a failure, so label it separately.
      if (jobCtl.signal.aborted) {
        job.status = 'cancelled'
      } else {
        job.status = 'error'
        job.error = e?.response?.data?.detail || e?.message || '生成失败'
      }
      job.elapsedMs = Math.round(performance.now() - t0)
      job.finishedAt = Date.now()
    } finally {
      batchCtl.signal.removeEventListener('abort', cascade)
      jobCtls.delete(job.id)
      doneCount.value++
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
    const pool = poolFor(jobMode)
    pool.value.unshift(...seeded)

    // Grab the reactive proxies — mutating the raw seeded objects would not
    // trigger re-renders.
    const live = pool.value.slice(0, seeded.length)

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
    totalCount.value += combos.length
    try {
      await runPool(
        combos.map((combo, i) => () => runOne(live[i], promptText, combo, jobMode, ctl)),
        matrixIn.concurrency,
        ctl.signal,
      )
    } finally {
      // Slots the pool never claimed would otherwise sit on "pending" forever.
      live.forEach(j => {
        if (j.status === 'pending') j.status = 'cancelled'
        jobCtls.delete(j.id)
      })
      batchCtls.delete(ctl)
      generating.value = batchCtls.size > 0
      trimPool(pool)
    }
  }

  return {
    config, nativeJobs, openaiJobs, generating, configLoaded, configOpen,
    mode, prompt, matrix, paramsCollapsed, doneCount, totalCount,
    availableModels, totalRequests, totalImages, blockReason, canRun,
    loadConfig, updateConfig, stop, stopJob, clearJobs,
    run, runMatrix,
  }
})
