<template>
  <div class="panel">
    <!-- ===== Config card (collapsible) ===== -->
    <div class="config-card nm-raised">
      <div
        class="config-head head-clickable"
        :title="store.paramsCollapsed ? '点击展开参数' : '点击收起参数'"
        @click="onHeadClick"
      >
        <div class="collapse-btn">
          <span class="chev" :class="{ open: !store.paramsCollapsed }">›</span>
          <span class="collapse-label">参数</span>
        </div>

        <!-- Two documented surfaces, one param body and one result grid below. -->
        <div class="tabs">
          <button class="tab" :class="{ on: store.mode === 'native' }" @click="switchMode('native', $event)">
            原生 generateContent
          </button>
          <button class="tab" :class="{ on: store.mode === 'openai' }" @click="switchMode('openai', $event)">
            OpenAI 兼容
          </button>
        </div>

        <div class="head-info">
          <span class="count-badge nm-inset">
            {{ shownRequests }} 请求 / {{ shownImages }} 图
          </span>
        </div>

        <div class="head-actions">
          <button
            v-if="store.generating"
            class="btn btn-sm btn-danger"
            title="停止整批，已完成的卡片保留"
            @click="store.stop()"
          >
            <span class="btn-icon">■</span> 全部停止
          </button>
          <button
            v-if="visibleJobs.length && !store.generating"
            class="btn btn-sm"
            title="移除下方所有结果卡片"
            @click="store.clearJobs()"
          >
            <span class="btn-icon">🗑</span> 清除结果
          </button>
        </div>
      </div>

      <div v-show="!store.paramsCollapsed" ref="bodyEl" class="config-body">
        <!-- Prompt -->
        <div class="field">
          <div class="field-label">
            提示词
            <span class="text-muted" style="font-weight:400">{{ store.prompt.length }} 字</span>
          </div>
          <n-input
            v-model:value="store.prompt"
            type="textarea"
            placeholder="描述你想生成的图片..."
            :rows="3"
            class="prompt-input"
          />
        </div>

        <!-- Models. Required, not optional: the id goes in the URL path, so there
             is no "leave it to the API" case for this one. -->
        <div class="field">
          <div class="field-label">
            模型
            <span class="text-muted" style="font-weight:400">
              {{ store.mode === 'openai' ? '此接口文档只列出 1 个模型' : `已选 ${store.matrix.models.length} / ${store.availableModels.length}` }}
            </span>
            <span class="spacer" />
            <button
              v-if="store.mode === 'native'"
              class="btn btn-xs"
              @click="store.matrix.models = store.availableModels.map(m => m.id)"
            >全选</button>
          </div>
          <div class="chips models">
            <button
              v-for="m in store.availableModels" :key="m.id"
              class="chip model-chip" :class="{ on: store.matrix.models.includes(m.id) }"
              :title="m.note"
              @click="toggleModel(m.id)"
            >
              {{ m.id }}
              <span class="chip-note">{{ m.note }}</span>
            </button>
          </div>
        </div>

        <!-- Native-only params. The OpenAI-compatible doc documents no size,
             ratio or safety knobs, so offering them there would be inventing an
             API surface. -->
        <template v-if="store.mode === 'native'">
          <!-- aspectRatio -->
          <div class="field">
            <div class="field-label">
              比例 aspectRatio
              <span class="text-muted" style="font-weight:400">
                {{ store.matrix.aspectRatios.length ? `×${store.matrix.aspectRatios.length}` : '默认 1:1' }}
              </span>
              <span class="spacer" />
              <button class="btn btn-xs" @click="store.matrix.aspectRatios = [...COMMON_RATIOS]">通用全选</button>
              <button
                class="btn btn-xs"
                :disabled="!store.matrix.aspectRatios.length"
                @click="store.matrix.aspectRatios = []"
              >清空</button>
            </div>
            <div class="chips">
              <button
                v-for="r in ALL_RATIOS" :key="r"
                class="chip"
                :class="{ on: store.matrix.aspectRatios.includes(r), warn: ratioUnsupported(r) }"
                :title="ratioUnsupported(r)
                  ? '文档称仅 Flash 2（3.1）支持此比例，当前所选模型中有不支持的'
                  : undefined"
                @click="toggle(store.matrix.aspectRatios, r)"
              >{{ r }}</button>
            </div>
          </div>

          <!-- imageSize -->
          <div class="field">
            <div class="field-label">
              分辨率 imageSize
              <span class="text-muted" style="font-weight:400">
                {{ store.matrix.imageSizes.length ? `×${store.matrix.imageSizes.length}` : '默认 1K' }}
              </span>
              <span class="spacer" />
              <button
                class="btn btn-xs"
                :disabled="!store.matrix.imageSizes.length"
                @click="store.matrix.imageSizes = []"
              >清空</button>
            </div>
            <div class="chips">
              <button
                v-for="s in IMAGE_SIZES" :key="s.value"
                class="chip"
                :class="{ on: store.matrix.imageSizes.includes(s.value), warn: sizeUnsupported(s.value) }"
                :title="sizeTitle(s)"
                @click="toggle(store.matrix.imageSizes, s.value)"
              >
                {{ s.value }}
                <span v-if="'probe' in s" class="chip-flag">probe</span>
              </button>
            </div>
          </div>

          <!-- responseModalities -->
          <div class="field">
            <div class="field-label">
              responseModalities
              <span class="text-muted" style="font-weight:400">
                文档要求必须包含 IMAGE，否则只返回文本
              </span>
            </div>
            <div class="chips">
              <button
                v-for="m in MODALITY_SETS" :key="m.value"
                class="chip" :class="{ on: store.matrix.modalities.includes(m.value) }"
                :title="m.note"
                @click="toggle(store.matrix.modalities, m.value)"
              >{{ m.label }}</button>
            </div>
          </div>

          <!-- safetySettings: one threshold across all five documented categories,
               which is how the official example sets them. -->
          <div class="field">
            <div class="field-label">
              safetySettings
              <span class="text-muted" style="font-weight:400">
                不选则整块不发送 · 一档同时应用于 5 个类别
              </span>
            </div>
            <div class="chips">
              <button
                v-for="t in SAFETY_THRESHOLDS" :key="t"
                class="chip" :class="{ on: store.matrix.safetyThreshold === t }"
                @click="store.matrix.safetyThreshold = store.matrix.safetyThreshold === t ? null : t"
              >{{ t }}</button>
            </div>
          </div>
        </template>

        <!-- Numeric params -->
        <div class="num-grid">
          <div class="field">
            <div class="field-label">temperature <span class="text-muted" style="font-weight:400">默认 1.0</span></div>
            <n-input-number
              v-model:value="store.matrix.temperature"
              :min="0" :max="2" :step="0.1" size="small" style="width:100%"
              placeholder="默认 1.0" clearable
            />
          </div>
          <div v-if="store.mode === 'native'" class="field">
            <div class="field-label">candidateCount <span class="text-muted" style="font-weight:400">默认 1</span></div>
            <n-input-number
              v-model:value="store.matrix.candidateCount"
              :min="1" :max="8" size="small" style="width:100%"
              placeholder="默认 1" clearable
            />
          </div>
          <div class="field">
            <div class="field-label">最大并发数</div>
            <n-input-number v-model:value="store.matrix.concurrency" :min="1" :max="50" size="small" style="width:100%" />
          </div>
        </div>

        <!-- The OpenAI-compatible doc contradicts itself; saying so here is more
             useful than silently picking one reading. -->
        <p v-if="store.mode === 'openai'" class="doc-note text-muted">
          文档的 requestBody schema 写的是 prompt / n / size，但同一页的示例发送的是
          model / messages / stream。示例才是这个端点实际接受的形状，因此本模块按示例发送，
          并固定带上 <code>modalities: ["text","image"]</code>；stream 不发送，否则无法完整测量字节与格式。
        </p>
      </div>
    </div>

    <!-- ===== Results ===== -->
    <div v-if="visibleJobs.length" ref="gridEl" class="results-grid">
      <BananaCard
        v-for="job in visibleJobs"
        :key="job.id"
        :job="job"
        @preview="openPreview"
        @stop="store.stopJob"
      />
    </div>

    <div v-else class="empty-state text-muted">
      <div class="empty-icon">🍌</div>
      <p>选择模型与参数，点右上角「生成」开始并发测试</p>
    </div>

    <ImagePreview v-model:show="previewVisible" :items="previewItems" :start="previewStart" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { NInput, NInputNumber } from 'naive-ui'
import { useBananaGenStore } from '@/stores/bananaGen'
import { enterCards, fadeInUp, pulse, countTo } from '@/utils/motion'
import {
  ALL_RATIOS, COMMON_RATIOS, IMAGE_SIZES, MODALITY_SETS, SAFETY_THRESHOLDS,
  ratioSupported, sizeSupported, effectiveSize,
} from '@/utils/bananaSpec'
import BananaCard from './BananaCard.vue'
import ImagePreview, { type PreviewItem } from '@/components/imageGen/ImagePreview.vue'
import type { BananaJob, BananaMode } from '@/types'

/** Prompt, matrix and mode all live in the store: the run button sits in the top
 *  bar, in a different component tree, and needs the same state. */
const store = useBananaGenStore()

/** Jobs for whichever surface is active. The two pools are separate so switching
 *  tabs never loses the other side's results. */
const visibleJobs = computed(() =>
  store.mode === 'openai' ? store.openaiJobs : store.nativeJobs
)

const previewVisible = ref(false)
const previewStart = ref(0)
const gridEl = ref<HTMLElement | null>(null)
const bodyEl = ref<HTMLElement | null>(null)

/** Switching surfaces swaps the whole param body, so the new content is revealed
 *  rather than replaced instantly. The model list differs between the two, so the
 *  selection is reset to that surface's default. */
function switchMode(next: BananaMode, e: MouseEvent) {
  if (store.mode === next) return
  store.mode = next
  store.matrix.models = [store.availableModels[0].id]
  pulse(e.currentTarget as HTMLElement)
  nextTick(() => {
    if (bodyEl.value) fadeInUp(bodyEl.value, { distance: 6 })
  })
}

/** Collapse/expand from anywhere on the header strip. The tabs and the
 *  stop/clear buttons live in the same strip, so anything interactive is
 *  excluded — switching surface must not also collapse the body. */
function onHeadClick(e: MouseEvent) {
  const el = e.target as HTMLElement
  if (el.closest('button, a, input, .tabs')) return
  store.paramsCollapsed = !store.paramsCollapsed
}

/** Toggle membership in one of the matrix arrays. Clearing the last one is
 *  allowed — an empty group means "unset", not "invalid". */
function toggle(arr: string[], v: string) {
  const i = arr.indexOf(v)
  if (i >= 0) arr.splice(i, 1)
  else arr.push(v)
}

/** The model list is the exception: emptying it would produce no request at all,
 *  since the id is part of the URL. */
function toggleModel(id: string) {
  const i = store.matrix.models.indexOf(id)
  if (i >= 0) {
    if (store.matrix.models.length > 1) store.matrix.models.splice(i, 1)
  } else {
    store.matrix.models.push(id)
  }
}

/** Whether any currently selected model lacks documented support. Flagged rather
 *  than disabled: sending an unsupported combination on purpose is how the
 *  documented fallback gets verified. */
function ratioUnsupported(ratio: string) {
  return store.matrix.models.some(m => !ratioSupported(m, ratio))
}

function sizeUnsupported(size: string) {
  return store.matrix.models.some(m => !sizeSupported(m, size))
}

function sizeTitle(s: typeof IMAGE_SIZES[number]) {
  if ('probe' in s) return s.probe
  const bad = store.matrix.models.filter(m => !sizeSupported(m, s.value))
  if (!bad.length) return '所选模型均支持'
  return `文档称以下模型不支持，会回退到 ${effectiveSize(bad[0], s.value)}：\n` + bad.join('\n')
}

/** Counters tween to their new value, so a matrix change reads as the batch
 *  growing rather than a number silently swapping. */
const shownRequests = ref(store.totalRequests)
const shownImages = ref(store.totalImages)

watch(() => store.totalRequests, (to, from) => countTo(from, to, v => (shownRequests.value = v)))
watch(() => store.totalImages, (to, from) => countTo(from, to, v => (shownImages.value = v)))

/** Animate only cards that have not been seen before. Keyed on job id rather
 *  than index, because new jobs are unshifted onto the front of the list. */
const animatedJobs = new Set<number>()

watch(() => visibleJobs.value.map(j => j.id).join(','), async () => {
  await nextTick()
  const grid = gridEl.value
  if (!grid) {
    if (!visibleJobs.value.length) animatedJobs.clear()
    return
  }
  const fresh = Array.from(grid.querySelectorAll<HTMLElement>('.card')).filter(el => {
    const id = Number(el.dataset.job)
    if (!id || animatedJobs.has(id)) return false
    animatedJobs.add(id)
    return true
  })
  enterCards(fresh)

  // Drop ids the pool has since evicted; ids only increase, so an evicted one can
  // never come back and be re-animated.
  if (animatedJobs.size > visibleJobs.value.length) {
    const live = new Set(visibleJobs.value.map(j => j.id))
    animatedJobs.forEach(id => { if (!live.has(id)) animatedJobs.delete(id) })
  }
})

/** Every rendered image in the grid, flattened in display order, so the viewer's
 *  arrows walk the whole batch instead of stopping at the card boundary. */
const previewItems = computed<PreviewItem[]>(() =>
  visibleJobs.value.flatMap(job =>
    job.images
      .filter(img => !!img.src)
      .map((img, i) => ({
        src: img.src!,
        label: [
          job.model,
          job.aspectRatio ?? '默认 1:1',
          job.imageSize ?? '默认 1K',
          job.images.length > 1 ? `第 ${i + 1}/${job.images.length} 张` : '',
        ].filter(Boolean).join(' · '),
        sub: img.width ? `${img.width}×${img.height}` : undefined,
      }))
  )
)

/** Map a click on one card's thumbnail to its position in that flat list. */
function openPreview(job: BananaJob) {
  let offset = 0
  for (const j of visibleJobs.value) {
    const shown = j.images.filter(img => !!img.src)
    if (j.id === job.id) {
      const img = j.images[j.activeIndex]
      const local = img ? shown.indexOf(img) : 0
      previewStart.value = offset + Math.max(0, local)
      previewVisible.value = true
      return
    }
    offset += shown.length
  }
}
</script>

<style scoped>
.panel { display: flex; flex-direction: column; gap: 16px; }

/* ===== Config card ===== */
.config-card {
  background: var(--bg);
  border-radius: var(--radius-card);
  padding: 14px 18px;
}

.config-head {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}
.config-head.head-clickable { cursor: pointer; }
.config-head.head-clickable button,
.config-head.head-clickable .tabs { cursor: default; }

.collapse-btn {
  display: flex; align-items: center; gap: 6px;
  background: transparent;
  color: var(--text-primary);
  font-size: 13px; font-weight: 600;
  padding: 4px 0;
  pointer-events: none; /* click is handled by the parent strip */
}
.chev {
  display: inline-block;
  font-size: 18px; line-height: 1;
  transition: transform 0.2s;
}
.chev.open { transform: rotate(90deg); }
.collapse-label { user-select: none; }

.head-info { display: flex; align-items: center; gap: 10px; }

.tabs {
  display: flex; gap: 4px;
  padding: 3px;
  border-radius: 9px;
  box-shadow: inset 3px 3px 6px var(--shadow-dark), inset -3px -3px 6px var(--shadow-light);
}
.tab {
  padding: 4px 14px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text-primary);
  font-size: 12px; font-weight: 600;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.tab:hover { color: var(--accent-strong); }
.tab.on { color: #fff; background: var(--accent-strong); }

.count-badge {
  padding: 4px 12px;
  border-radius: 999px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.head-actions {
  margin-left: auto;
  display: flex; align-items: center; gap: 10px;
}

.btn-icon { font-size: 12px; }

.config-body {
  display: flex; flex-direction: column; gap: 16px;
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--shadow-dark);
}

.field { display: flex; flex-direction: column; gap: 7px; }
.field-label {
  display: flex; align-items: center; gap: 8px;
  font-size: 12px; font-weight: 600;
  color: var(--text-primary);
  flex-wrap: wrap;
}
.spacer { flex: 1; }

.prompt-input :deep(.n-input__textarea-el) {
  background: transparent !important;
  font-size: 12.5px;
  line-height: 1.6;
}

/* ===== Chips ===== */
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
.chip {
  position: relative;
  padding: 5px 13px;
  border: none;
  border-radius: 7px;
  background: var(--bg);
  color: var(--text-primary);
  font-size: 11.5px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 2px 2px 4px var(--shadow-dark), -2px -2px 4px var(--shadow-light);
  transition: color 0.15s, background 0.15s;
}
.chip:hover { color: var(--accent-strong); }
.chip.on {
  color: #fff;
  background: var(--accent-strong);
  box-shadow: inset 2px 2px 4px rgba(0, 0, 0, 0.18);
}

/* Documented as unsupported by at least one selected model. Marked, not
   disabled — sending it on purpose is how the fallback gets verified. */
.chip.warn { color: var(--danger); }
.chip.warn.on { color: #fff; background: var(--danger); }

/* Model chips carry their doc note on a second line, so they are wider */
.chips.models { flex-direction: column; align-items: stretch; }
.model-chip {
  display: flex; align-items: baseline; gap: 8px;
  text-align: left;
  font-family: 'Consolas', 'Menlo', 'Monaco', monospace;
}
.chip-note {
  margin-left: auto;
  font-family: inherit;
  font-size: 10px;
  font-weight: 400;
  opacity: 0.75;
}
.chip-flag {
  margin-left: 5px;
  font-size: 9px;
  font-weight: 700;
  opacity: 0.7;
}

.num-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 14px;
}

/* Where the docs contradict themselves, saying so beats picking a reading */
.doc-note {
  font-size: 11px;
  line-height: 1.6;
  padding: 9px 12px;
  border-radius: var(--radius-input);
  box-shadow: inset 2px 2px 4px var(--shadow-dark), inset -2px -2px 4px var(--shadow-light);
}
.doc-note code {
  font-family: 'Consolas', 'Menlo', 'Monaco', monospace;
  font-size: 10.5px;
}

/* ===== Results ===== */
.results-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 14px;
}

.empty-state {
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  min-height: 260px; gap: 12px; text-align: center;
}
.empty-icon { font-size: 48px; opacity: 0.4; }

/* ===== Responsive ===== */
@media (max-width: 640px) {
  .config-card { padding: 10px 12px; }
  .results-grid { grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); }
  .tab { padding: 4px 10px; font-size: 11px; }
}
</style>
