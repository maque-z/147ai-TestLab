import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type {
  TestCase, TestResult, TestLogEntry, TestVerdict, TestDimension,
  GenerateRequest, GenerateResponse, GeneratedImage, ImageDataKind,
} from '@/types'
import * as imageGenApi from '@/api/imageGen'
import { useImageGenStore } from '@/stores/imageGen'
import { b64ToBlobUrl, runPool, sampleAlpha } from '@/utils/batch'
import {
  detectVendor, aggregateVendor, describeDataKind, describeC2pa, summarizeC2pa,
} from '@/utils/vendor'
import { DEFAULT_PROMPT } from '@/utils/defaultPrompt'
import {
  DEFAULT_MODEL, EXTENDED_QUALITY, QUALITY_TIERS, supportsExtendedQuality,
} from '@/utils/gptImageSpec'

// ─── Test suite definition ──────────────────────────────────────────────────

const EDIT_PROMPT = '加上太阳'

/** Exported so the panels label themselves from the same number the pool runs
 *  at — two copies of this drifted apart once already. */
export const CONCURRENCY = 50

/** Sizes to probe — one from each resolution tier, covering both orientations. */
const TEST_SIZES = [
  '1024x1024',
  '1536x1024',
  '1024x1536',
  '2048x2048',
  '2048x1152',
  '3840x2160',
]

function buildTestCases(): TestCase[] {
  const cases: TestCase[] = []

  // ---- size ----
  for (const size of TEST_SIZES) {
    cases.push({
      id: `size-${size}`,
      label: `size = ${size.replace('x', '×')}`,
      dimension: 'size',
      req: { size },
    })
  }

  // ---- quality ----
  // All five tiers. xhigh and max arrived with gpt-image-2.5 on 2026-09-08; the
  // guide says earlier models stop at high, so on those two probes against an
  // older model the answer being looked for is the refusal itself — see
  // expectsRefusal.
  for (const quality of QUALITY_TIERS) {
    cases.push({
      id: `quality-${quality}`,
      label: `quality = ${quality}${EXTENDED_QUALITY.has(quality) ? '（2.5 新增）' : ''}`,
      dimension: 'quality',
      req: { quality },
    })
  }

  // ---- output_format ----
  for (const fmt of ['png', 'jpeg', 'webp'] as const) {
    cases.push({
      id: `format-${fmt}`,
      label: `output_format = ${fmt}`,
      dimension: 'format',
      req: { output_format: fmt },
    })
  }

  // ---- output_compression (jpeg locked) ----
  for (const comp of [0, 50, 100] as const) {
    cases.push({
      id: `comp-${comp}`,
      label: `output_compression = ${comp}（jpeg）`,
      dimension: 'compression',
      req: { output_format: 'jpeg', output_compression: comp },
    })
  }

  // ---- n: test whether the gateway actually returns 3 images when asked. ----
  cases.push({
    id: `n-3`,
    label: `n = 3`,
    dimension: 'n',
    req: { n: 3, size: '1024x1024', quality: 'low' },
  })

  // ---- background ----
  // Transparency went to preview for gpt-image-2 on 2026-08-20 and is a listed
  // capability of both gpt-image-2.5 models, so this group checks something
  // still new. The verdict comes from sampling the decoded pixels, not from
  // anything the API claims — the announcement thread itself carries a report
  // of requested transparency arriving as a rendered checkerboard instead of
  // real alpha.
  cases.push({
    id: 'bg-transparent-png',
    label: 'background = transparent（png）',
    dimension: 'background',
    req: { background: 'transparent', output_format: 'png' },
  })
  cases.push({
    id: 'bg-transparent-webp',
    label: 'background = transparent（webp）',
    dimension: 'background',
    req: { background: 'transparent', output_format: 'webp' },
  })
  // Control: proves the alpha sampling can distinguish, rather than reporting
  // "transparent" for everything.
  cases.push({
    id: 'bg-opaque-png',
    label: 'background = opaque（png）',
    dimension: 'background',
    req: { background: 'opaque', output_format: 'png' },
  })
  // Impossible by construction — jpeg has no alpha channel. Sent to find out
  // whether the API refuses it or quietly returns an opaque image, which the
  // published reference does not say.
  cases.push({
    id: 'bg-transparent-jpeg',
    label: 'background = transparent（jpeg，越界探针）',
    dimension: 'background',
    req: { background: 'transparent', output_format: 'jpeg' },
    expectRefusal: true,
  })

  // ---- edit endpoint: fixed prompt, no extra params ----
  cases.push({
    id: 'edit-seed',
    label: '编辑端点（spring.jpg + 加上太阳）',
    dimension: 'edit',
    req: {},
    isEdit: true,
  })

  return cases
}

/** How many probes the suite runs per model. Derived, not written down: the
 *  hand-maintained number was wrong by two for several commits after a case was
 *  removed, and it is quoted in the UI as the credit the run will spend. */
export const TEST_CASE_COUNT = buildTestCases().length

/** One checkbox per dimension in the panel. Derived from the case list itself so
 *  labels, counts and order can never drift from what actually runs. */
export const DIMENSION_OPTIONS = (() => {
  const labels: Record<TestDimension, string> = {
    size: 'size 尺寸',
    quality: 'quality 质量',
    format: 'output_format 格式',
    compression: 'compression 压缩',
    n: 'n 多图',
    background: 'background 透明度',
    edit: '编辑端点',
  }
  const all = buildTestCases()
  const order: TestDimension[] = []
  for (const c of all) if (!order.includes(c.dimension)) order.push(c.dimension)
  return order.map(key => ({
    key,
    label: labels[key],
    count: all.filter(c => c.dimension === key).length,
  }))
})()

/** Cards retained. A full suite is TEST_CASE_COUNT cards per model, and the
 *  panel's model list runs to six documented ids plus custom ones, so this has
 *  to hold a few complete runs' worth. run() clears first, so in practice it is
 *  a guard rather than a live eviction path. */
const MAX_RESULTS = 200

/** Probes with no right answer to score, so a refusal is recorded rather than
 *  failed: the transparent-jpeg combination (impossible by construction), and
 *  xhigh/max sent to a model whose docs stop at high. A custom id is unknown
 *  territory, so nothing is expected of it and a refusal there is a plain fail
 *  — the body is readable in the raw viewer either way. */
function expectsRefusal(c: TestCase, model: string): boolean {
  if (c.expectRefusal) return true
  if (c.dimension === 'quality' && c.req.quality && EXTENDED_QUALITY.has(c.req.quality)) {
    return supportsExtendedQuality(model) === false
  }
  return false
}

/** Every case runs once per model, so a result needs both to be addressed. */
function resultKey(model: string, caseId: string) {
  return `${model}|${caseId}`
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function pad(n: number) { return String(n).padStart(2, '0') }

function nowTs() {
  const d = new Date()
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function measureImage(src: string): Promise<{ w: number; h: number } | null> {
  return new Promise(resolve => {
    const img = new Image()
    img.onload  = () => resolve({ w: img.naturalWidth, h: img.naturalHeight })
    img.onerror = () => resolve(null)
    img.src = src
  })
}

/** Parse "1024x1024" → [1024, 1024], tolerates both "x" and "×". */
function parseSize(s: string): [number, number] | null {
  const m = s.match(/^(\d+)[x×](\d+)$/i)
  if (!m) return null
  return [parseInt(m[1], 10), parseInt(m[2], 10)]
}

// ─── Per-result evaluation (called while result data is fresh) ───────────────

function evaluate(
  c: TestCase,
  model: string,
  res: GenerateResponse,
  img: GeneratedImage | undefined,
  dims: { w: number; h: number } | null,
  hasAlpha: boolean | null,
): { verdict: TestVerdict; detail: string } {
  switch (c.dimension) {

    case 'size': {
      if (!dims) return { verdict: 'fail', detail: '无法读取图片尺寸' }
      const expected = parseSize(c.req.size!)
      if (!expected) return { verdict: 'fail', detail: `无法解析请求尺寸 ${c.req.size}` }
      const actual = `${dims.w}×${dims.h}`
      const pass = dims.w === expected[0] && dims.h === expected[1]
      return {
        verdict: pass ? 'pass' : 'fail',
        detail: `请求 ${c.req.size!.replace('x', '×')} → 实际 ${actual}`,
      }
    }

    case 'quality': {
      // Tokens are the best proxy: each tier should cost at least as much as
      // the one below it. Recorded here, judged per model in post-processing.
      const out = res.output_tokens ?? res.input_tokens ?? null
      // A tier the docs do not list for this model, accepted anyway: worth
      // saying, since the tokens then tell whether it was honoured or clamped.
      const undocumented = c.req.quality && EXTENDED_QUALITY.has(c.req.quality)
        && supportsExtendedQuality(model) === false
      return {
        verdict: 'info',
        detail: `output_tokens = ${out ?? '未知'}${undocumented ? '（文档未为该模型列出此档位，API 仍接受）' : ''}`,
      }
    }

    case 'format': {
      const requested = c.req.output_format!
      const actual = img?.image_format
      // No bytes to sniff - a link the backend could not download. The API's
      // declared format is a claim, not a measurement, so nothing is scored.
      if (!actual) {
        const why = img?.fetch_error ? `（${img.fetch_error}）` : ''
        return { verdict: 'info', detail: `请求 ${requested} → 字节不可得，无法验证${why}` }
      }
      const pass = actual === requested || (requested === 'jpeg' && actual === 'jpg')
      return {
        verdict: pass ? 'pass' : 'fail',
        detail: `请求 ${requested} → magic bytes: ${actual}`,
      }
    }

    case 'compression': {
      // Size comparison happens in post-processing; record bytes for now.
      const kb = img?.byte_size ? `${(img.byte_size / 1024).toFixed(0)} KB` : '? KB'
      return { verdict: 'info', detail: `compression=${c.req.output_compression} → ${kb}` }
    }

    case 'n': {
      // The one param with a directly countable answer: how many images came
      // back. No inference needed, so this is a hard pass/fail.
      const want = c.req.n!
      const got  = res.images.length
      return {
        verdict: got === want ? 'pass' : 'fail',
        detail: `请求 n=${want} → 实际返回 ${got} 张`,
      }
    }

    case 'edit': {
      const ok = !!(img?.b64_json || img?.url)
      return { verdict: ok ? 'pass' : 'fail', detail: ok ? '编辑端点返回图片 ✓' : '未返回图片' }
    }

    case 'background': {
      const want = c.req.background!
      const fmt = c.req.output_format ?? '?'
      // The jpeg probe has no correct outcome to score against — reaching this
      // point at all means the API accepted a combination it had no way to
      // honour, which is recorded rather than judged.
      if (c.expectRefusal) {
        const note = hasAlpha === null ? '无法采样'
          : hasAlpha ? '竟然含透明像素' : '返回不透明图'
        return { verdict: 'info', detail: `${want}+${fmt} 未被拒绝 → ${note}` }
      }
      if (hasAlpha === null) {
        return { verdict: 'info', detail: `${want}+${fmt} → 无法采样 alpha` }
      }
      const wantAlpha = want === 'transparent'
      return {
        verdict: hasAlpha === wantAlpha ? 'pass' : 'fail',
        detail: `请求 ${want}（${fmt}） → 实际${hasAlpha ? '透明' : '不透明'}`,
      }
    }
  }
}

// ─── Store ───────────────────────────────────────────────────────────────────

export const useApiTestStore = defineStore('apiTest', () => {
  const imageGen = useImageGenStore()

  const logs    = ref<TestLogEntry[]>([])
  const results = ref<TestResult[]>([])
  const running = ref(false)
  const summary = ref('')
  /** Which dimensions the next run will probe. Defaults to everything; the
   *  panel renders one checkbox per entry. */
  const selectedDims = ref<TestDimension[]>(DIMENSION_OPTIONS.map(o => o.key))

  /** The models the suite runs against — whatever the parameter panel has
   *  ticked. Every probe goes out once per model, all concurrently, so models
   *  behind the same gateway are compared on identical requests. The fallback
   *  is unreachable while the panel keeps at least one model ticked; it exists
   *  so this store never sends a request with no model. */
  const models = computed(() =>
    imageGen.matrix.models.length ? [...imageGen.matrix.models] : [DEFAULT_MODEL],
  )

  /** How many probes the current selection amounts to, per model. */
  const selectedCount = computed(() =>
    buildTestCases().filter(c => selectedDims.value.includes(c.dimension)).length,
  )

  /** Requests the next run will actually send: probes × models. Quoted in the
   *  header and on the start button as the credit the run will spend. */
  const plannedCount = computed(() => selectedCount.value * models.value.length)

  let logSeq = 0
  let ctl: AbortController | null = null

  function addLog(level: TestLogEntry['level'], text: string) {
    logs.value.push({ id: logSeq++, ts: nowTs(), level, text })
  }

  /** Request context for the body-shape checks in detectVendor: revised_prompt
   *  is legitimate on dall-e-3, and a "revised" prompt equal to the one sent
   *  is a gateway filling the field in. */
  function vendorCtx(model: string, prompt: string) {
    return { model, prompt }
  }

  const passCount = computed(
    () => results.value.filter(r => r.verdict === 'pass').length,
  )
  const failCount = computed(
    () => results.value.filter(r => r.verdict === 'fail').length,
  )
  const doneCount = computed(
    () => results.value.filter(r => r.status === 'done' || r.status === 'error' || r.status === 'cancelled').length,
  )
  const totalCount = computed(() => results.value.length)

  function stop() {
    ctl?.abort()
  }

  // Revoke blob URLs when the results are cleared.
  function clear() {
    results.value.forEach(r => { if (r.src?.startsWith('blob:')) URL.revokeObjectURL(r.src) })
    results.value = []
    logs.value = []
    summary.value = ''
  }

  function trimResults() {
    if (results.value.length <= MAX_RESULTS) return
    const excess = results.value.splice(MAX_RESULTS)
    excess.forEach(r => { if (r.src?.startsWith('blob:')) URL.revokeObjectURL(r.src) })
  }

  async function run() {
    if (running.value) return

    running.value = true
    clear()
    ctl = new AbortController()
    try {
      await runSuite(ctl.signal)
    } finally {
      // Stopping makes the pool's workers return without claiming the remaining
      // tasks, so those cards would sit on "等待中…" forever and doneCount would
      // never reach totalCount. Same sweep as imageGen.ts does for its pools.
      results.value.forEach(r => {
        if (r.status === 'pending') r.status = 'cancelled'
      })
      // In a finally because a throw anywhere in the suite would otherwise wedge
      // the panel for good: running stays true, so the 开始 button is v-if'd away
      // and 停止 is left aborting a controller nothing is listening to.
      running.value = false
      ctl = null
    }
  }

  /** The suite itself. Split out so run() owns the running/ctl lifecycle and a
   *  failure in here cannot leave the panel stuck. */
  async function runSuite(signal: AbortSignal) {
    const cases = buildTestCases().filter(c => selectedDims.value.includes(c.dimension))
    if (!cases.length) {
      addLog('warn', '⚠ 未勾选任何检测项')
      return
    }
    const runModels = models.value
    const multi = runModels.length > 1
    /** Log prefix naming the model — only when there is more than one to tell apart. */
    const tag = (model: string) => (multi ? `[${model}] ` : '')

    // Grouped by model, cases in suite order within each: the grid then reads
    // as one block per model, and post-processing walks each block on its own.
    results.value = runModels.flatMap(model =>
      cases.map(c => ({ key: resultKey(model, c.id), model, case: c, status: 'pending' as const })),
    )

    const total = results.value.length
    addLog('info', `▶ 开始 gpt-image 参数兼容性测试 · 模型: ${runModels.join(' / ')}`)
    addLog('info', multi
      ? `共 ${total} 个探测（${cases.length} 项 × ${runModels.length} 个模型） · 并发 ${CONCURRENCY}`
      : `共 ${total} 个探测 · 并发 ${CONCURRENCY}`)
    addLog('info', `生成 Prompt: "${DEFAULT_PROMPT.slice(0, 30)}…" | 编辑 Prompt: "${EDIT_PROMPT}"`)
    addLog('rule', '')

    // Load the seed image for the edit probe — only when one is selected.
    let seedFile: File | null = null
    if (cases.some(c => c.isEdit)) {
      try {
        const resp = await fetch('/spring.jpg')
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        const blob = await resp.blob()
        seedFile = new File([blob], 'spring.jpg', { type: 'image/jpeg' })
        addLog('info', `参考图 spring.jpg 已加载 (${(blob.size / 1024).toFixed(0)} KB · 350×229)`)
      } catch (e: any) {
        addLog('warn', `⚠ spring.jpg 加载失败，编辑探测将跳过: ${e?.message ?? e}`)
      }
    }

    const t0 = performance.now()

    await runPool(
      results.value.map((r, i) => async () => {
        const c = r.case
        const model = r.model

        if (signal.aborted) {
          results.value[i].status = 'cancelled'
          return
        }

        results.value[i].status = 'running'
        const caseT0 = performance.now()
        // Built outside the try so the error branch can hand the prompt to the
        // vendor check as well - a refusal body is evidence too.
        const req: GenerateRequest = c.isEdit
          ? { prompt: EDIT_PROMPT, model_id: model, ...c.req }
          : { prompt: DEFAULT_PROMPT, model_id: model, quality: 'low', size: '1024x1024', ...c.req }

        try {
          let res: GenerateResponse

          if (c.isEdit) {
            if (!seedFile) {
              results.value[i].status = 'cancelled'
              addLog('warn', `⚠ ${tag(model)}${c.label} — 跳过（参考图未加载）`)
              return
            }
            res = await imageGenApi.edit(req, [seedFile], null, signal)
          } else {
            res = await imageGenApi.generate(req, signal)
          }

          const elapsed = Math.round(performance.now() - caseT0)
          const imgData = res.images[0]

          // How the bytes arrived, across every image of the response. The
          // reference fixes GPT image models to b64_json, so this is evidence
          // about the gateway and is kept per card rather than only in the log.
          const kinds = Array.from(new Set(res.images.map(im => im.data_kind ?? 'none')))
          const dataKind: TestResult['dataKind'] =
            kinds.length > 1 ? 'mixed' : (kinds[0] as ImageDataKind | undefined) ?? 'none'

          // Judged once, here, with the request context the body checks need.
          const vendor = res.upstream
            ? detectVendor(res.upstream, vendorCtx(model, req.prompt))
            : undefined

          // Build blob URL
          let src: string | undefined
          if (imgData?.b64_json) {
            const fmt = imgData.image_format ?? 'png'
            src = await b64ToBlobUrl(imgData.b64_json, `image/${fmt === 'jpg' ? 'jpeg' : fmt}`)
          } else if (imgData?.url) {
            src = imgData.url
          }

          // Decode dimensions
          const dims = src ? await measureImage(src) : null

          // Only the background probes make a claim about transparency, so only
          // they pay for the extra decode.
          const hasAlpha = (src && c.dimension === 'background')
            ? await sampleAlpha(src)
            : null

          const { verdict, detail } = evaluate(c, model, res, imgData, dims, hasAlpha)

          Object.assign(results.value[i], {
            status:        'done',
            verdict,
            detail,
            src,
            bytes:         imgData?.byte_size ?? undefined,
            actualFormat:  imgData?.image_format ?? undefined,
            declaredFormat: res.declared_format ?? undefined,
            imageCount:    res.images.length,
            width:         dims?.w,
            height:        dims?.h,
            hasAlpha:      hasAlpha ?? undefined,
            elapsedMs:     elapsed,
            inputTokens:   res.input_tokens ?? undefined,
            outputTokens:  res.output_tokens ?? undefined,
            actualModel:   res.upstream_model ?? undefined,
            upstream:      res.upstream ?? undefined,
            dataKind,
            dataField:     imgData?.data_field ?? undefined,
            sourceUrl:     imgData?.source_url ?? undefined,
            fetchError:    imgData?.fetch_error ?? undefined,
            // Read off the image bytes server-side. The first image is the one
            // the card renders and the one the other measurements describe, so
            // it is the one whose manifest is reported.
            c2pa:          imgData?.c2pa,
            vendor,
          } as Partial<TestResult>)

          const icon = verdict === 'pass' ? '✓' : verdict === 'fail' ? '✗' : '·'
          const lvl  = verdict === 'fail' ? 'error' : verdict === 'pass' ? 'ok' : 'info'
          addLog(lvl, `${icon} ${tag(model)}${c.label}  ${detail}  · ${describeDataKind(results.value[i])}  (${elapsed}ms)`)

        } catch (e: any) {
          const elapsed = Math.round(performance.now() - caseT0)
          const errMsg  = e?.response?.data?.detail || e?.message || '请求失败'
          const is429   = e?.response?.status === 429

          // A refusal probe that gets refused has done its job — that is the
          // answer it was sent to get, not a failure of the API. Recording the
          // upstream's own wording matters here: it is the only place this tool
          // learns what an unsupported combination actually returns.
          const refused = expectsRefusal(c, model) && !is429 && !signal.aborted

          Object.assign(results.value[i], {
            status:    signal.aborted ? 'cancelled' : 'error',
            verdict:   (is429 ? 'ratelimit' : refused ? 'info' : 'fail') as TestVerdict,
            detail:    is429 ? `限流 429 — 稍后重试`
                     : refused ? `API 拒绝该组合 → ${errMsg}`
                     : errMsg,
            elapsedMs: elapsed,
            error:     errMsg,
            // Failures that got an HTTP response carry the raw exchange too —
            // what a refusal actually looks like on the wire is the finding.
            upstream:  e?.upstream ?? undefined,
            // And the refusal body is origin evidence as well: Azure's
            // contentFilter code, or a Codex bridge blaming the
            // image_generation tool for n>1.
            vendor:    e?.upstream ? detectVendor(e.upstream, vendorCtx(model, req.prompt)) : undefined,
          } as Partial<TestResult>)

          const label = is429 ? `⚡ ${tag(model)}${c.label}  限流 429`
                      : refused ? `· ${tag(model)}${c.label}  API 拒绝 → ${errMsg}`
                      : `✗ ${tag(model)}${c.label}  ${errMsg}`
          addLog(is429 || refused ? 'warn' : 'error', `${label}  (${elapsed}ms)`)
        }
      }),
      CONCURRENCY,
      signal,
    )

    // ── Post-processing ────────────────────────────────────────────────────

    // Token ladders and byte sizes only compare within one model, so each
    // model's block is judged on its own.
    for (const model of runModels) {
      postEvalQuality(model, tag(model))
      postEvalCompression(model, tag(model))
    }

    // Who actually answered — judged from every captured raw exchange at once.
    // All probes hit the same configured baseurl, so agreement is expected and
    // a split is itself a finding (a gateway balancing across upstreams).
    addLog('info', `返回数据形式: ${dataKindLine()}`)
    addLog('info', `来源判定: ${vendorLine()}`)
    // The C2PA line, when anything was checked at all. It is logged after the
    // header verdict and never in place of it: the two answer different
    // questions, and where they disagree the disagreement is the finding.
    if (results.value.some(r => r.c2pa)) {
      addLog('info', `Content Credentials: ${c2paLine()}`)
    }

    const elapsed = Math.round(performance.now() - t0)
    addLog('rule', '')
    addLog('info', `测试完成 ${doneCount.value}/${total}  ✓${passCount.value} ✗${failCount.value}  用时 ${(elapsed / 1000).toFixed(1)}s`)

    summary.value = buildSummary(elapsed)
    trimResults()
  }

  // ── Group evaluations ────────────────────────────────────────────────────

  function find(model: string, caseId: string) {
    return results.value.find(r => r.key === resultKey(model, caseId))
  }

  function postEvalQuality(model: string, tag: string) {
    // Every tier that came back, in documented order. Fewer than two and there
    // is no ladder to check; a refused xhigh/max on an older model is already
    // recorded as info on its own card.
    const done = QUALITY_TIERS
      .map(q => ({ q, r: find(model, `quality-${q}`) }))
      .filter((x): x is { q: typeof QUALITY_TIERS[number]; r: TestResult } => x.r?.status === 'done')
    if (done.length < 2) return

    const tokens = done.map(x => x.r.outputTokens ?? 0)
    if (tokens.some(t => !t)) {
      addLog('info', `${tag}quality — output_tokens 为空，无法通过 token 验证`)
      return
    }

    // Non-decreasing along the ladder. Strict ordering was the rule with three
    // tiers; with five, two adjacent tiers spending the same tokens is not
    // evidence of anything, whereas a higher tier spending *less* is.
    const ordered = tokens.every((t, i) => i === 0 || tokens[i - 1] <= t)
    const v: TestVerdict = ordered ? 'pass' : 'fail'
    const note = `token 消耗 ${done.map(x => `${x.q}=${x.r.outputTokens}`).join(' ')}`
    done.forEach(x => { x.r.verdict = v; x.r.detail += `  ${note}` })
    addLog(ordered ? 'ok' : 'warn',
      `${tag}quality token 顺序 ${ordered ? '正确 ✓' : '异常 ✗'}  ${note}`)
  }

  function postEvalCompression(model: string, tag: string) {
    const r0   = find(model, 'comp-0')
    const r50  = find(model, 'comp-50')
    const r100 = find(model, 'comp-100')

    if (!r0 || !r50 || !r100) return
    if ([r0, r50, r100].some(r => r.status !== 'done')) return

    const b0   = r0.bytes   ?? 0
    const b50  = r50.bytes  ?? 0
    const b100 = r100.bytes ?? 0

    if (b0 && b100) {
      // compression=0 should be smallest, compression=100 largest.
      const ratio = ((b100 - b0) / b100 * 100).toFixed(0)
      const pass  = b0 < b100 * 0.7   // at least 30 % difference
      const v: TestVerdict = pass ? 'pass' : 'fail'
      ;[r0, r50, r100].forEach(r => { r.verdict = v })
      r0.detail   = `comp=0 → ${(b0  / 1024).toFixed(0)} KB`
      r50.detail  = `comp=50 → ${(b50 / 1024).toFixed(0)} KB`
      r100.detail = `comp=100 → ${(b100 / 1024).toFixed(0)} KB  差异 ${ratio}%`
      addLog(pass ? 'ok' : 'warn',
        `${tag}compression 文件大小: 0→${(b0/1024).toFixed(0)}KB  50→${(b50/1024).toFixed(0)}KB  100→${(b100/1024).toFixed(0)}KB  差异 ${ratio}%  ${pass ? '✓' : '✗'}`)
    } else {
      addLog('info', `${tag}compression — byte_size 为空，无法验证`)
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────

  /** One line naming the vendor behind the gateway, from all raw exchanges. */
  function vendorLine(): string {
    return aggregateVendor(results.value.map(r => r.vendor ?? null))
  }

  /** One line on the Content Credentials found across the run's images. */
  function c2paLine(): string {
    return summarizeC2pa(results.value.map(r => r.c2pa ?? null))
  }

  /** The per-manifest detail under the C2PA section: one line per distinct
   *  answer, so a run where one model is signed and another is not says so
   *  rather than averaging into a single line. */
  function c2paDetailLines(): string[] {
    const out: string[] = []
    const seen = new Map<string, number>()
    for (const r of results.value) {
      if (!r.c2pa) continue
      const key = `${r.model} · ${describeC2pa(r.c2pa)}`
      seen.set(key, (seen.get(key) ?? 0) + 1)
    }
    for (const [key, n] of seen) out.push(`  · ${key}${n > 1 ? `（${n} 次）` : ''}`)

    // The certificate chain and the hash assertion are what the verdict rests
    // on, so the strongest manifest in the run is quoted in full — a reader
    // checking the claim by hand needs the exact subjects.
    const best = results.value.find(r => r.c2pa?.status === 'trusted')
      ?? results.value.find(r => r.c2pa?.status === 'valid')
    if (best?.c2pa) {
      const p = best.c2pa
      out.push(`  · 签发证书: ${p.subject ?? '?'}`)
      if (p.chain.length > 1) {
        out.push(`  · 完整证书链: ${p.chain.map(c => c.subject).join(' → ')}`)
      }
      if (p.anchor_subject) out.push(`  · 信任锚点: ${p.anchor_subject}`)
      if (p.hash_data) out.push(`  · ${p.hash_data.detail}`)
    }
    if (out.length) out.push(`  · 判定依据: ${best?.c2pa?.anchor_set ?? ''}`)
    return out
  }

  /** One line on how the image bytes arrived across the run. b64_json is the
   *  only documented shape for GPT image models, so anything else is called
   *  out as the gateway's own doing rather than left to look like a detail. */
  function dataKindLine(): string {
    const kinded = results.value.filter(r => r.dataKind)
    if (!kinded.length) return '无图像返回'
    const counts = new Map<string, number>()
    for (const r of kinded) {
      const k = describeDataKind(r)
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
    const parts = Array.from(counts.entries()).map(([k, n]) => `${k} ${n} 次`).join(' · ')
    return kinded.every(r => r.dataKind === 'b64_json')
      ? `${parts}（符合官方规范：GPT image 仅返回 b64_json）`
      : `${parts}（官方规范：GPT image 仅返回 b64_json，url / data:URL 是网关行为）`
  }

  /** One model's block of the report. Sections print only when their dimension
   *  was selected for this run — an empty "0/0 生效" block reads like a
   *  failure, not like an omission. */
  function modelSections(model: string): string[] {
    const rs = results.value.filter(r => r.model === model)
    const lines: string[] = []

    // size group
    const sizeResults = rs.filter(r => r.case.dimension === 'size')
    if (sizeResults.length) {
      const sizePass = sizeResults.filter(r => r.verdict === 'pass').length
      const sizeFail = sizeResults.filter(r => r.verdict === 'fail')
      lines.push('')
      lines.push(`■ size  ${sizePass}/${sizeResults.length} 生效` +
        (sizeFail.length ? `  失败: ${sizeFail.map(r => r.case.req.size).join(' / ')}` : ''))
      sizeResults.forEach(r => lines.push(`  · ${r.detail ?? ''}  ${r.verdict === 'pass' ? '✓' : '✗'}`))
    }

    // quality group
    const qr = rs.filter(r => r.case.dimension === 'quality')
    if (qr.length) {
      lines.push('')
      lines.push(`■ quality`)
      qr.forEach(r => {
        const q = r.case.req.quality
        // A refused tier (xhigh/max on an older model) has no token figure; its
        // detail already quotes the API's own wording.
        lines.push(r.status === 'done'
          ? `  · ${q}  output_tokens=${r.outputTokens ?? '?'}  ${r.verdict === 'pass' ? '✓ 顺序符合预期' : r.verdict === 'fail' ? '✗ 顺序异常' : '· 记录'}`
          : `  · ${q}  ${r.detail ?? r.status}`)
      })
    }

    // format group
    const fr = rs.filter(r => r.case.dimension === 'format')
    if (fr.length) {
      const fpass = fr.filter(r => r.verdict === 'pass').length
      lines.push('')
      lines.push(`■ output_format  ${fpass}/${fr.length} 生效`)
      fr.forEach(r => lines.push(`  · ${r.detail ?? ''}  ${r.verdict === 'pass' ? '✓' : '✗'}`))
    }

    // compression group
    const cr = rs.filter(r => r.case.dimension === 'compression')
    if (cr.length) {
      const cpass = cr.filter(r => r.verdict === 'pass').length
      lines.push('')
      lines.push(`■ output_compression  ${cpass > 0 ? '生效' : '未验证'}`)
      cr.forEach(r => lines.push(`  · ${r.detail ?? ''}`))
    }

    // n group — the only hard count in the suite
    const nr = rs.filter(r => r.case.dimension === 'n')
    if (nr.length) {
      const npass = nr.filter(r => r.verdict === 'pass').length
      lines.push('')
      lines.push(`■ n  ${npass}/${nr.length} 生效`)
      nr.forEach(r => lines.push(`  · ${r.detail ?? ''}  ${r.verdict === 'pass' ? '✓' : '✗'}`))
    }

    // background — the only group whose outcome is measured from the pixels
    const br = rs.filter(r => r.case.dimension === 'background')
    if (br.length) {
      const bpass = br.filter(r => r.verdict === 'pass').length
      const bscored = br.filter(r => !r.case.expectRefusal).length
      lines.push('')
      lines.push(`■ background  ${bpass}/${bscored} 生效（透明度由像素采样判定）`)
      br.forEach(r => {
        const mark = r.case.expectRefusal ? '·' : r.verdict === 'pass' ? '✓' : '✗'
        lines.push(`  · ${r.detail ?? ''}  ${mark}`)
      })
    }

    // edit
    const edit = rs.find(r => r.case.dimension === 'edit')
    if (edit) {
      lines.push('')
      lines.push(`■ 编辑端点（spring.jpg + "${EDIT_PROMPT}"）  ${edit.status === 'done' ? (edit.verdict === 'pass' ? '✓ 正常' : '✗ 异常') : '未完成'}`)
    }

    return lines
  }

  function buildSummary(elapsedMs: number): string {
    const now  = new Date()
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
    // From the results, not the live selection: the panel may have changed
    // since the run started, and the report describes the run.
    const runModels = Array.from(new Set(results.value.map(r => r.model)))
    const perModel = runModels.length ? results.value.length / runModels.length : results.value.length

    const lines: string[] = [
      `gpt-image 参数兼容性报告（${date}）`,
      `模型: ${runModels.join(' / ')}`,
      `测试数: ${results.value.length}` +
        (runModels.length > 1 ? `（每模型 ${perModel} 项）` : '') +
        ` · 并发: ${CONCURRENCY} · 用时: ${(elapsedMs / 1000).toFixed(1)}s`,
    ]

    for (const model of runModels) {
      if (runModels.length > 1) {
        lines.push('')
        lines.push(`━━━━ ${model} ━━━━`)
      }
      lines.push(...modelSections(model))
    }

    // data kind — how the bytes arrived, which the reference fixes as b64_json
    lines.push('')
    lines.push(`■ 返回数据形式  ${dataKindLine()}`)

    // vendor — judged from the raw exchanges, evidence quoted
    lines.push('')
    lines.push(`■ 来源判定  ${vendorLine()}`)

    // Content Credentials — the one cryptographic answer, quoted with the
    // certificate it came from so the reader can see what it rests on.
    lines.push('')
    lines.push(`■ Content Credentials  ${c2paLine()}`)
    for (const p of c2paDetailLines()) lines.push(p)

    return lines.join('\n')
  }

  return {
    logs, results, running, summary,
    selectedDims, selectedCount, models, plannedCount,
    passCount, failCount, doneCount, totalCount,
    run, stop, clear,
  }
})
