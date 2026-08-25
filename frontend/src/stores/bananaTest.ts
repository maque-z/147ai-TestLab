import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  BananaGenerateRequest, BananaGenerateResponse, BananaReferenceImage,
  BananaTestCase, BananaTestLogEntry, BananaTestResult,
} from '@/types'
import * as bananaApi from '@/api/bananaGen'
import { useBananaGenStore } from './bananaGen'
import { b64ToBlobUrl, imageMime, runPool } from '@/utils/batch'
import { DEFAULT_PROMPT } from '@/utils/defaultPrompt'
import { supportsThinking } from '@/utils/bananaSpec'

export const BANANA_TEST_CONCURRENCY = 8
const EDIT_PROMPT = '在不改变其他区域的前提下，为画面增加一轮太阳'

function buildCases(model: string): BananaTestCase[] {
  const cases: BananaTestCase[] = [
    { id: 'size-1k-square', label: '1:1 · 1K', dimension: 'size', expectedPixels: '1024×1024', req: { model_id: model, response_modalities: ['IMAGE'], aspect_ratio: '1:1', image_size: '1K' } },
    { id: 'size-1k-landscape', label: '16:9 · 1K', dimension: 'size', expectedPixels: '1344×768', req: { model_id: model, response_modalities: ['IMAGE'], aspect_ratio: '16:9', image_size: '1K' } },
    { id: 'size-1k-portrait', label: '9:16 · 1K', dimension: 'size', expectedPixels: '768×1344', req: { model_id: model, response_modalities: ['IMAGE'], aspect_ratio: '9:16', image_size: '1K' } },
    { id: 'size-2k-square', label: '1:1 · 2K', dimension: 'size', expectedPixels: '2048×2048', req: { model_id: model, response_modalities: ['IMAGE'], aspect_ratio: '1:1', image_size: '2K' } },
    { id: 'size-4k-wide', label: '16:9 · 4K', dimension: 'size', expectedPixels: '5376×3024', req: { model_id: model, response_modalities: ['IMAGE'], aspect_ratio: '16:9', image_size: '4K' } },
    { id: 'mod-image', label: '只返回 IMAGE', dimension: 'modalities', req: { model_id: model, response_modalities: ['IMAGE'], image_size: '1K' } },
    { id: 'mod-text-image', label: 'TEXT + IMAGE', dimension: 'modalities', req: { model_id: model, response_modalities: ['TEXT', 'IMAGE'], image_size: '1K' } },
    { id: 'mod-text-only', label: '只返回 TEXT', dimension: 'modalities', expectNoImage: true, req: { model_id: model, response_modalities: ['TEXT'] } },
    { id: 'candidate-2', label: 'candidateCount = 2', dimension: 'candidate', expectedImages: 2, req: { model_id: model, response_modalities: ['IMAGE'], candidate_count: 2, image_size: '1K' } },
    { id: 'size-512', label: '512 · 1:1', dimension: 'size', informational: true, req: { model_id: model, response_modalities: ['IMAGE'], image_size: '512', aspect_ratio: '1:1' } },
    { id: 'ratio-21-9', label: '21:9 · 1K', dimension: 'size', expectedPixels: '1536×672', req: { model_id: model, response_modalities: ['IMAGE'], image_size: '1K', aspect_ratio: '21:9' } },
    { id: 'sampling-temperature', label: 'temperature = 0', dimension: 'sampling', informational: true, req: { model_id: model, response_modalities: ['IMAGE'], temperature: 0, image_size: '1K' } },
    { id: 'sampling-top-p', label: 'topP = 0.8', dimension: 'sampling', informational: true, req: { model_id: model, response_modalities: ['IMAGE'], top_p: 0.8, image_size: '1K' } },
    { id: 'sampling-top-k', label: 'topK = 40', dimension: 'sampling', informational: true, req: { model_id: model, response_modalities: ['IMAGE'], top_k: 40, image_size: '1K' } },
    { id: 'tokens-max', label: 'maxOutputTokens = 2048', dimension: 'tokens', informational: true, req: { model_id: model, response_modalities: ['IMAGE'], max_output_tokens: 2048, image_size: '1K' } },
    { id: 'tokens-stop', label: 'stopSequences', dimension: 'tokens', informational: true, req: { model_id: model, response_modalities: ['IMAGE'], stop_sequences: ['END'], image_size: '1K' } },
    { id: 'seed', label: 'seed = 7', dimension: 'sampling', informational: true, req: { model_id: model, response_modalities: ['IMAGE'], seed: 7, image_size: '1K' } },
    { id: 'safety-none', label: '安全：BLOCK_NONE', dimension: 'safety', informational: true, req: { model_id: model, response_modalities: ['IMAGE'], safety_settings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }], image_size: '1K' } },
    { id: 'safety-off', label: '安全：OFF', dimension: 'safety', informational: true, req: { model_id: model, response_modalities: ['IMAGE'], safety_settings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' }], image_size: '1K' } },
    { id: 'safety-jailbreak', label: '安全：JAILBREAK', dimension: 'safety', informational: true, req: { model_id: model, response_modalities: ['IMAGE'], safety_settings: [{ category: 'HARM_CATEGORY_JAILBREAK', threshold: 'BLOCK_ONLY_HIGH' }], image_size: '1K' } },
    { id: 'case-2k', label: 'imageSize = 2k（探针）', dimension: 'probe', informational: true, req: { model_id: model, response_modalities: ['IMAGE'], image_size: '2k', aspect_ratio: '1:1' } },
    { id: 'edit-reference', label: '参考图编辑', dimension: 'edit', isEdit: true, req: { model_id: model, response_modalities: ['IMAGE'], image_size: '1K' } },
    { id: 'edit-mask', label: '蒙版约定探测', dimension: 'mask', isEdit: true, usesMask: true, informational: true, req: { model_id: model, response_modalities: ['IMAGE'], image_size: '1K' } },
  ]
  if (supportsThinking(model)) {
    cases.splice(17, 0,
      { id: 'thinking-minimal', label: 'thinkingLevel = MINIMAL（Gemini 3）', dimension: 'thinking', informational: true, req: { model_id: model, response_modalities: ['IMAGE'], thinking_level: 'MINIMAL', include_thoughts: true, image_size: '1K' } },
      { id: 'thinking-high', label: 'thinkingLevel = HIGH（Gemini 3）', dimension: 'thinking', informational: true, req: { model_id: model, response_modalities: ['IMAGE'], thinking_level: 'HIGH', include_thoughts: true, image_size: '1K' } },
    )
  }
  return cases
}

export const BANANA_TEST_CASE_COUNT = buildCases('model').length

function pad(value: number) { return String(value).padStart(2, '0') }
function nowTs() {
  const d = new Date()
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

async function measureImage(src: string): Promise<{ w: number; h: number } | null> {
  return new Promise(resolve => {
    const img = new Image()
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight })
    img.onerror = () => resolve(null)
    img.src = src
  })
}

async function blobToReference(blob: Blob, mimeType = blob.type || 'image/png'): Promise<BananaReferenceImage> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('参考图读取失败'))
    reader.readAsDataURL(blob)
  })
  return { mime_type: mimeType, data: dataUrl.slice(dataUrl.indexOf(',') + 1) }
}

async function makeMask(width: number, height: number): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, width, height)
  ctx.clearRect(width * .25, height * .25, width * .5, height * .5)
  return new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('蒙版生成失败')), 'image/png'))
}

function evaluate(c: BananaTestCase, res: BananaGenerateResponse, dims: { w: number; h: number } | null) {
  if (c.informational) {
    return { verdict: 'info' as const, detail: res.images.length ? `返回 ${res.images.length} 张图片${dims ? ` · ${dims.w}×${dims.h}` : ''}` : `未返回图片 · ${res.block_reason ?? '无原因'}` }
  }
  if (c.expectNoImage) {
    return { verdict: res.images.length ? 'fail' as const : 'pass' as const, detail: res.images.length ? `文档称只返回文本，实际返回 ${res.images.length} 张图片` : `未返回图片${res.texts.length ? ` · 文本 ${res.texts.length} 段` : ''}` }
  }
  if (c.expectedPixels) {
    const actual = dims ? `${dims.w}×${dims.h}` : '无法读取'
    return { verdict: actual === c.expectedPixels ? 'pass' as const : 'fail' as const, detail: `文档 ${c.expectedPixels} → 实际 ${actual}` }
  }
  if (c.expectedImages != null) {
    return { verdict: res.images.length === c.expectedImages ? 'pass' as const : 'fail' as const, detail: `请求 ${c.expectedImages} → 图片 ${res.images.length} · candidates ${res.candidate_count ?? '?'}` }
  }
  return { verdict: res.images.length ? 'pass' as const : 'fail' as const, detail: res.images.length ? `返回 ${res.images.length} 张图片` : `未返回图片 · ${res.block_reason ?? '无原因'}` }
}

export const useBananaTestStore = defineStore('bananaTest', () => {
  const banana = useBananaGenStore()
  const logs = ref<BananaTestLogEntry[]>([])
  const results = ref<BananaTestResult[]>([])
  const running = ref(false)
  const summary = ref('')
  let logSeq = 0
  let controller: AbortController | null = null

  const passCount = computed(() => results.value.filter(r => r.verdict === 'pass').length)
  const failCount = computed(() => results.value.filter(r => r.verdict === 'fail').length)
  const doneCount = computed(() => results.value.filter(r => ['done', 'error', 'cancelled'].includes(r.status)).length)
  const totalCount = computed(() => results.value.length)

  function addLog(level: BananaTestLogEntry['level'], text: string) {
    logs.value.push({ id: logSeq++, ts: nowTs(), level, text })
  }
  function stop() { controller?.abort() }
  function clear() {
    results.value.forEach(r => { if (r.src?.startsWith('blob:')) URL.revokeObjectURL(r.src) })
    results.value = []
    logs.value = []
    summary.value = ''
  }

  async function run() {
    if (running.value) return
    running.value = true
    clear()
    controller = new AbortController()
    const signal = controller.signal
    const model = banana.config.model_id
    const cases = buildCases(model)
    results.value = cases.map(c => ({ case: c, status: 'pending' }))
    const t0 = performance.now()
    addLog('info', `▶ 开始 Gemini 图片兼容性测试 · 模型 ${model}`)
    addLog('info', `${cases.length} 个探测 · 并发 ${BANANA_TEST_CONCURRENCY} · 每个用例只改变一个关键因素`)
    addLog('info', '安全探测包含 BLOCK_NONE / OFF / JAILBREAK；thinkingLevel 仅对支持 Gemini 3 的模型有意义')
    addLog('rule', '')

    let seed: BananaReferenceImage | undefined
    let mask: BananaReferenceImage | undefined
    try {
      const response = await fetch('/spring.jpg')
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const blob = await response.blob()
      seed = await blobToReference(blob, blob.type || 'image/jpeg')
      mask = await blobToReference(await makeMask(350, 229), 'image/png')
      addLog('info', `编辑参考图和约定式蒙版已准备`)
    } catch (e: any) {
      addLog('warn', `编辑素材准备失败，编辑用例将跳过：${e?.message ?? e}`)
    }

    try {
      await runPool(cases.map((c, index) => async () => {
        const result = results.value[index]
        if (signal.aborted) { result.status = 'cancelled'; return }
        if (c.isEdit && !seed) { result.status = 'cancelled'; result.detail = '参考图未加载'; return }
        if (c.usesMask && !mask) { result.status = 'cancelled'; result.detail = '蒙版素材未生成'; return }
        result.status = 'running'
        const started = performance.now()
        try {
          const req: BananaGenerateRequest = {
            prompt: c.isEdit ? EDIT_PROMPT : DEFAULT_PROMPT,
            ...c.req,
            reference_images: c.isEdit && seed ? [seed] : undefined,
            mask_image: c.usesMask ? mask : undefined,
          }
          const res = await bananaApi.generate(req, signal)
          const image = res.images[0]
          const src = image?.b64_json ? await b64ToBlobUrl(image.b64_json, imageMime(image.image_format)) : image?.url
          const dims = src ? await measureImage(src) : null
          const assessed = evaluate(c, res, dims)
          Object.assign(result, {
            status: 'done', verdict: assessed.verdict, detail: assessed.detail, src,
            width: dims?.w, height: dims?.h, imageCount: res.images.length,
            candidateCount: res.candidate_count, actualModel: res.upstream_model,
            requestId: res.request_id, elapsedMs: Math.round(performance.now() - started),
          })
          const icon = assessed.verdict === 'pass' ? '✓' : assessed.verdict === 'fail' ? '✗' : '·'
          addLog(assessed.verdict === 'fail' ? 'error' : assessed.verdict === 'pass' ? 'ok' : 'info', `${icon} ${c.label} · ${assessed.detail}`)
        } catch (e: any) {
          const status = e?.response?.status
          const message = e?.response?.data?.detail || e?.message || '请求失败'
          Object.assign(result, { status: signal.aborted ? 'cancelled' : 'error', verdict: status === 429 ? 'ratelimit' : c.informational ? 'info' : 'fail', detail: status === 429 ? '限流 429' : message, error: message, elapsedMs: Math.round(performance.now() - started) })
          addLog(status === 429 ? 'warn' : 'error', `${status === 429 ? '⚡' : '✗'} ${c.label} · ${message}`)
        }
      }), BANANA_TEST_CONCURRENCY, signal)
    } finally {
      results.value.forEach(r => { if (r.status === 'pending') r.status = 'cancelled' })
      const seconds = ((performance.now() - t0) / 1000).toFixed(1)
      addLog('rule', '')
      addLog('info', `测试完成 ${doneCount.value}/${cases.length} · ✓${passCount.value} ✗${failCount.value} · ${seconds}s`)
      summary.value = buildSummary(model, seconds)
      running.value = false
      controller = null
    }
  }

  function buildSummary(model: string, seconds: string) {
    const lines = [`Gemini 图片兼容性测试报告`, `模型: ${model}`, `探测: ${results.value.length} · 并发: ${BANANA_TEST_CONCURRENCY} · 用时: ${seconds}s`, '']
    for (const result of results.value) {
      const mark = result.verdict === 'pass' ? '✓' : result.verdict === 'fail' ? '✗' : result.verdict === 'ratelimit' ? '⚡' : '·'
      lines.push(`${mark} ${result.case.label}: ${result.detail ?? result.status}`)
      if (result.requestId) lines.push(`  request_id: ${result.requestId}`)
    }
    lines.push('', `结论: 通过 ${passCount.value} · 失败 ${failCount.value} · 信息/限流 ${results.value.length - passCount.value - failCount.value}`)
    return lines.join('\n')
  }

  return { logs, results, running, summary, passCount, failCount, doneCount, totalCount, run, stop, clear }
})
