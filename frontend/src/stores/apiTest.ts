import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type {
  TestCase, TestResult, TestLogEntry, TestVerdict, TestDimension,
  GenerateRequest, GenerateResponse,
} from '@/types'
import * as imageGenApi from '@/api/imageGen'
import { useImageGenStore } from '@/stores/imageGen'
import { b64ToBlobUrl, runPool, sampleAlpha } from '@/utils/batch'
import { detectVendor, aggregateVendor } from '@/utils/vendor'
import { DEFAULT_PROMPT } from '@/utils/defaultPrompt'

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
  for (const quality of ['low', 'medium', 'high'] as const) {
    cases.push({
      id: `quality-${quality}`,
      label: `quality = ${quality}`,
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
  // Transparency went to preview for gpt-image-2 on 2026-08-20, so this group
  // checks a capability that is both new and still in preview. The verdict comes
  // from sampling the decoded pixels, not from anything the API claims — the
  // announcement thread itself carries a report of requested transparency
  // arriving as a rendered checkerboard instead of real alpha.
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

/** How many probes the suite runs. Derived, not written down: the hand-maintained
 *  number was wrong by two for several commits after a case was removed, and it
 *  is quoted in the UI as the credit the run will spend. */
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

/** Cards are capped at this value for consistency with the generate/edit pools.
 *  In practice run() calls clear() first so this is a guard rather than a
 *  live eviction path — a single suite is only 17 cards. */
const MAX_RESULTS = 50

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
  res: GenerateResponse,
  img: { b64_json?: string; image_format?: string; byte_size?: number } | undefined,
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
      // Tokens are the best proxy: high should be > medium > low.
      // We record here and evaluate the group in post-processing.
      const out = res.output_tokens ?? res.input_tokens ?? null
      return {
        verdict: 'info',
        detail: `output_tokens = ${out ?? '未知'}`,
      }
    }

    case 'format': {
      const actual = img?.image_format ?? '?'
      const requested = c.req.output_format!
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
      const ok = !!(img?.b64_json || img?.image_format)
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

  /** How many probes the current selection amounts to — quoted in the header
   *  and on the start button as the credit the run will spend. */
  const selectedCount = computed(() =>
    buildTestCases().filter(c => selectedDims.value.includes(c.dimension)).length,
  )

  let logSeq = 0
  let ctl: AbortController | null = null

  function addLog(level: TestLogEntry['level'], text: string) {
    logs.value.push({ id: logSeq++, ts: nowTs(), level, text })
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
    results.value = cases.map(c => ({ case: c, status: 'pending' as const }))

    const total = cases.length
    addLog('info', `▶ 开始 gpt-image 参数兼容性测试`)
    addLog('info', `共 ${total} 个探测 · 并发 ${CONCURRENCY}`)
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
      cases.map((c, i) => async () => {
        if (signal.aborted) {
          results.value[i].status = 'cancelled'
          return
        }

        results.value[i].status = 'running'
        const caseT0 = performance.now()

        try {
          const req: GenerateRequest = c.isEdit
            ? { prompt: EDIT_PROMPT, ...c.req }
            : { prompt: DEFAULT_PROMPT, quality: 'low', size: '1024x1024', ...c.req }
          let res: GenerateResponse

          if (c.isEdit) {
            if (!seedFile) {
              results.value[i].status = 'cancelled'
              addLog('warn', `⚠ ${c.label} — 跳过（参考图未加载）`)
              return
            }
            res = await imageGenApi.edit(req, [seedFile], null, signal)
          } else {
            res = await imageGenApi.generate(req, signal)
          }

          const elapsed = Math.round(performance.now() - caseT0)
          const imgData = res.images[0]

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

          const { verdict, detail } = evaluate(c, res, imgData, dims, hasAlpha)

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
          } as Partial<TestResult>)

          const icon = verdict === 'pass' ? '✓' : verdict === 'fail' ? '✗' : '·'
          const lvl  = verdict === 'fail' ? 'error' : verdict === 'pass' ? 'ok' : 'info'
          addLog(lvl, `${icon} ${c.label}  ${detail}  (${elapsed}ms)`)

        } catch (e: any) {
          const elapsed = Math.round(performance.now() - caseT0)
          const errMsg  = e?.response?.data?.detail || e?.message || '请求失败'
          const is429   = e?.response?.status === 429

          // A refusal probe that gets refused has done its job — that is the
          // answer it was sent to get, not a failure of the API. Recording the
          // upstream's own wording matters here: it is the only place this tool
          // learns what an unsupported combination actually returns.
          const refused = c.expectRefusal && !is429 && !signal.aborted

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
          } as Partial<TestResult>)

          const label = is429 ? `⚡ ${c.label}  限流 429`
                      : refused ? `· ${c.label}  API 拒绝 → ${errMsg}`
                      : `✗ ${c.label}  ${errMsg}`
          addLog(is429 || refused ? 'warn' : 'error', `${label}  (${elapsed}ms)`)
        }
      }),
      CONCURRENCY,
      signal,
    )

    // ── Post-processing ────────────────────────────────────────────────────

    // Quality: verify tokens increase with quality level.
    postEvalQuality()

    // Compression: verify byte sizes change with compression level.
    postEvalCompression()

    // Who actually answered — judged from every captured raw exchange at once.
    // All probes hit the same configured baseurl, so agreement is expected and
    // a split is itself a finding (a gateway balancing across upstreams).
    addLog('info', `来源判定: ${vendorLine()}`)

    const elapsed = Math.round(performance.now() - t0)
    addLog('rule', '')
    addLog('info', `测试完成 ${doneCount.value}/${total}  ✓${passCount.value} ✗${failCount.value}  用时 ${(elapsed / 1000).toFixed(1)}s`)

    summary.value = buildSummary(elapsed)
    trimResults()
  }

  // ── Group evaluations ────────────────────────────────────────────────────

  function postEvalQuality() {
    const getResult = (q: string) =>
      results.value.find(r => r.case.id === `quality-${q}`)

    const low    = getResult('low')
    const medium = getResult('medium')
    const high   = getResult('high')

    if (!low || !medium || !high) return
    if ([low, medium, high].some(r => r.status !== 'done')) return

    const tLow  = low.outputTokens  ?? 0
    const tMed  = medium.outputTokens ?? 0
    const tHigh = high.outputTokens  ?? 0

    if (tLow && tMed && tHigh) {
      const ordered = tLow < tMed && tMed < tHigh
      const v: TestVerdict = ordered ? 'pass' : 'fail'
      const note = `token 消耗 low=${tLow} medium=${tMed} high=${tHigh}`
      ;[low, medium, high].forEach(r => { r.verdict = v; r.detail += `  ${note}` })
      addLog(ordered ? 'ok' : 'warn',
        `quality token 顺序 ${ordered ? '正确 ✓' : '异常 ✗'}  ${note}`)
    } else {
      addLog('info', 'quality — output_tokens 为空，无法通过 token 验证')
    }
  }

  function postEvalCompression() {
    const getResult = (n: number) =>
      results.value.find(r => r.case.id === `comp-${n}`)

    const r0   = getResult(0)
    const r50  = getResult(50)
    const r100 = getResult(100)

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
        `compression 文件大小: 0→${(b0/1024).toFixed(0)}KB  50→${(b50/1024).toFixed(0)}KB  100→${(b100/1024).toFixed(0)}KB  差异 ${ratio}%  ${pass ? '✓' : '✗'}`)
    } else {
      addLog('info', 'compression — byte_size 为空，无法验证')
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────

  /** One line naming the vendor behind the gateway, from all raw exchanges. */
  function vendorLine(): string {
    return aggregateVendor(
      results.value.map(r => r.upstream ? detectVendor(r.upstream) : null),
    )
  }

  function buildSummary(elapsedMs: number): string {
    const now  = new Date()
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
    const model = imageGen.config.model_id || 'gpt-image-?'

    const lines: string[] = [
      `${model} 参数兼容性报告（${date}）`,
      `测试数: ${results.value.length} · 并发: ${CONCURRENCY} · 用时: ${(elapsedMs / 1000).toFixed(1)}s`,
    ]

    // Sections print only when their dimension was selected for this run —
    // an empty "0/0 生效" block reads like a failure, not like an omission.

    // size group
    const sizeResults = results.value.filter(r => r.case.dimension === 'size')
    if (sizeResults.length) {
      const sizePass = sizeResults.filter(r => r.verdict === 'pass').length
      const sizeFail = sizeResults.filter(r => r.verdict === 'fail')
      lines.push('')
      lines.push(`■ size  ${sizePass}/${sizeResults.length} 生效` +
        (sizeFail.length ? `  失败: ${sizeFail.map(r => r.case.req.size).join(' / ')}` : ''))
      sizeResults.forEach(r => lines.push(`  · ${r.detail ?? ''}  ${r.verdict === 'pass' ? '✓' : '✗'}`))
    }

    // quality group
    const qr = results.value.filter(r => r.case.dimension === 'quality')
    if (qr.length) {
      lines.push('')
      lines.push(`■ quality`)
      qr.forEach(r => {
        const q = r.case.req.quality
        lines.push(`  · ${q}  output_tokens=${r.outputTokens ?? '?'}  ${r.verdict === 'pass' ? '✓ 顺序符合预期' : r.verdict === 'fail' ? '✗ 顺序异常' : '· 记录'}`)
      })
    }

    // format group
    const fr = results.value.filter(r => r.case.dimension === 'format')
    if (fr.length) {
      const fpass = fr.filter(r => r.verdict === 'pass').length
      lines.push('')
      lines.push(`■ output_format  ${fpass}/${fr.length} 生效`)
      fr.forEach(r => lines.push(`  · ${r.detail ?? ''}  ${r.verdict === 'pass' ? '✓' : '✗'}`))
    }

    // compression group
    const cr = results.value.filter(r => r.case.dimension === 'compression')
    if (cr.length) {
      const cpass = cr.filter(r => r.verdict === 'pass').length
      lines.push('')
      lines.push(`■ output_compression  ${cpass > 0 ? '生效' : '未验证'}`)
      cr.forEach(r => lines.push(`  · ${r.detail ?? ''}`))
    }

    // n group — the only hard count in the suite
    const nr = results.value.filter(r => r.case.dimension === 'n')
    if (nr.length) {
      const npass = nr.filter(r => r.verdict === 'pass').length
      lines.push('')
      lines.push(`■ n  ${npass}/${nr.length} 生效`)
      nr.forEach(r => lines.push(`  · ${r.detail ?? ''}  ${r.verdict === 'pass' ? '✓' : '✗'}`))
    }

    // background — the only group whose outcome is measured from the pixels
    const br = results.value.filter(r => r.case.dimension === 'background')
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
    const edit = results.value.find(r => r.case.dimension === 'edit')
    if (edit) {
      lines.push('')
      lines.push(`■ 编辑端点（spring.jpg + "${EDIT_PROMPT}"）  ${edit.status === 'done' ? (edit.verdict === 'pass' ? '✓ 正常' : '✗ 异常') : '未完成'}`)
    }

    // vendor — judged from the raw exchanges, evidence quoted
    lines.push('')
    lines.push(`■ 来源判定  ${vendorLine()}`)

    return lines.join('\n')
  }

  return {
    logs, results, running, summary,
    selectedDims, selectedCount,
    passCount, failCount, doneCount, totalCount,
    run, stop, clear,
  }
})
