import { defineStore } from 'pinia'
import { computed, reactive, ref } from 'vue'
import type {
  ImageConfig, GenerateRequest, GenMode, ImageJob, ParamMatrix, RefImage,
} from '@/types'
import * as imageGenApi from '@/api/imageGen'

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

/** Hard cap on retained cards, applied per pool rather than across all of them.
 *  Blob URLs keep the bytes off the JS heap, but the DOM still has to render
 *  every card, so each list stays bounded independently — a wide generate batch
 *  can no longer evict the edit results the user was comparing against. */
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

function b64ToBlobUrl(b64: string, mime: string): string {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return URL.createObjectURL(new Blob([bytes], { type: mime }))
}

export const useImageGenStore = defineStore('imageGen', () => {
  const config = ref<ImageConfig>({ ...DEFAULT_CONFIG })

  // One pool per endpoint, each capped separately. Kept apart so the two tabs
  // do not compete for the same 50 slots: switching to 编辑 must not mean the
  // 生成 results are already gone.
  const generateJobs = ref<ImageJob[]>([])
  const editJobs = ref<ImageJob[]>([])

  const generating = ref(false)
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
    concurrency: 60,
  })

  // Progress of the current batch only. Counting the whole list would show the
  // bar pre-filled, since jobs from earlier batches are already finished.
  const doneCount = ref(0)
  const totalCount = ref(0)

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

  /** The pool a given endpoint's cards live in. */
  function poolFor(m: GenMode) {
    return m === 'edit' ? editJobs : generateJobs
  }

  /** Evict oldest-first down to the cap.
   *
   *  New cards are unshifted onto the front, so the tail is the oldest. Cards
   *  still pending or running are skipped rather than evicted: a concurrent
   *  batch is actively writing to those, and dropping one would make its own
   *  results vanish from under it mid-flight. That can briefly leave a pool
   *  above the cap, which is the better trade.
   */
  function trimPool(pool: typeof generateJobs) {
    for (let i = pool.value.length - 1; i >= 0 && pool.value.length > MAX_POOL; i--) {
      const job = pool.value[i]
      if (job.status === 'pending' || job.status === 'running') continue
      revoke(job)
      pool.value.splice(i, 1)
    }
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
    // Accumulate: each concurrent batch adds to the running total so the
    // top-bar progress covers all active batches, not just the latest.
    totalCount.value += combos.length
    try {
      await runPool(
        combos.map((combo, i) => async () => {
          const job = live[i]
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
            const req = { prompt: promptText, ...combo } as GenerateRequest
            // Each combination is a separate upstream call, so an edit batch
            // re-uploads its reference images once per combination — there is no
            // way around that short of the Files API, which gateways rarely proxy.
            const res = edit
              ? await imageGenApi.edit(req, edit.images, edit.mask, jobCtl.signal)
              : await imageGenApi.generate(req, jobCtl.signal)

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
        matrixIn.concurrency,
        ctl.signal
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

  /** Clear only the active tab's pool. Running batches are untouched. */
  function clearJobs() {
    const pool = poolFor(mode.value)
    pool.value.forEach(revoke)
    pool.value = []
  }

  return {
    config, generateJobs, editJobs, generating, configLoaded, configOpen,
    mode, view, prompt, refImages, mask, matrix, paramsCollapsed,
    doneCount, totalCount,
    perRequest, totalRequests, totalImages, blockReason, canRun,
    loadConfig, updateConfig, run, generateMatrix, stop, stopJob, clearJobs,
  }
})
