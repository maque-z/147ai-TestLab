<template>
  <div class="mask-editor">
    <div class="mask-head">
      <!-- Explicit switch: without it the only way to tell whether a mask is
           going out is to notice that nothing was painted, and the only way to
           stop sending one is to destroy the drawing. -->
      <button class="enable-btn" :class="{ on: enabled }" @click="enabled = !enabled">
        <span class="dot" />
        {{ enabled ? '蒙版已启用' : '蒙版已关闭' }}
      </button>

      <div class="mode-switch" :class="{ dim: !enabled }">
        <button
          class="mode-btn" :class="{ on: mode === 'brush' }"
          :disabled="!enabled"
          @click="mode = 'brush'"
        >✏️ 画笔涂抹</button>
        <button
          class="mode-btn" :class="{ on: mode === 'import' }"
          :disabled="!enabled"
          @click="mode = 'import'"
        >⬆ 导入文件</button>
      </div>
      <span class="spacer" />
      <n-button text size="tiny" :disabled="!hasDrawing" @click="clearAll">
        清空涂抹
      </n-button>
    </div>

    <div v-if="mode === 'brush'" class="tool-row" :class="{ dim: !enabled }">
      <button class="tool" :class="{ on: !erasing }" :disabled="!enabled"
              title="涂抹要重绘的区域" @click="erasing = false">
        画笔
      </button>
      <button class="tool" :class="{ on: erasing }" :disabled="!enabled"
              title="擦掉涂抹" @click="erasing = true">
        橡皮擦
      </button>
      <label class="brush-size">
        <span class="text-muted">粗细</span>
        <input v-model.number="brush" type="range" :min="4" :max="240" step="2" :disabled="!enabled" />
        <span class="size-num">{{ brush }}</span>
      </label>
      <n-button text size="tiny" :disabled="!strokes.length || !enabled" @click="undo">↶ 撤销</n-button>
    </div>

    <div v-else class="tool-row" :class="{ dim: !enabled }">
      <input
        ref="fileInput"
        type="file"
        accept="image/png"
        class="hidden-input"
        @change="onImportFile"
      />
      <button class="tool" :disabled="!enabled" @click="fileInput?.click()">选择 PNG 蒙版…</button>
      <span class="text-muted import-hint">
        透明区域 = 要重绘；导入后仍可用画笔继续修改
      </span>
    </div>

    <!-- Stage. The canvas is kept at the image's natural pixel size and only
         scaled by CSS, so what is painted is exactly what gets uploaded. The
         inner frame shrink-wraps the image so the overlay lands on it exactly
         rather than on the letterboxed area around it. -->
    <div v-if="image" class="stage">
      <div class="frame">
        <img :src="image.url" class="base" alt="蒙版底图" draggable="false" />
        <canvas
          ref="canvasEl"
          class="overlay"
          :class="{ off: !enabled }"
          @pointerdown="onDown"
          @pointermove="onMove"
          @pointerup="onUp"
          @pointerleave="onUp"
          @pointercancel="onUp"
        />
      </div>
    </div>
    <div v-else class="stage empty text-muted">先上传参考图，第 1 张就是蒙版的底图</div>

    <!-- The one line that answers "is a mask being sent with this request?" -->
    <div class="status">
      <span v-if="natural" class="text-muted">{{ natural.w }}×{{ natural.h }}</span>
      <span class="spacer" />
      <span v-if="importError" class="err">{{ importError }}</span>
      <span v-else-if="willSend" class="sending">
        ✓ 将上传蒙版 · 重绘 {{ coverageLabel }} 区域
      </span>
      <span v-else-if="!enabled" class="text-muted">✗ 不上传蒙版（开关已关闭）</span>
      <span v-else-if="!image" class="text-muted">✗ 不上传蒙版（没有参考图）</span>
      <span v-else class="text-muted">✗ 不上传蒙版（尚未涂抹）</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue'
import { NButton } from 'naive-ui'
import type { RefImage } from '@/types'

const props = defineProps<{ image: RefImage | null }>()

/** Emitted whenever the painted region changes, so the parent can hold the PNG
 *  ready to upload. null means "nothing painted" — no mask is sent at all. */
const emit = defineEmits<{ (e: 'change', mask: Blob | null): void }>()

type Point = { x: number; y: number }
interface Stroke { points: Point[]; size: number; erase: boolean }

const mode = ref<'brush' | 'import'>('brush')
/** Master switch. Kept separate from "is anything painted" so a drawing can be
 *  disabled and re-enabled without losing it — which is what makes an
 *  with-mask/without-mask comparison possible. */
const enabled = ref(true)
const erasing = ref(false)
const brush = ref(48)
const strokes = ref<Stroke[]>([])
const imported = ref<ImageData | null>(null)
const importError = ref('')
const coverage = ref(0)
/** Whether any painted pixel survives, measured rather than inferred — erasing
 *  every stroke leaves the stroke list non-empty but the canvas blank. */
const hasPaint = ref(false)

const canvasEl = ref<HTMLCanvasElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

const MIN_PROBE = 256

const natural = computed(() =>
  props.image?.width && props.image?.height
    ? { w: props.image.width, h: props.image.height }
    : null
)

const hasDrawing = computed(() => strokes.value.length > 0 || !!imported.value)

/** The single source of truth for "does this request carry a mask". */
const willSend = computed(() => enabled.value && !!props.image && hasPaint.value)

/** Sub-0.1% areas are real and worth sending; rounding them to "0.0%" would
 *  read as nothing being painted. */
const coverageLabel = computed(() =>
  coverage.value > 0 && coverage.value < 0.1 ? '<0.1%' : `${coverage.value.toFixed(1)}%`
)

let drawing = false
let emitTimer: number | undefined

/** Resize the paint canvas to the image's real pixel size and repaint. Called
 *  whenever the first reference image changes. */
async function resetCanvas() {
  strokes.value = []
  imported.value = null
  importError.value = ''
  await nextTick()
  const c = canvasEl.value
  const dims = natural.value
  if (c && dims) {
    c.width = dims.w
    c.height = dims.h
  }
  // Always redraw, even with no canvas yet: it is what clears a stale mask off
  // the parent when the reference image is swapped out.
  redraw()
}

watch(() => props.image?.id, resetCanvas)
watch(natural, (v, old) => {
  // Dimensions arrive after the <img> decodes, which can be after the id watch.
  if (v && (!old || v.w !== old.w || v.h !== old.h)) resetCanvas()
})

function ctxOf() {
  return canvasEl.value?.getContext('2d', { willReadFrequently: true }) ?? null
}

/** Paint one stroke onto the canvas. Erasing punches back out with
 *  destination-out so the two tools are exact inverses of each other. */
function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke, from = 0) {
  ctx.save()
  ctx.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over'
  ctx.strokeStyle = 'rgba(220, 70, 70, 0.75)'
  ctx.fillStyle = 'rgba(220, 70, 70, 0.75)'
  ctx.lineWidth = s.size
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  if (s.points.length === 1) {
    const p = s.points[0]
    ctx.beginPath()
    ctx.arc(p.x, p.y, s.size / 2, 0, Math.PI * 2)
    ctx.fill()
  } else {
    ctx.beginPath()
    ctx.moveTo(s.points[Math.max(0, from - 1)].x, s.points[Math.max(0, from - 1)].y)
    for (let i = Math.max(1, from); i < s.points.length; i++) {
      ctx.lineTo(s.points[i].x, s.points[i].y)
    }
    ctx.stroke()
  }
  ctx.restore()
}

/** Full repaint from the stroke list. Only needed on undo/clear/import —
 *  live drawing appends incrementally so it stays O(1) per move. */
function redraw() {
  const ctx = ctxOf()
  const c = canvasEl.value
  if (ctx && c) {
    ctx.clearRect(0, 0, c.width, c.height)
    if (imported.value) ctx.putImageData(imported.value, 0, 0)
    strokes.value.forEach(s => drawStroke(ctx, s))
  }
  scheduleEmit()
}

/** Map a pointer event to canvas pixel coordinates. The canvas is displayed
 *  scaled to fit, so the ratio between its box and its bitmap matters. */
function toCanvas(e: PointerEvent): Point | null {
  const c = canvasEl.value
  if (!c) return null
  const r = c.getBoundingClientRect()
  if (!r.width || !r.height) return null
  return {
    x: ((e.clientX - r.left) / r.width) * c.width,
    y: ((e.clientY - r.top) / r.height) * c.height,
  }
}

function onDown(e: PointerEvent) {
  if (!enabled.value || mode.value !== 'brush' || !natural.value) return
  const p = toCanvas(e)
  if (!p) return
  drawing = true
  ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  // Brush size is in canvas pixels, so it stays consistent across zoom levels.
  const scale = canvasEl.value!.width / (canvasEl.value!.getBoundingClientRect().width || 1)
  strokes.value.push({ points: [p], size: brush.value * scale, erase: erasing.value })
  const ctx = ctxOf()
  if (ctx) drawStroke(ctx, strokes.value[strokes.value.length - 1])
  scheduleEmit()
}

function onMove(e: PointerEvent) {
  if (!drawing) return
  const p = toCanvas(e)
  if (!p) return
  const s = strokes.value[strokes.value.length - 1]
  s.points.push(p)
  const ctx = ctxOf()
  if (ctx) drawStroke(ctx, s, s.points.length - 1)
  scheduleEmit()
}

function onUp() {
  if (!drawing) return
  drawing = false
  scheduleEmit()
}

function undo() {
  strokes.value.pop()
  redraw()
}

function clearAll() {
  strokes.value = []
  imported.value = null
  importError.value = ''
  redraw()
}

/** Load an external PNG mask and fold it into the paint layer, so the brush can
 *  keep editing it. Its transparent pixels are the painted region by definition. */
async function onImportFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  importError.value = ''

  const dims = natural.value
  if (!dims) {
    importError.value = '请先上传参考图'
    return
  }

  const url = URL.createObjectURL(file)
  try {
    const img = await loadImage(url)
    if (img.naturalWidth !== dims.w || img.naturalHeight !== dims.h) {
      importError.value =
        `蒙版 ${img.naturalWidth}×${img.naturalHeight} 与第 1 张图 ${dims.w}×${dims.h} 不一致`
      return
    }

    // Read the file's alpha channel and turn its holes into painted pixels.
    const probe = document.createElement('canvas')
    probe.width = dims.w
    probe.height = dims.h
    const pctx = probe.getContext('2d', { willReadFrequently: true })
    if (!pctx) return
    pctx.drawImage(img, 0, 0)
    const src = pctx.getImageData(0, 0, dims.w, dims.h)

    let holes = 0
    const painted = new ImageData(dims.w, dims.h)
    for (let i = 0; i < src.data.length; i += 4) {
      if (src.data[i + 3] < 128) {
        holes++
        painted.data[i] = 220
        painted.data[i + 1] = 70
        painted.data[i + 2] = 70
        painted.data[i + 3] = 191
      }
    }
    if (!holes) {
      importError.value = '这张 PNG 没有透明区域，蒙版不会起作用'
      return
    }
    imported.value = painted
    strokes.value = []
    mode.value = 'brush'
    redraw()
  } catch {
    importError.value = '读取 PNG 失败'
  } finally {
    URL.revokeObjectURL(url)
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

/** Turn the painted overlay into the PNG the API expects: opaque everywhere,
 *  with alpha punched to zero exactly where the user painted.
 *
 *  Built at the image's natural size, so it matches the first reference image
 *  pixel for pixel — the one thing the endpoint refuses to tolerate slack on.
 */
async function buildMask(): Promise<Blob | null> {
  const src = canvasEl.value
  const dims = natural.value
  if (!src || !dims) return null

  const out = document.createElement('canvas')
  out.width = dims.w
  out.height = dims.h
  const ctx = out.getContext('2d')
  if (!ctx) return null

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, dims.w, dims.h)
  ctx.globalCompositeOperation = 'destination-out'
  ctx.drawImage(src, 0, 0)

  return await new Promise(resolve => out.toBlob(b => resolve(b), 'image/png'))
}

/** Painted fraction, sampled rather than measured — a 4K canvas has 8M pixels
 *  and this runs after every brush stroke.
 *
 *  Returns both the percentage and whether *any* paint survives. Those are
 *  different questions: a small brush on a 4K canvas can cover far less than
 *  0.1%, and treating a rounded-to-zero percentage as "nothing painted" would
 *  silently drop a mask the user did draw.
 */
function measureCoverage(): { pct: number; any: boolean } {
  const c = canvasEl.value
  if (!c || !c.width) return { pct: 0, any: false }
  try {
    const N = MIN_PROBE
    const probe = document.createElement('canvas')
    probe.width = N
    probe.height = N
    const pctx = probe.getContext('2d', { willReadFrequently: true })
    if (!pctx) return { pct: 0, any: false }
    // Downscaling box-filters, so a stroke thinner than one probe pixel still
    // leaves partial alpha behind instead of disappearing.
    pctx.drawImage(c, 0, 0, N, N)
    const { data } = pctx.getImageData(0, 0, N, N)
    let solid = 0
    let touched = 0
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 20) solid++
      else if (data[i] > 0) touched++
    }
    return { pct: (solid / (N * N)) * 100, any: solid > 0 || touched > 0 }
  } catch {
    return { pct: 0, any: false }
  }
}

/** Rebuilding the PNG on every pointermove would be far too slow, so the mask is
 *  only re-encoded once the strokes settle. */
function scheduleEmit() {
  window.clearTimeout(emitTimer)
  emitTimer = window.setTimeout(async () => {
    const m = measureCoverage()
    coverage.value = m.pct
    hasPaint.value = m.any
    emit('change', willSend.value ? await buildMask() : null)
  }, 180)
}

// Toggling the switch changes what goes upstream, so the parent has to hear it.
watch(enabled, () => scheduleEmit())

onBeforeUnmount(() => window.clearTimeout(emitTimer))
</script>

<style scoped>
.mask-editor { display: flex; flex-direction: column; gap: 8px; }

.mask-head, .tool-row {
  display: flex; align-items: center; gap: 8px;
  flex-wrap: wrap;
}
.spacer { flex: 1; }

/* Disabled controls stay visible so the drawing is not hidden, just inert */
.tool-row.dim, .mode-switch.dim { opacity: 0.45; pointer-events: none; }

/* ===== Enable switch ===== */
.enable-btn {
  display: inline-flex; align-items: center; gap: 7px;
  padding: 5px 13px;
  border: none;
  border-radius: 999px;
  background: var(--bg);
  color: var(--text-muted);
  font-size: 11.5px; font-weight: 600;
  cursor: pointer;
  box-shadow: 2px 2px 4px var(--shadow-dark), -2px -2px 4px var(--shadow-light);
  transition: color 0.15s;
}
.enable-btn.on { color: var(--accent); }
.dot {
  width: 7px; height: 7px;
  border-radius: 50%;
  background: var(--text-muted);
  transition: background 0.15s, box-shadow 0.15s;
}
.enable-btn.on .dot {
  background: var(--accent);
  box-shadow: 0 0 0 3px rgba(108, 155, 209, 0.22);
}

.mode-switch { display: flex; gap: 6px; }
.mode-btn, .tool {
  padding: 5px 12px;
  border: none;
  border-radius: 7px;
  background: var(--bg);
  color: var(--text-muted);
  font-size: 11.5px;
  cursor: pointer;
  box-shadow: 2px 2px 4px var(--shadow-dark), -2px -2px 4px var(--shadow-light);
  transition: color 0.15s, background 0.15s;
}
.mode-btn:hover, .tool:hover { color: var(--text-primary); }
.mode-btn.on, .tool.on {
  color: #fff;
  background: var(--accent);
  box-shadow: inset 2px 2px 4px rgba(0, 0, 0, 0.15);
}

.brush-size {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 11.5px;
}
.brush-size input { width: 110px; }
.size-num {
  font-variant-numeric: tabular-nums;
  min-width: 26px;
  color: var(--text-primary);
}

.hidden-input { display: none; }
.import-hint { font-size: 11px; }

/* Stage: the frame shrink-wraps the image, and the canvas overlays the frame,
   so painted pixels line up with what the user sees at any scale. */
.stage {
  display: flex; align-items: center; justify-content: center;
  border-radius: var(--radius-input);
  overflow: hidden;
  background: #dfe4ea;
  padding: 6px;
  box-shadow: inset 4px 4px 8px var(--shadow-dark), inset -4px -4px 8px var(--shadow-light);
}
.stage.empty {
  min-height: 120px;
  font-size: 12px;
}
.frame {
  position: relative;
  display: inline-block;
  max-width: 100%;
  line-height: 0;
}
.base {
  display: block;
  max-width: 100%; max-height: 420px;
  width: auto; height: auto;
  user-select: none;
}
.overlay {
  position: absolute;
  inset: 0;
  width: 100%; height: 100%;
  cursor: crosshair;
  touch-action: none;
}
/* Switched off: the drawing stays on screen, dimmed, so turning it back on is
   obviously non-destructive. */
.overlay.off { opacity: 0.3; cursor: not-allowed; }

.status {
  display: flex; align-items: center; gap: 10px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.sending { color: var(--accent); font-weight: 600; }
.err { color: #c0564a; }
</style>
