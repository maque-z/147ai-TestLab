import { defineStore } from 'pinia'
import { computed, reactive, ref } from 'vue'
import type {
  ImageConfig, GenerateRequest, GenMode, ImageJob, ModelOption, ParamMatrix, RefImage,
} from '@/types'
import * as imageGenApi from '@/api/imageGen'
import { b64ToBlobUrl, imageMime, revokeJob, sampleAlpha, useBatchRunner } from '@/utils/batch'
import { DEFAULT_PROMPT } from '@/utils/defaultPrompt'
import { DEFAULT_MODEL, DOCUMENTED_MODEL_IDS, GPT_IMAGE_MODELS } from '@/utils/gptImageSpec'

/** Binary inputs for an edit batch. Present == run against /edit instead of
 *  /generate; the param matrix expands identically either way. */
export interface EditInputs {
  images: File[]
  mask: Blob | null
}

const DEFAULT_CONFIG: ImageConfig = {
  baseurl: '',
  api_key: '',
  model_id: '',
  selected_models: [],
  custom_models: [],
  timeout: 480,
}

/** The column width for a model id, mirrored so a too-long entry is refused here
 *  with a readable reason instead of as a 422 after the round trip. */
const MAX_MODEL_LEN = 100

/** Quiet period after the last chip click before the selection is written to
 *  the account. Ticking three models in a row is one save, not three. */
const PERSIST_DELAY_MS = 400

let jobSeq = 0

/** An unselected param means "let the API decide", so it still contributes
 *  exactly one row to the cross product — with the value left undefined. */
function orDefault<T>(arr: T[]): (T | undefined)[] {
  return arr.length ? arr : [undefined]
}

/** Trim, drop empties and repeats. Both model lists pass through this as they
 *  arrive, so nothing downstream has to consider a blank or a duplicate. */
function cleanList(arr: unknown): string[] {
  const out: string[] = []
  for (const raw of Array.isArray(arr) ? arr : []) {
    const id = typeof raw === 'string' ? raw.trim() : ''
    if (id && !out.includes(id)) out.push(id)
  }
  return out
}

/** The server's row, made safe to use.
 *
 *  custom_models loses any documented id: the startup backfill copies each
 *  account's legacy model_id in there regardless of what it was, and a
 *  documented one would otherwise be offered twice. Dropping it here means the
 *  next save writes the list back clean. */
function normalizeConfig(raw: ImageConfig): ImageConfig {
  return {
    ...raw,
    model_id: raw.model_id ?? '',
    selected_models: cleanList(raw.selected_models),
    custom_models: cleanList(raw.custom_models).filter(id => !DOCUMENTED_MODEL_IDS.has(id)),
  }
}

/** Expand the matrix into one combination per upstream request.
 *  output_compression only applies to jpeg/webp, so png rows omit it — otherwise
 *  every compression value would produce an identical duplicate png request.
 *
 *  input_fidelity is an edits-only param, so on /generate it collapses to a
 *  single undefined row rather than multiplying the batch by values the endpoint
 *  would silently drop.
 *
 *  background is expanded unconditionally, including transparent against jpeg.
 *  The docs say jpeg cannot carry transparency, and it is sent anyway, because
 *  what the API does with an impossible combination is the finding.
 *
 *  The model is the outermost loop, so a multi-model batch lands in the grid
 *  grouped by model — the comparison the user set up is then adjacent cards.
 */
function buildCombos(m: ParamMatrix, mode: GenMode): Omit<GenerateRequest, 'prompt'>[] {
  const combos: Omit<GenerateRequest, 'prompt'>[] = []
  const fidelities = mode === 'edit' ? orDefault(m.inputFidelities) : [undefined]
  for (const model_id of orDefault(m.models)) {
    for (const size of orDefault(m.sizes)) {
      for (const quality of orDefault(m.qualities)) {
        for (const output_format of orDefault(m.formats)) {
          for (const moderation of orDefault(m.moderations)) {
            for (const background of orDefault(m.backgrounds)) {
              for (const input_fidelity of fidelities) {
                combos.push({
                  model_id,
                  size,
                  quality,
                  output_format,
                  moderation,
                  background,
                  input_fidelity,
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

  // Everything starts unselected except the model, which is required: there is
  // no "let the API decide" for it. The default here is provisional — loadConfig
  // replaces it with whatever the account saved, so the panel opens where it was
  // left rather than on this build's idea of a good model.
  const matrix = reactive<ParamMatrix>({
    models: [DEFAULT_MODEL],
    sizes: [],
    qualities: [],
    formats: [],
    moderations: [],
    backgrounds: [],
    inputFidelities: [],
    n: 1,
    output_compression: null,
    concurrency: 50,
  })

  /** Every model the panel offers: the documented list, then the account's own
   *  additions, then anything ticked that is in neither — a legacy value that
   *  predates custom_models, kept visible so the selection never refers to a
   *  chip that is not there. */
  const availableModels = computed<ModelOption[]>(() => {
    const out: ModelOption[] = GPT_IMAGE_MODELS.map(m => ({ id: m.id, note: m.note, custom: false }))
    const seen = new Set<string>(DOCUMENTED_MODEL_IDS)
    for (const id of [...config.value.custom_models, ...matrix.models]) {
      if (seen.has(id)) continue
      seen.add(id)
      out.push({ id, note: '手动添加 · 文档未列出', custom: true })
    }
    return out
  })

  /** An empty group still yields one request — the API's own default. */
  const rowCount = (arr: unknown[]) => arr.length || 1
  /** Clearing the number input yields null, which would make the counts NaN. */
  const perRequest = computed(() => matrix.n || 1)

  const totalRequests = computed(() =>
    rowCount(matrix.models) *
    rowCount(matrix.sizes) * rowCount(matrix.qualities) *
    rowCount(matrix.formats) * rowCount(matrix.moderations) *
    rowCount(matrix.backgrounds) *
    // Mirrors buildCombos: this group only multiplies the batch on /edit, so the
    // count in the header matches the number of requests actually sent.
    (mode.value === 'edit' ? rowCount(matrix.inputFidelities) : 1)
  )
  const totalImages = computed(() => totalRequests.value * perRequest.value)

  /** Why the run button is disabled, surfaced as its tooltip rather than left for
   *  the user to guess. */
  const blockReason = computed(() => {
    if (!matrix.models.length) return '请至少选择 1 个模型'
    if (!prompt.value.trim()) return '请先填写提示词'
    if (mode.value === 'edit' && !refImages.value.length) return '编辑模式至少需要 1 张参考图'
    return ''
  })
  const canRun = computed(() => !blockReason.value && totalRequests.value > 0)

  async function loadConfig() {
    if (configLoaded.value) return
    try {
      config.value = normalizeConfig(await imageGenApi.getConfig())
      // Replace the provisional default with what the account saved. A fresh
      // account has nothing saved yet and keeps the default until its first click.
      if (config.value.selected_models.length) {
        matrix.models = [...config.value.selected_models]
      }
      configLoaded.value = true
    } catch {
      // keep defaults; retried on next mount
    }
  }

  /** The connection drawer's save. Partial on purpose — it carries the fields
   *  the drawer edits and nothing else, so it can never overwrite a model
   *  selection made since the drawer was opened. */
  async function updateConfig(patch: Partial<ImageConfig>) {
    config.value = normalizeConfig(await imageGenApi.saveConfig(patch))
  }

  // ---- Model selection, saved to the account ----

  /** Why the last write of the selection failed, for the panel to show; cleared
   *  by the next success. Kept as state rather than thrown: the click that
   *  caused it has long since returned. */
  const modelSaveError = ref('')
  let persistTimer: ReturnType<typeof setTimeout> | null = null

  function schedulePersistModels() {
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => { void persistModels() }, PERSIST_DELAY_MS)
  }

  /** Write the selection and the custom list to the account. A partial PUT —
   *  the backend applies only the fields sent — so a stale baseurl or key can
   *  never ride along with a chip click. */
  async function persistModels() {
    persistTimer = null
    try {
      const saved = await imageGenApi.saveConfig({
        selected_models: [...matrix.models],
        custom_models: [...config.value.custom_models],
      })
      // The row comes back whole, but the two lists are not taken from it: a
      // chip clicked or an id added while this request was in flight is newer
      // than the response, and its own save is already scheduled. Only the
      // connection fields are refreshed from the server.
      const fresh = normalizeConfig(saved)
      config.value = {
        ...fresh,
        selected_models: [...matrix.models],
        custom_models: config.value.custom_models,
      }
      modelSaveError.value = ''
    } catch (e: any) {
      modelSaveError.value = e?.response?.data?.detail || e?.message || '保存失败'
    }
  }

  /** Every available model is already ticked. Drives the label of the one button
   *  that fills the group and empties it again — same arrangement as the test
   *  panel's dimension chips. */
  const allModelsSelected = computed(() =>
    availableModels.value.length > 0 &&
    matrix.models.length === availableModels.value.length,
  )

  /** Tick or untick one model.
   *
   *  Unlike the Gemini panel this one does let the last entry go: an empty model
   *  group is simply a batch that cannot be sent, which blockReason says outright
   *  and the 全选 button undoes in one click. Refusing the untick instead would
   *  leave no way to start over from a single model. */
  function toggleModel(id: string) {
    const i = matrix.models.indexOf(id)
    if (i >= 0) matrix.models.splice(i, 1)
    else matrix.models.push(id)
    schedulePersistModels()
  }

  /** Fill the group, or empty it when it is already full. */
  function toggleAllModels() {
    matrix.models = allModelsSelected.value
      ? []
      : availableModels.value.map(m => m.id)
    schedulePersistModels()
  }
  /** Add a hand-typed id to the account and tick it. Returns the reason it was
   *  refused, or '' when added. Only what could not possibly be meant is refused
   *  — the id is sent verbatim, and an odd one is a probe like any other. */
  function addCustomModel(raw: string): string {
    const id = raw.trim()
    if (!id) return ''
    if (/\s/.test(id)) return '模型 ID 不能包含空格'
    if (id.length > MAX_MODEL_LEN) return `模型 ID 超过 ${MAX_MODEL_LEN} 字符`
    if (!DOCUMENTED_MODEL_IDS.has(id) && !config.value.custom_models.includes(id)) {
      config.value.custom_models.push(id)
    }
    if (!matrix.models.includes(id)) matrix.models.push(id)
    schedulePersistModels()
    return ''
  }

  /** Forget a hand-added id, unticked along with it. If it was the only model
   *  ticked the group is left empty rather than quietly filled with a default:
   *  which model to use next is the user's call, and blockReason is what stops
   *  the batch until they make it. */
  function removeCustomModel(id: string) {
    config.value.custom_models = config.value.custom_models.filter(m => m !== id)
    const i = matrix.models.indexOf(id)
    if (i >= 0) matrix.models.splice(i, 1)
    schedulePersistModels()
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
        models: [...matrix.models],
        sizes: [...matrix.sizes],
        qualities: [...matrix.qualities],
        formats: [...matrix.formats],
        moderations: [...matrix.moderations],
        backgrounds: [...matrix.backgrounds],
        inputFidelities: [...matrix.inputFidelities],
        n: perRequest.value,
      },
      mode.value === 'edit'
        ? { images: refImages.value.map(r => r.file), mask: mask.value }
        : undefined,
    )
  }

  async function generateMatrix(promptText: string, matrixIn: ParamMatrix, edit?: EditInputs) {
    const jobMode: GenMode = edit ? 'edit' : 'generate'
    const combos = buildCombos(matrixIn, jobMode)
    if (!combos.length) return

    // Seed every slot as pending so the grid shows placeholders immediately
    const seeded: ImageJob[] = combos.map(c => ({
      id: ++jobSeq,
      status: 'pending',
      mode: jobMode,
      size: c.size,
      quality: c.quality,
      format: c.output_format,
      moderation: c.moderation,
      background: c.background,
      inputFidelity: c.input_fidelity,
      n: c.n ?? 1,
      compression: c.output_compression,
      // From the combination, not the config: the batch varies it now. The
      // legacy field is only reached by a matrix with no model, which canRun
      // already refuses.
      model: c.model_id ?? config.value.model_id,
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
          const src = img.b64_json
            // Falls back to the requested format, then png — see imageMime.
            ? await b64ToBlobUrl(img.b64_json, imageMime(actual, job.format))
            : img.url
          return {
            src,
            bytes: img.byte_size ?? undefined,
            actualFormat: actual,
            revisedPrompt: img.revised_prompt ?? undefined,
            // Only sampled where a background was actually requested: with no
            // request there is no claim to check, and this costs a decode per
            // image across a batch of up to 50.
            hasAlpha: combo.background && src
              ? (await sampleAlpha(src)) ?? undefined
              : undefined,
          }
        }))
        job.activeIndex = 0
        job.declaredFormat = res.declared_format ?? undefined
        job.declaredBackground = res.declared_background ?? undefined
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
    availableModels, modelSaveError, allModelsSelected,
    toggleModel, toggleAllModels, addCustomModel, removeCustomModel,
    loadConfig, updateConfig, run, generateMatrix, clearJobs,
  }
})
