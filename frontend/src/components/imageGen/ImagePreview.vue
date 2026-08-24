<template>
  <n-modal :show="show" @update:show="$emit('update:show', $event)">
    <div class="viewer" @click="close" @wheel.prevent="onWheel">
      <!-- Toolbar -->
      <div class="toolbar" @click.stop>
        <span class="counter">{{ index + 1 }} / {{ items.length }}</span>
        <span class="divider" />
        <button class="tool" title="缩小 ( - )" @click="zoomBy(1 / 1.25)">−</button>
        <span class="zoom-num">{{ Math.round(scale * 100) }}%</span>
        <button class="tool" title="放大 ( + )" @click="zoomBy(1.25)">＋</button>
        <button class="tool wide" title="适应窗口 ( 0 )" @click="reset">适应</button>
        <button class="tool wide" title="原始大小 ( 1 )" @click="actualSize">1:1</button>
        <span class="divider" />
        <!-- The transparency check: cycle the backdrop and watch whether the
             image's background follows. A painted checkerboard will not. -->
        <button
          class="tool wide bd-btn"
          title="切换背景 ( B ) — 真透明的图背景会跟着变，画上去的棋盘格不会"
          @click="cycleBackdrop"
        >
          <span class="bd-swatch" :class="`bd-${backdrop}`" />
          {{ BACKDROP_LABEL[backdrop] }}
        </button>
        <span class="divider" />
        <span v-if="current" class="caption" :title="captionFull">{{ caption }}</span>
        <span class="divider" />
        <button class="tool" title="关闭 ( Esc )" @click="close">×</button>
      </div>

      <!-- Arrows span every image in the grid, not just the current card -->
      <button
        v-if="items.length > 1"
        class="nav prev" title="上一张 ( ← )"
        @click.stop="step(-1)"
      >‹</button>
      <button
        v-if="items.length > 1"
        class="nav next" title="下一张 ( → )"
        @click.stop="step(1)"
      >›</button>

      <img
        v-if="current"
        ref="imgEl"
        :src="current.src"
        class="img"
        :class="[`bd-${backdrop}`, { grabbing: panning }]"
        :style="imgStyle"
        alt="预览"
        draggable="false"
        @click.stop
        @dblclick.stop="toggleZoom"
        @pointerdown.stop="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
      />
    </div>
  </n-modal>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { NModal } from 'naive-ui'
import { fadeIn } from '@/utils/motion'
import { backdrop, cycleBackdrop, BACKDROP_LABEL } from './backdrop'

/** One entry in the flat, grid-wide list the arrows walk through. */
export interface PreviewItem {
  src: string
  label: string
  sub?: string
}

const props = defineProps<{ show: boolean; items: PreviewItem[]; start: number }>()
const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
}>()

const index = ref(0)
const scale = ref(1)
const tx = ref(0)
const ty = ref(0)
const panning = ref(false)
const imgEl = ref<HTMLImageElement | null>(null)

const MIN = 0.1
const MAX = 12

const current = computed(() => props.items[index.value])
const caption = computed(() => current.value?.label ?? '')
const captionFull = computed(() =>
  [current.value?.label, current.value?.sub].filter(Boolean).join('  ·  ')
)

const imgStyle = computed(() => ({
  transform: `translate(${tx.value}px, ${ty.value}px) scale(${scale.value})`,
  // Panning should feel direct; stepping between images should not jump.
  transition: panning.value ? 'none' : 'transform 0.12s ease-out',
}))

/** Fit-to-window is the browser's own layout, so "1" is just an untransformed
 *  image and zoom is expressed relative to that. */
function reset() {
  scale.value = 1
  tx.value = 0
  ty.value = 0
}

/** Scale that renders the image at its true pixel size, given that it is laid
 *  out shrunk-to-fit by CSS. */
function actualSize() {
  const el = imgEl.value
  if (!el || !el.clientWidth) return
  scale.value = clamp(el.naturalWidth / el.clientWidth)
  tx.value = 0
  ty.value = 0
}

function clamp(v: number) {
  return Math.min(MAX, Math.max(MIN, v))
}

function zoomBy(factor: number) {
  scale.value = clamp(scale.value * factor)
  if (scale.value === 1) {
    tx.value = 0
    ty.value = 0
  }
}

function toggleZoom() {
  if (scale.value > 1.01) reset()
  else actualSize()
}

/** Zoom toward the cursor rather than the centre, so the point under the mouse
 *  stays put — otherwise zooming into a detail means chasing it with pans. */
function onWheel(e: WheelEvent) {
  const el = imgEl.value
  if (!el) return
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
  const next = clamp(scale.value * factor)
  if (next === scale.value) return

  const r = el.getBoundingClientRect()
  const cx = e.clientX - (r.left + r.width / 2)
  const cy = e.clientY - (r.top + r.height / 2)
  const ratio = next / scale.value

  tx.value = tx.value - cx * (ratio - 1)
  ty.value = ty.value - cy * (ratio - 1)
  scale.value = next
  if (next === 1) {
    tx.value = 0
    ty.value = 0
  }
}

let startX = 0
let startY = 0

function onPointerDown(e: PointerEvent) {
  if (scale.value <= 1) return
  panning.value = true
  startX = e.clientX - tx.value
  startY = e.clientY - ty.value
  ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
}

function onPointerMove(e: PointerEvent) {
  if (!panning.value) return
  tx.value = e.clientX - startX
  ty.value = e.clientY - startY
}

function onPointerUp() {
  panning.value = false
}

/** Walk the whole grid, wrapping at both ends. Zoom resets so a new image never
 *  opens scrolled off-screen at 8×. */
function step(delta: number) {
  const n = props.items.length
  if (!n) return
  index.value = (index.value + delta + n) % n
  reset()
  nextTick(() => {
    if (imgEl.value) fadeIn(imgEl.value, 160)
  })
}

function close() {
  emit('update:show', false)
}

function onKey(e: KeyboardEvent) {
  if (!props.show) return
  switch (e.key) {
    case 'ArrowLeft': step(-1); break
    case 'ArrowRight': step(1); break
    case 'Escape': close(); break
    case '+': case '=': zoomBy(1.25); break
    case '-': case '_': zoomBy(1 / 1.25); break
    case '0': reset(); break
    case '1': actualSize(); break
    case 'b': case 'B': cycleBackdrop(); break
    default: return
  }
  e.preventDefault()
}

// Opening always starts on the thumbnail that was clicked, at fit size.
watch(() => props.show, async v => {
  if (!v) return
  index.value = Math.min(Math.max(0, props.start), Math.max(0, props.items.length - 1))
  reset()
  await nextTick()
  // Opacity only: this image's transform is bound to the zoom/pan state, so
  // animating transform here would be overwritten on the next re-render.
  if (imgEl.value) fadeIn(imgEl.value)
})

// A batch can finish while the viewer is open and shrink the list under it.
watch(() => props.items.length, n => {
  if (index.value >= n) index.value = Math.max(0, n - 1)
})

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<style scoped>
.viewer {
  position: relative;
  width: 100vw; height: 100vh;
  display: flex; align-items: center; justify-content: center;
  overflow: hidden;
}

.img {
  max-width: 92vw; max-height: 88vh;
  border-radius: 8px;
  cursor: grab;
  user-select: none;
  will-change: transform;
  /* Panning is driven by pointer events. Without this the browser claims the
     drag for its own scroll/zoom on a touch screen and pointermove never
     arrives, so a zoomed-in image cannot be moved. Same reason MaskEditor's
     canvas sets it. */
  touch-action: none;
  /* Backdrop comes from the bd-* class, which the toolbar cycles. Nothing is set
     here: a background declared on this rule would out-specify the shared class
     and freeze the one control that makes transparency verifiable. */
}
.img.grabbing { cursor: grabbing; }

/* ===== Toolbar ===== */
.toolbar {
  position: absolute;
  top: 16px; left: 50%;
  transform: translateX(-50%);
  z-index: 2;
  display: flex; align-items: center; gap: 6px;
  padding: 6px 10px;
  border-radius: 999px;
  background: rgba(20, 26, 34, 0.82);
  color: #fff;
  font-size: 12px;
  backdrop-filter: blur(6px);
  max-width: 92vw;
}
.counter, .zoom-num {
  font-variant-numeric: tabular-nums;
  min-width: 42px;
  text-align: center;
  opacity: 0.85;
}
.divider {
  width: 1px; height: 14px;
  background: rgba(255, 255, 255, 0.25);
}
.caption {
  max-width: 32vw;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  opacity: 0.8;
}

.tool {
  min-width: 26px; height: 24px;
  padding: 0 6px;
  border: none; border-radius: 6px;
  background: transparent;
  color: #fff;
  font-size: 14px; line-height: 1;
  cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
}
.tool.wide { font-size: 11px; }
.tool:hover { background: rgba(255, 255, 255, 0.18); }

/* Backdrop switch: carries a swatch of what it is about to show, so the control
   reads as "the background is a setting" rather than as part of the image. */
.bd-btn { gap: 6px; padding: 0 9px; }
.bd-swatch {
  width: 12px; height: 12px;
  border-radius: 3px;
  border: 1px solid rgba(255, 255, 255, 0.45);
  flex-shrink: 0;
  /* The shared bd-* classes size their checkerboard for a full image; scale it
     down so a 12px swatch still reads as a checkerboard rather than one square. */
  background-size: 8px 8px !important;
  background-position: 0 0, 4px 4px !important;
}

/* ===== Arrows ===== */
.nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  z-index: 2;
  width: 40px; height: 68px;
  border: none; border-radius: 8px;
  background: rgba(20, 26, 34, 0.55);
  color: #fff;
  font-size: 30px; line-height: 1;
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: background 0.15s;
}
.nav:hover { background: rgba(20, 26, 34, 0.85); }
.nav.prev { left: 18px; }
.nav.next { right: 18px; }

/* ===== Responsive ===== */
@media (max-width: 640px) {
  /* Nine items in one row overflow a phone. Wrapping keeps every control
     reachable instead of pushing the close button off the edge. */
  .toolbar {
    flex-wrap: wrap;
    justify-content: center;
    max-width: 96vw;
    border-radius: 14px;
    top: 8px;
    gap: 4px 6px;
  }
  .caption { max-width: 88vw; order: 1; flex-basis: 100%; text-align: center; }
  /* The dividers only make sense in a single row */
  .divider { display: none; }

  .nav { width: 32px; height: 56px; font-size: 24px; }
  .nav.prev { left: 6px; }
  .nav.next { right: 6px; }

  .img { max-width: 96vw; max-height: 74vh; }
}

/* Touch: the viewer is driven by pinch/drag, so the buttons need real targets. */
@media (hover: none) {
  .tool { min-width: 34px; height: 32px; }
}
</style>
