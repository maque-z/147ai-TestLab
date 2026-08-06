<template>
  <div class="panel">
    <!-- ===== Config card (collapsible) ===== -->
    <div class="config-card nm-raised">
      <div class="config-head">
        <button class="collapse-btn" :title="collapsed ? '展开参数' : '收起参数'" @click="collapsed = !collapsed">
          <span class="chev" :class="{ open: !collapsed }">›</span>
          <span class="collapse-label">参数</span>
        </button>

        <!-- Two endpoints, one param matrix and one result grid below. -->
        <div class="tabs">
          <button class="tab" :class="{ on: mode === 'generate' }" @click="switchMode('generate', $event)">
            生成
          </button>
          <button class="tab" :class="{ on: mode === 'edit' }" @click="switchMode('edit', $event)">
            编辑
          </button>
        </div>

        <div class="head-info">
          <span class="count-badge nm-inset">
            {{ shownRequests }} 请求 / {{ shownImages }} 图
          </span>
          <span v-if="store.generating" class="progress text-muted">
            <n-spin :size="12" />
            {{ store.doneCount }} / {{ store.totalCount }}
          </span>
        </div>

        <div class="head-actions">
          <!-- Hidden mid-batch: clearing the array detaches the cards the running
               pool is still writing to, so its progress would vanish silently. -->
          <n-button
            v-if="store.jobs.length && !store.generating"
            text size="small"
            @click="store.clearJobs()"
          >清除结果</n-button>

          <button v-if="store.generating" class="stop-btn nm-btn" @click="store.stop()">
            ■ 停止
          </button>
          <button
            v-else
            class="gen-btn nm-btn"
            :disabled="!canRun"
            :title="blockReason"
            @click="handleGenerate"
          >
            ✨ {{ mode === 'edit' ? '编辑' : '生成' }} {{ shownImages }} 张
          </button>
        </div>
      </div>

      <div v-show="!collapsed" ref="bodyEl" class="config-body">
        <!-- Edit-only inputs: the first upload is the canvas, the rest are
             references, and the mask applies to the first one only. -->
        <template v-if="mode === 'edit'">
          <RefImages v-model="refImages" />

          <div class="field">
            <div class="field-label">
              蒙版
              <span class="text-muted" style="font-weight:400">
                可选 · 涂抹处会被重绘 · 只作用于主图
              </span>
              <span class="spacer" />
              <span class="mask-flag" :class="{ on: !!mask }">
                {{ mask ? '本次将上传蒙版' : '本次不上传蒙版' }}
              </span>
            </div>
            <MaskEditor :image="refImages[0] ?? null" @change="mask = $event" />
          </div>
        </template>

        <!-- Prompt -->
        <div class="field">
          <div class="field-label">
            提示词
            <span class="text-muted" style="font-weight:400">{{ prompt.length }} 字</span>
          </div>
          <n-input
            v-model:value="prompt"
            type="textarea"
            :placeholder="mode === 'edit' ? '描述要如何修改这些图片...' : '描述你想生成的图片...'"
            :rows="3"
            class="prompt-input"
          />
        </div>

        <!-- Size matrix -->
        <div class="field">
          <div class="field-label">
            图片尺寸
            <span class="text-muted" style="font-weight:400">
              {{ matrix.sizes.length ? `已选 ${matrix.sizes.length} / ${ALL_SIZES.length}` : `默认 ${DEFAULTS.size}` }}
            </span>
            <span class="spacer" />
            <n-button text size="tiny" @click="selectAllSizes">全选</n-button>
            <n-button text size="tiny" @click="matrix.sizes = []">清空</n-button>
          </div>
          <table class="size-table">
            <thead>
              <tr>
                <th class="ratio-th">比例</th>
                <th v-for="(tier, ti) in TIERS" :key="tier" @click="toggleCol(ti)">
                  {{ tier }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in SIZE_TABLE" :key="row.ratio">
                <td class="ratio-td" @click="toggleRow(row)">{{ row.ratio }}</td>
                <td
                  v-for="size in row.sizes"
                  :key="size"
                  class="size-cell"
                  :class="{ on: matrix.sizes.includes(size) }"
                  @click="toggleSize(size)"
                >
                  {{ size.replace('x', '×') }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Chip groups. Nothing selected == send nothing and let the API pick
             its own default, so there is no explicit "auto" option to click. -->
        <div class="chip-grid">
          <div class="field">
            <div class="field-label">
              质量
              <span class="text-muted" style="font-weight:400">{{ multLabel(matrix.qualities, DEFAULTS.quality) }}</span>
            </div>
            <div class="chips">
              <button
                v-for="o in QUALITIES" :key="o"
                class="chip" :class="{ on: matrix.qualities.includes(o) }"
                @click="toggle(matrix.qualities, o)"
              >{{ o }}</button>
            </div>
          </div>

          <div class="field">
            <div class="field-label">
              输出格式
              <span class="text-muted" style="font-weight:400">{{ multLabel(matrix.formats, DEFAULTS.format) }}</span>
            </div>
            <div class="chips">
              <button
                v-for="o in FORMATS" :key="o"
                class="chip" :class="{ on: matrix.formats.includes(o) }"
                @click="toggle(matrix.formats, o)"
              >{{ o }}</button>
            </div>
          </div>

          <div class="field">
            <div class="field-label">
              内容审核
              <span class="text-muted" style="font-weight:400">{{ multLabel(matrix.moderations, DEFAULTS.moderation) }}</span>
            </div>
            <div class="chips">
              <button
                v-for="o in MODERATIONS" :key="o"
                class="chip" :class="{ on: matrix.moderations.includes(o) }"
                @click="toggle(matrix.moderations, o)"
              >{{ o }}</button>
            </div>
          </div>
        </div>

        <!-- Numeric params -->
        <div class="num-grid">
          <div class="field">
            <div class="field-label">每请求张数 (n)</div>
            <n-input-number v-model:value="matrix.n" :min="1" :max="10" size="small" style="width:100%" />
          </div>
          <div class="field">
            <div class="field-label">压缩质量 <span class="text-muted" style="font-weight:400">jpeg/webp</span></div>
            <n-input-number
              v-model:value="matrix.output_compression"
              :min="1" :max="100" size="small" style="width:100%"
              :placeholder="`默认 ${DEFAULTS.compression}`"
              clearable
              :disabled="!hasLossyFormat"
            />
          </div>
          <div class="field">
            <div class="field-label">并发数</div>
            <n-input-number v-model:value="matrix.concurrency" :min="1" :max="30" size="small" style="width:100%" />
          </div>
        </div>
      </div>
    </div>

    <!-- ===== Results ===== -->
    <div v-if="store.jobs.length" ref="gridEl" class="results-grid">
      <div v-for="job in store.jobs" :key="job.id" class="card nm-raised" :data-job="job.id">
        <div class="canvas" @click="activeImg(job)?.src && openPreview(job)">
          <img
            v-if="activeImg(job)?.src"
            :src="activeImg(job)!.src"
            :alt="job.size ?? '生成结果'"
            class="thumb"
            @load="onImgLoad(job, $event)"
          />
          <div v-else-if="job.status === 'error'" class="canvas-state err" :title="job.error">
            <span class="state-icon">⚠️</span>
            <span class="err-text">{{ job.error }}</span>
          </div>
          <div v-else-if="job.status === 'cancelled'" class="canvas-state">
            <span class="state-icon dim">⊘</span>
            <span class="text-muted state-label">已取消</span>
          </div>
          <div v-else class="canvas-state">
            <n-spin v-if="job.status === 'running'" size="small" />
            <span v-else class="state-icon dim">⏳</span>
            <span class="text-muted state-label">
              {{ job.status === 'running' ? '生成中' : '排队中' }}
            </span>
          </div>

          <!-- Carousel, only when the request actually returned more than one
               image. Its presence is itself the signal that n took effect. -->
          <template v-if="job.images.length > 1">
            <button class="nav prev" title="上一张" @click.stop="step(job, -1)">‹</button>
            <button class="nav next" title="下一张" @click.stop="step(job, 1)">›</button>
            <div class="pager">{{ job.activeIndex + 1 }} / {{ job.images.length }}</div>
          </template>
        </div>

        <div class="meta">
          <!-- Every determinable param as 请求 → 实际, so a value the API changed
               silently is visible instead of being overwritten. -->
          <div class="meta-head">
            <span>项</span>
            <span>请求</span>
            <span>→ 实际</span>
          </div>
          <div
            v-for="row in compareRows(job)"
            :key="row.label"
            class="meta-row3"
            :class="{ bad: row.bad }"
          >
            <span class="text-muted">{{ row.label }}</span>
            <span>{{ row.want }}</span>
            <span :title="row.bad ? '与请求不一致' : undefined">{{ row.got }}</span>
          </div>

          <div class="meta-row plain">
            <span class="text-muted">文件大小</span>
            <span>{{ activeImg(job)?.bytes ? fmtBytes(activeImg(job)!.bytes!) : '—' }}</span>
          </div>
          <div class="meta-row plain">
            <span class="text-muted">耗时</span>
            <span>{{ job.elapsedMs ? fmtMs(job.elapsedMs) : '—' }}</span>
          </div>
          <div class="meta-row plain">
            <span class="text-muted">生成时间</span>
            <span :title="job.finishedAt ? fmtFullTime(job.finishedAt) : undefined">
              {{ job.finishedAt ? fmtTime(job.finishedAt) : '—' }}
            </span>
          </div>
          <div class="meta-row plain">
            <span class="text-muted">输出 token</span>
            <span class="strong-num">{{ job.outputTokens ?? '—' }}</span>
          </div>

          <!-- Input side as 提示词/参考图 on one line: reference images are
               processed at high fidelity, so on an edit they usually dwarf the
               prompt, and the split is what makes that visible. -->
          <div class="meta-row plain">
            <span class="text-muted">输入 token</span>
            <span :title="`提示词 ${job.inputTextTokens ?? '—'} / 参考图 ${job.inputImageTokens ?? '—'}`">
              <template v-if="job.inputTextTokens != null || job.inputImageTokens != null">
                <span class="text-muted split-label">提示词/参考图</span>
                {{ job.inputTextTokens ?? '—' }} / {{ job.inputImageTokens ?? '—' }}
              </template>
              <template v-else>{{ job.inputTokens ?? '—' }}</template>
            </span>
          </div>

          <div class="card-actions">
            <n-button v-if="activeImg(job)?.src" text size="tiny" @click.stop="download(job)">
              下载{{ job.images.length > 1 ? ` 第${job.activeIndex + 1}张` : '' }}
            </n-button>
            <span
              v-if="activeImg(job)?.revisedPrompt"
              class="text-muted revised"
              :title="activeImg(job)!.revisedPrompt"
            >提示词被改写</span>
          </div>
        </div>
      </div>
    </div>

    <div v-else class="empty-state text-muted">
      <div class="empty-icon">🖼️</div>
      <p>选择尺寸与参数，点击生成开始并发测试</p>
    </div>

    <!-- Preview: walks every image in the grid, not just the current card -->
    <ImagePreview v-model:show="previewVisible" :items="previewItems" :start="previewStart" />
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, nextTick } from 'vue'
import { useMessage, NInput, NInputNumber, NButton, NSpin } from 'naive-ui'
import { useImageGenStore } from '@/stores/imageGen'
import { enterCards, fadeInUp, pulse, countTo } from '@/utils/motion'
import RefImages from './RefImages.vue'
import MaskEditor from './MaskEditor.vue'
import ImagePreview, { type PreviewItem } from './ImagePreview.vue'
import type { GenMode, ImageJob, JobImage, ParamMatrix, RefImage } from '@/types'

const message = useMessage()
const store = useImageGenStore()
const collapsed = ref(false)
const previewVisible = ref(false)
const previewStart = ref(0)
const gridEl = ref<HTMLElement | null>(null)
const bodyEl = ref<HTMLElement | null>(null)

/** Which endpoint the next batch runs against. Both share the param matrix and
 *  the result grid below, so switching keeps everything else in place. */
const mode = ref<GenMode>('generate')
const refImages = ref<RefImage[]>([])
const mask = ref<Blob | null>(null)

/** Switching endpoints swaps the whole param body, so the new content is
 *  revealed rather than replaced instantly. */
function switchMode(next: GenMode, e: MouseEvent) {
  if (mode.value === next) return
  mode.value = next
  pulse(e.currentTarget as HTMLElement)
  nextTick(() => {
    if (bodyEl.value) fadeInUp(bodyEl.value, { distance: 6 })
  })
}

/** Official recommended sizes: 10 aspect ratios × 3 resolution tiers. */
const TIERS = ['~1K', '~2K', '~4K'] as const
const SIZE_TABLE = [
  { ratio: '1:1',  sizes: ['1024x1024', '2048x2048', '2880x2880'] },
  { ratio: '16:9', sizes: ['1280x720',  '2048x1152', '3840x2160'] },
  { ratio: '9:16', sizes: ['720x1280',  '1152x2048', '2160x3840'] },
  { ratio: '4:3',  sizes: ['1024x768',  '2048x1536', '3072x2304'] },
  { ratio: '3:4',  sizes: ['768x1024',  '1536x2048', '2304x3072'] },
  { ratio: '3:2',  sizes: ['1024x672',  '2048x1360', '3456x2304'] },
  { ratio: '2:3',  sizes: ['672x1024',  '1360x2048', '2304x3456'] },
  { ratio: '5:4',  sizes: ['1280x1024', '2560x2048', '3200x2560'] },
  { ratio: '4:5',  sizes: ['1024x1280', '2048x2560', '2560x3200'] },
  { ratio: '21:9', sizes: ['1344x576',  '2016x864',  '3840x1648'] },
]
const ALL_SIZES = SIZE_TABLE.flatMap(r => r.sizes)

/** Selectable values. No "auto" entry anywhere: leaving a group empty already
 *  means "send nothing and let the API apply its own default".
 *
 *  No background group either — gpt-image-2 rejects background=transparent, and
 *  opaque is what it does by default, so the param has nothing left to test.
 */
const QUALITIES   = ['low', 'medium', 'high']
const FORMATS     = ['png', 'jpeg', 'webp']
const MODERATIONS = ['low']

/** What the API falls back to when a param is left unset, per the official
 *  reference. Shown wherever a group is empty so "默认" is never a mystery. */
const DEFAULTS = {
  size: 'auto',
  quality: 'auto',
  format: 'png',
  moderation: 'auto',
  compression: 100,
} as const

const DEFAULT_PROMPT = `深圳一日游手绘地图插画，清新可爱手绘风格，旅行手账风，地图式俯视构图（top-down map illustration），整体布局清晰有层次，色彩明亮柔和，带轻微水彩质感。

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

const prompt = ref(DEFAULT_PROMPT)

// Everything starts unselected: the default run is one request with nothing but
// the prompt, which is the baseline every other combination is compared against.
const matrix = reactive<ParamMatrix>({
  sizes: [],
  qualities: [],
  formats: [],
  moderations: [],
  n: 1,
  output_compression: null,
  concurrency: 6,
})

/** An empty group still yields one request — the API's own default. */
const rowCount = (arr: unknown[]) => arr.length || 1

/** Clearing the input yields null, which would make the counts NaN. */
const perRequest = computed(() => matrix.n || 1)

const totalRequests = computed(() =>
  rowCount(matrix.sizes) * rowCount(matrix.qualities) *
  rowCount(matrix.formats) * rowCount(matrix.moderations)
)
const totalImages = computed(() => totalRequests.value * perRequest.value)
const hasLossyFormat = computed(() =>
  matrix.formats.includes('jpeg') || matrix.formats.includes('webp')
)

/** Label for a chip group: how many requests it multiplies the batch by, or the
 *  value the API will fall back to when nothing is picked. */
function multLabel(arr: unknown[], fallback: string | number) {
  return arr.length ? `×${arr.length}` : `默认 ${fallback}`
}

/** Toggle membership in one of the matrix arrays. Clearing the last one is
 *  allowed — an empty group means "unset", not "invalid". */
function toggle(arr: string[], v: string) {
  const i = arr.indexOf(v)
  if (i >= 0) arr.splice(i, 1)
  else arr.push(v)
}

function toggleSize(size: string) {
  const i = matrix.sizes.indexOf(size)
  if (i >= 0) matrix.sizes.splice(i, 1)
  else matrix.sizes.push(size)
}

function selectAllSizes() {
  matrix.sizes = [...ALL_SIZES]
}

/** Row/column headers act as bulk toggles: fill if any are missing, else clear. */
function toggleRow(row: { sizes: string[] }) {
  const missing = row.sizes.filter(s => !matrix.sizes.includes(s))
  if (missing.length) matrix.sizes.push(...missing)
  else matrix.sizes = matrix.sizes.filter(s => !row.sizes.includes(s))
}

function toggleCol(tierIndex: number) {
  const col = SIZE_TABLE.map(r => r.sizes[tierIndex])
  const missing = col.filter(s => !matrix.sizes.includes(s))
  if (missing.length) matrix.sizes.push(...missing)
  else matrix.sizes = matrix.sizes.filter(s => !col.includes(s))
}

/** Why the run button is disabled, surfaced as its tooltip rather than left for
 *  the user to guess. */
const blockReason = computed(() => {
  if (!prompt.value.trim()) return '请先填写提示词'
  if (mode.value === 'edit' && !refImages.value.length) return '编辑模式至少需要 1 张参考图'
  return ''
})
const canRun = computed(() => !blockReason.value && totalRequests.value > 0)

/** Counters tween to their new value, so a matrix change reads as the batch
 *  growing rather than a number silently swapping. */
const shownRequests = ref(totalRequests.value)
const shownImages = ref(totalImages.value)

watch(totalRequests, (to, from) => countTo(from, to, v => (shownRequests.value = v)))
watch(totalImages, (to, from) => countTo(from, to, v => (shownImages.value = v)))

/** Animate only cards that have not been seen before.
 *
 *  Keyed on job id rather than index, because new jobs are unshifted onto the
 *  front of the list — animating "the first N elements" would re-animate every
 *  older card each time a batch is queued.
 */
const animatedJobs = new Set<number>()

watch(() => store.jobs.map(j => j.id).join(','), async () => {
  await nextTick()
  const grid = gridEl.value
  if (!grid) {
    // Grid is unmounted when the list empties; let ids animate again if reused.
    if (!store.jobs.length) animatedJobs.clear()
    return
  }
  const fresh = Array.from(grid.querySelectorAll<HTMLElement>('.card')).filter(el => {
    const id = Number(el.dataset.job)
    if (!id || animatedJobs.has(id)) return false
    animatedJobs.add(id)
    return true
  })
  enterCards(fresh)
})

async function handleGenerate() {
  if (!canRun.value) return
  collapsed.value = true
  try {
    await store.generateMatrix(
      prompt.value,
      { ...matrix, sizes: [...matrix.sizes], n: perRequest.value },
      mode.value === 'edit'
        ? { images: refImages.value.map(r => r.file), mask: mask.value }
        : undefined,
    )
  } catch (e: any) {
    message.error(e?.message || '生成失败')
  }
}

/** The image the card is currently showing, or undefined before any arrive. */
function activeImg(job: ImageJob): JobImage | undefined {
  return job.images[job.activeIndex]
}

/** Move the carousel, wrapping at both ends. */
function step(job: ImageJob, delta: number) {
  const n = job.images.length
  if (n < 2) return
  job.activeIndex = (job.activeIndex + delta + n) % n
}

/** Real decoded pixels — the API can return something other than what was asked.
 *  Measured per image, since the carousel swaps which one is on screen. */
function onImgLoad(job: ImageJob, e: Event) {
  const el = e.target as HTMLImageElement
  const img = activeImg(job)
  if (!img) return
  img.width = el.naturalWidth
  img.height = el.naturalHeight
}

interface CompareRow {
  label: string
  want: string
  got: string
  bad?: boolean
}

/** Build the 请求 → 实际 rows for one card.
 *
 *  A row is only flagged when the API genuinely contradicted the request. An
 *  unset param delegates the choice to the API, so whatever comes back for it is
 *  correct by definition and never counts as a mismatch.
 */
function compareRows(job: ImageJob): CompareRow[] {
  const rows: CompareRow[] = []
  const DASH = '—'
  const img = activeImg(job)
  /** An unset param is shown as the value the API will actually apply, so the
   *  card never reads "默认" without saying what that resolved to. */
  const def = (v: string | number) => `默认 ${v}`

  const wantSize = job.size?.replace('x', '×')
  const gotSize = img?.width ? `${img.width}×${img.height}` : undefined
  rows.push({
    label: '尺寸',
    want: wantSize ?? def(DEFAULTS.size),
    got: gotSize ?? DASH,
    bad: !!wantSize && !!gotSize && gotSize !== wantSize,
  })

  rows.push({
    label: '格式',
    want: job.format ?? def(DEFAULTS.format),
    got: img?.actualFormat ?? DASH,
    bad: !!job.format && !!img?.actualFormat && img.actualFormat !== job.format,
  })

  // The API's own output_format claim, surfaced only when the bytes disagree
  if (job.declaredFormat && img?.actualFormat && job.declaredFormat !== img.actualFormat) {
    rows.push({
      label: '└ API 声称',
      want: job.declaredFormat,
      got: img.actualFormat,
      bad: true,
    })
  }

  // The headline check for n: how many images the request actually produced.
  rows.push({
    label: '张数 n',
    want: String(job.n),
    got: job.status === 'done' ? String(job.images.length) : DASH,
    bad: job.status === 'done' && job.images.length !== job.n,
  })

  // Edit-only inputs. Shown as requested-only because the API reports nothing
  // back about what it did with them.
  if (job.mode === 'edit') {
    rows.push({
      label: '参考图',
      want: `${job.refCount ?? 0} 张`,
      got: DASH,
    })
    rows.push({
      label: '蒙版',
      want: job.hasMask ? '已上传' : '未上传',
      got: DASH,
    })
  }

  // The API echoes none of these back, so only the requested value is knowable.
  rows.push({ label: '质量', want: job.quality ?? def(DEFAULTS.quality), got: DASH })
  rows.push({ label: '审核', want: job.moderation ?? def(DEFAULTS.moderation), got: DASH })
  // Compression only applies to the lossy formats, so it is only worth a row —
  // default included — once one of those was actually requested.
  if (job.format === 'jpeg' || job.format === 'webp') {
    rows.push({
      label: '压缩',
      want: job.compression != null ? String(job.compression) : def(DEFAULTS.compression),
      got: DASH,
    })
  }

  // The model is implied by the config, so it is only worth a row when the API
  // reports having used a different one — a gateway silently swapping models.
  if (job.actualModel && job.actualModel !== job.model) {
    rows.push({ label: '模型', want: job.model, got: job.actualModel, bad: true })
  }

  return rows
}

/** Every rendered image in the grid, flattened in display order, so the viewer's
 *  arrows walk the whole batch instead of stopping at the card boundary. */
const previewItems = computed<PreviewItem[]>(() =>
  store.jobs.flatMap(job =>
    job.images
      .filter(img => !!img.src)
      .map((img, i) => ({
        src: img.src!,
        label: [
          job.size?.replace('x', '×') ?? `默认 ${DEFAULTS.size}`,
          job.quality ?? `默认 ${DEFAULTS.quality}`,
          job.images.length > 1 ? `第 ${i + 1}/${job.images.length} 张` : '',
        ].filter(Boolean).join(' · '),
        sub: img.width ? `${img.width}×${img.height}` : undefined,
      }))
  )
)

/** Map a click on one card's thumbnail to its position in that flat list. */
function openPreview(job: ImageJob) {
  let offset = 0
  for (const j of store.jobs) {
    const shown = j.images.filter(img => !!img.src)
    if (j.id === job.id) {
      const img = activeImg(job)
      const local = img ? shown.indexOf(img) : 0
      previewStart.value = offset + Math.max(0, local)
      previewVisible.value = true
      return
    }
    offset += shown.length
  }
}

function download(job: ImageJob) {
  const img = activeImg(job)
  if (!img?.src) return
  // Name by the real format, not the requested one — they can differ.
  const ext = img.actualFormat ?? job.format ?? 'png'
  // Index suffix keeps the n images of one request from overwriting each other.
  const idx = job.images.length > 1 ? `_${job.activeIndex + 1}` : ''
  // Unset params are dropped from the name rather than labelled — the job id
  // already makes it unique.
  const parts = [job.size, job.quality, String(job.id)].filter(Boolean)
  const a = document.createElement('a')
  a.href = img.src
  a.download = `${parts.join('_')}${idx}.${ext}`
  a.click()
}

function fmtBytes(b: number) {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`
  return `${(b / 1024 / 1024).toFixed(2)} MB`
}

function fmtMs(ms: number) {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

/** Clock time the image came back. Cards from one batch land seconds apart, so
 *  the seconds field is what makes them distinguishable. */
function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
}

/** Full date on hover — a batch can outlive the day it was started in. */
function fmtFullTime(ts: number) {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
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

.collapse-btn {
  display: flex; align-items: center; gap: 6px;
  border: none; background: transparent;
  color: var(--text-primary);
  font-size: 13px; font-weight: 600;
  cursor: pointer; padding: 4px 0;
}
.chev {
  display: inline-block;
  font-size: 18px; line-height: 1;
  transition: transform 0.2s;
}
.chev.open { transform: rotate(90deg); }
.collapse-label { user-select: none; }

.head-info { display: flex; align-items: center; gap: 10px; }

/* Endpoint switch. Sits with the header controls so the shared result grid
   below reads as belonging to both modes. */
.tabs {
  display: flex; gap: 4px;
  padding: 3px;
  border-radius: 9px;
  box-shadow: inset 3px 3px 6px var(--shadow-dark), inset -3px -3px 6px var(--shadow-light);
}
.tab {
  padding: 4px 16px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text-muted);
  font-size: 12px; font-weight: 600;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.tab:hover { color: var(--text-primary); }
.tab.on {
  color: #fff;
  background: var(--accent);
}.count-badge {
  padding: 4px 12px;
  border-radius: 999px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.progress {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 12px; font-variant-numeric: tabular-nums;
}

.head-actions {
  margin-left: auto;
  display: flex; align-items: center; gap: 10px;
}

.gen-btn {
  height: 36px;
  padding: 0 20px;
  border: none;
  border-radius: 10px;
  background: var(--accent);
  color: #fff;
  font-size: 13px; font-weight: 600;
  cursor: pointer; white-space: nowrap;
  display: inline-flex; align-items: center;
}
.gen-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.gen-btn:not(:disabled):hover { background: var(--accent-hover); }

/* Same footprint as .gen-btn so the header does not shift when they swap */
.stop-btn {
  height: 36px;
  padding: 0 20px;
  border: none;
  border-radius: 10px;
  background: #c0564a;
  color: #fff;
  font-size: 13px; font-weight: 600;
  cursor: pointer; white-space: nowrap;
  display: inline-flex; align-items: center;
}
.stop-btn:hover { background: #a94a3f; }

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
}
.spacer { flex: 1; }

/* Mirrors the editor's own status line, so the answer is visible even when the
   mask editor is scrolled out of view. */
.mask-flag {
  font-size: 10.5px; font-weight: 600;
  color: var(--text-muted);
}
.mask-flag.on { color: var(--accent); }

.prompt-input :deep(.n-input__textarea-el) {
  background: transparent !important;
  font-size: 12.5px;
  line-height: 1.6;
}

/* ===== Size table ===== */
.size-table {
  border-collapse: separate;
  border-spacing: 4px;
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}
.size-table th {
  padding: 4px 8px;
  font-weight: 600;
  color: var(--text-muted);
  cursor: pointer;
  user-select: none;
  border-radius: 6px;
}
.size-table th:hover:not(.ratio-th) { color: var(--accent); }
.ratio-th { cursor: default; }

.ratio-td {
  padding: 5px 8px;
  font-weight: 600;
  color: var(--text-muted);
  cursor: pointer;
  user-select: none;
  border-radius: 6px;
  text-align: right;
}
.ratio-td:hover { color: var(--accent); }

.size-cell {
  padding: 5px 10px;
  border-radius: 7px;
  cursor: pointer;
  user-select: none;
  text-align: center;
  color: var(--text-muted);
  box-shadow: 2px 2px 4px var(--shadow-dark), -2px -2px 4px var(--shadow-light);
  transition: color 0.15s, box-shadow 0.15s;
}
.size-cell:hover { color: var(--text-primary); }
.size-cell.on {
  color: #fff;
  background: var(--accent);
  box-shadow: inset 2px 2px 4px rgba(0, 0, 0, 0.15);
}

/* ===== Chips ===== */
.chip-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 14px;
}
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
.chip {
  padding: 5px 13px;
  border: none;
  border-radius: 7px;
  background: var(--bg);
  color: var(--text-muted);
  font-size: 11.5px;
  cursor: pointer;
  box-shadow: 2px 2px 4px var(--shadow-dark), -2px -2px 4px var(--shadow-light);
  transition: color 0.15s, background 0.15s;
}
.chip:hover { color: var(--text-primary); }
.chip.on {
  color: #fff;
  background: var(--accent);
  box-shadow: inset 2px 2px 4px rgba(0, 0, 0, 0.15);
}

.num-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 14px;
}

/* ===== Results ===== */
.results-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 14px;
}

.card {
  background: var(--bg);
  border-radius: var(--radius-card);
  overflow: hidden;
  display: flex; flex-direction: column;
}

/* Square canvas: any aspect ratio letterboxes inside it, so a 3:1 image
   renders as a wide band with padding above and below. */
.canvas {
  position: relative;
  aspect-ratio: 1;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer;
  background-color: #dfe4ea;
}

.thumb {
  max-width: 100%; max-height: 100%;
  object-fit: contain;
  display: block;
}

/* ===== Carousel (only rendered when n>1 actually returned) ===== */
.nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 26px; height: 38px;
  border: none;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.38);
  color: #fff;
  font-size: 20px; line-height: 1;
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  opacity: 0;
  transition: opacity 0.15s, background 0.15s;
}
.card:hover .nav { opacity: 1; }
.nav:hover { background: rgba(0, 0, 0, 0.6); }
.nav.prev { left: 6px; }
.nav.next { right: 6px; }

.pager {
  position: absolute;
  right: 8px; bottom: 8px;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}

.canvas-state {
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  gap: 8px; padding: 12px; text-align: center;
}
.state-icon { font-size: 26px; }
.state-icon.dim { opacity: 0.45; }
.state-label { font-size: 11px; }
.canvas-state.err { color: #c0564a; }
.err-text {
  font-size: 10.5px; line-height: 1.4;
  display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical;
  overflow: hidden;
}

.meta {
  padding: 9px 12px 10px;
  display: flex; flex-direction: column; gap: 3px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.meta-row { display: flex; justify-content: space-between; gap: 8px; }
.meta-row.strong { font-size: 12px; font-weight: 600; margin-bottom: 2px; }
.meta-row.plain { font-size: 10.5px; }
/* Inline hint for what the x / y pair means, kept quieter than the numbers */
.split-label { font-size: 9.5px; margin-right: 4px; }

/* 请求 → 实际 comparison table */
.meta-head, .meta-row3 {
  display: grid;
  grid-template-columns: auto 1fr 1fr;
  gap: 6px;
  align-items: baseline;
}
.meta-head {
  font-size: 9.5px;
  font-weight: 600;
  color: var(--text-muted);
  padding-bottom: 3px;
  margin-bottom: 1px;
  border-bottom: 1px solid var(--shadow-dark);
}
.meta-row3 { font-size: 10.5px; }
.meta-row3 > :nth-child(2) { color: var(--text-muted); }
.meta-row3 > :nth-child(3) { font-weight: 600; }
/* Highlight only the actual value — the request is never the thing that is wrong */
.meta-row3.bad > :nth-child(3) { color: #c0564a; }

.meta-row3 > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.strong-num { font-weight: 600; }

.card-actions {
  display: flex; align-items: center; justify-content: space-between;
  gap: 8px; margin-top: 4px;
}
.revised {
  font-size: 10px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  max-width: 110px;
}

.empty-state {
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  min-height: 260px; gap: 12px; text-align: center;
}
.empty-icon { font-size: 48px; opacity: 0.4; }
</style>
