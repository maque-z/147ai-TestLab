<template>
  <div class="panel">
    <!-- ===== Config card (collapsible) ===== -->
    <div class="config-card nm-raised">
      <!-- Whole strip toggles the body, so the small chevron is no longer the
           only target. Clicks landing on a real control inside are ignored: see
           onHeadClick. -->
      <div
        class="config-head"
        :class="{ 'head-clickable': isBatch }"
        :title="isBatch ? (store.paramsCollapsed ? '点击展开参数' : '点击收起参数') : ''"
        @click="onHeadClick"
      >
        <div class="collapse-btn">
          <span class="chev" :class="{ open: isBatch && !store.paramsCollapsed }">›</span>
          <span class="collapse-label">参数</span>
        </div>

        <!-- Two endpoints, one param matrix and one result grid below.
             测试 is a third pane, not a third endpoint: it runs a fixed suite
             from its own store rather than expanding the matrix below. -->
        <div class="tabs">
          <button class="tab" :class="{ on: isBatch && store.mode === 'generate' }" @click="switchMode('generate', $event)">
            生成
          </button>
          <button class="tab" :class="{ on: isBatch && store.mode === 'edit' }" @click="switchMode('edit', $event)">
            编辑
          </button>
          <button class="tab" :class="{ on: store.view === 'test' }" @click="switchView('test', $event)">
            测试
          </button>
        </div>

        <div class="head-info">
          <span v-if="isBatch" class="count-badge nm-inset">
            {{ shownRequests }} 请求 / {{ shownImages }} 图
          </span>
          <span v-else class="count-badge nm-inset">
            {{ TEST_CASE_COUNT }} 探测 / 并发 {{ CONCURRENCY }}
          </span>
        </div>

        <div v-if="isBatch" class="head-actions">
          <!-- Stopping is per-card; this is the bulk escape hatch, since a wide
               matrix would otherwise take one click per card to abandon. -->
          <button
            v-if="store.generating"
            class="btn btn-sm btn-danger"
            title="停止整批，已完成的卡片保留"
            @click="store.stop()"
          >
            <span class="btn-icon">■</span> 全部停止
          </button>

          <!-- Hidden mid-batch: clearing the array detaches the cards the running
               pool is still writing to, so its progress would vanish silently. -->
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

      <div v-show="isBatch && !store.paramsCollapsed" ref="bodyEl" class="config-body">
        <!-- Edit-only inputs: the first upload is the canvas, the rest are
             references, and the mask applies to the first one only. -->
        <template v-if="store.mode === 'edit'">
          <RefImages v-model="store.refImages" />

          <div class="field">
            <div class="field-label">
              蒙版
              <span class="text-muted" style="font-weight:400">
                可选 · 涂抹处会被重绘 · 只作用于主图
              </span>
              <span class="spacer" />
              <span class="mask-flag" :class="{ on: !!store.mask }">
                {{ store.mask ? '本次将上传蒙版' : '本次不上传蒙版' }}
              </span>
            </div>
            <MaskEditor :image="store.refImages[0] ?? null" @change="store.mask = $event" />
          </div>
        </template>

        <!-- Prompt -->
        <div class="field">
          <div class="field-label">
            提示词
            <span class="text-muted" style="font-weight:400">{{ store.prompt.length }} 字</span>
          </div>
          <n-input
            v-model:value="store.prompt"
            type="textarea"
            :placeholder="store.mode === 'edit' ? '描述要如何修改这些图片...' : '描述你想生成的图片...'"
            :rows="3"
            class="prompt-input"
          />
        </div>

        <!-- Size matrix -->
        <div class="field">
          <div class="field-label">
            图片尺寸
            <span class="text-muted" style="font-weight:400">
              {{ store.matrix.sizes.length ? `已选 ${store.matrix.sizes.length} / ${ALL_SIZES.length}` : `默认 ${DEFAULTS.size}` }}
            </span>
            <span class="spacer" />
            <button class="btn btn-xs" @click="selectAllSizes">全选</button>
            <button
              class="btn btn-xs"
              :disabled="!store.matrix.sizes.length"
              @click="store.matrix.sizes = []"
            >清空</button>
          </div>
          <!-- Scrollable wrapper so the table does not overflow on narrow screens -->
          <div class="size-table-scroll">
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
                  :class="{ on: store.matrix.sizes.includes(size) }"
                  @click="toggleSize(size)"
                >
                  {{ size.replace('x', '×') }}
                </td>
              </tr>
            </tbody>
          </table>
          </div><!-- /.size-table-scroll -->
        </div>

        <!-- Chip groups. Nothing selected == send nothing and let the API pick
             its own default, so there is no explicit "auto" option to click. -->
        <div class="chip-grid">
          <div class="field">
            <div class="field-label">
              质量
              <span class="text-muted" style="font-weight:400">{{ multLabel(store.matrix.qualities, DEFAULTS.quality) }}</span>
            </div>
            <div class="chips">
              <button
                v-for="o in QUALITIES" :key="o"
                class="chip" :class="{ on: store.matrix.qualities.includes(o) }"
                @click="toggle(store.matrix.qualities, o)"
              >{{ o }}</button>
            </div>
          </div>

          <div class="field">
            <div class="field-label">
              输出格式
              <span class="text-muted" style="font-weight:400">{{ multLabel(store.matrix.formats, DEFAULTS.format) }}</span>
            </div>
            <div class="chips">
              <button
                v-for="o in FORMATS" :key="o"
                class="chip" :class="{ on: store.matrix.formats.includes(o) }"
                @click="toggle(store.matrix.formats, o)"
              >{{ o }}</button>
            </div>
          </div>

          <div class="field">
            <div class="field-label">
              内容审核
              <span class="text-muted" style="font-weight:400">{{ multLabel(store.matrix.moderations, DEFAULTS.moderation) }}</span>
            </div>
            <div class="chips">
              <button
                v-for="o in MODERATIONS" :key="o"
                class="chip" :class="{ on: store.matrix.moderations.includes(o) }"
                @click="toggle(store.matrix.moderations, o)"
              >{{ o }}</button>
            </div>
          </div>
        </div>

        <!-- Numeric params -->
        <div class="num-grid">
          <div class="field">
            <div class="field-label">每请求张数 (n)</div>
            <n-input-number v-model:value="store.matrix.n" :min="1" :max="10" size="small" style="width:100%" />
          </div>
          <div class="field">
            <div class="field-label">压缩质量 <span class="text-muted" style="font-weight:400">jpeg/webp</span></div>
            <n-input-number
              v-model:value="store.matrix.output_compression"
              :min="1" :max="100" size="small" style="width:100%"
              :placeholder="`默认 ${DEFAULTS.compression}`"
              clearable
              :disabled="!hasLossyFormat"
            />
          </div>
          <div class="field">
            <div class="field-label">最大并发数</div>
            <n-input-number v-model:value="store.matrix.concurrency" :min="1" :max="50" size="small" style="width:100%" />
          </div>
        </div>
      </div>
    </div>

    <!-- ===== Test panel ===== -->
    <ApiTestPanel v-if="store.view === 'test'" class="test-panel-wrapper" />

    <!-- ===== Results (batch mode only) ===== -->
    <div v-else-if="visibleJobs.length" ref="gridEl" class="results-grid">
      <div v-for="job in visibleJobs" :key="job.id" class="card nm-raised" :data-job="job.id">
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

          <!-- One slot, two jobs: stop while this combination is in flight, then
               download once it lands. Per-card so stopping one combination can
               never be mistaken for stopping the batch. -->
          <div class="card-actions">
            <button
              v-if="job.status === 'pending' || job.status === 'running'"
              class="btn btn-sm btn-danger card-btn"
              :title="job.status === 'running' ? '中断这一张，其余继续' : '这一张还没发出，取消它'"
              @click.stop="store.stopJob(job.id)"
            >
              <span class="btn-icon">■</span>
              {{ job.status === 'running' ? '停止' : '取消排队' }}
            </button>

            <button
              v-else-if="activeImg(job)?.src"
              class="btn btn-sm btn-primary card-btn"
              title="保存这张图片"
              @click.stop="download(job)"
            >
              <span class="btn-icon">⤓</span>
              下载{{ job.images.length > 1 ? ` 第 ${job.activeIndex + 1} 张` : '' }}
            </button>

            <span
              v-if="activeImg(job)?.revisedPrompt"
              class="text-muted revised"
              :title="activeImg(job)!.revisedPrompt"
            >提示词被改写</span>
          </div>
        </div>
      </div>
    </div>

    <div v-else-if="isBatch" class="empty-state text-muted">
      <div class="empty-icon">🖼️</div>
      <p>选择尺寸与参数，点右上角「生成」开始并发测试</p>
    </div>

    <!-- Preview: walks every image in the grid, not just the current card -->
    <ImagePreview v-model:show="previewVisible" :items="previewItems" :start="previewStart" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { NInput, NInputNumber, NSpin } from 'naive-ui'
import { useImageGenStore } from '@/stores/imageGen'
import { TEST_CASE_COUNT, CONCURRENCY } from '@/stores/apiTest'
import { enterCards, fadeInUp, pulse, countTo } from '@/utils/motion'
import RefImages from './RefImages.vue'
import MaskEditor from './MaskEditor.vue'
import ApiTestPanel from './ApiTestPanel.vue'
import ImagePreview, { type PreviewItem } from './ImagePreview.vue'
import type { GenMode, ImageJob, JobImage } from '@/types'

/** Prompt, matrix, mode and the uploads all live in the store: the run button
 *  sits in the top bar, in a different component tree, and needs the same state. */
const store = useImageGenStore()

/** Jobs for whichever endpoint tab is active. The two pools are separate so
 *  switching tabs never loses the other side's results. */
const visibleJobs = computed(() =>
  store.mode === 'edit' ? store.editJobs : store.generateJobs
)

const previewVisible = ref(false)
const previewStart = ref(0)
const gridEl = ref<HTMLElement | null>(null)
const bodyEl = ref<HTMLElement | null>(null)

/** True when either batch endpoint is showing, i.e. not the test suite. Every
 *  matrix control and the results grid are scoped to this. */
const isBatch = computed(() => store.view === 'batch')

/** Switching endpoints swaps the whole param body, so the new content is
 *  revealed rather than replaced instantly. Also leaves the test pane, since the
 *  two endpoint tabs and the test tab share one row. */
function switchMode(next: GenMode, e: MouseEvent) {
  if (store.mode === next && isBatch.value) return
  store.mode = next
  store.view = 'batch'
  pulse(e.currentTarget as HTMLElement)
  nextTick(() => {
    if (bodyEl.value) fadeInUp(bodyEl.value, { distance: 6 })
  })
}

/** Show the fixed compatibility suite. Its requests and results live in their
 *  own store, so nothing here is disturbed by switching away and back. */
function switchView(next: 'batch' | 'test', e: MouseEvent) {
  if (store.view === next) return
  store.view = next
  pulse(e.currentTarget as HTMLElement)
}

/** Collapse/expand from anywhere on the header strip.
 *
 *  The tabs and the stop/clear buttons live in the same strip, so a bare click
 *  handler here would fire on those too — switching endpoint would also collapse
 *  the body the user just asked to see. Anything interactive is excluded.
 *
 *  Only meaningful in batch mode: the test pane has no collapsible body.
 */
function onHeadClick(e: MouseEvent) {
  if (!isBatch.value) return
  const el = e.target as HTMLElement
  if (el.closest('button, a, input, .tabs')) return
  store.paramsCollapsed = !store.paramsCollapsed
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

const hasLossyFormat = computed(() =>
  store.matrix.formats.includes('jpeg') || store.matrix.formats.includes('webp')
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
  toggle(store.matrix.sizes, size)
}

function selectAllSizes() {
  store.matrix.sizes = [...ALL_SIZES]
}

/** Row/column headers act as bulk toggles: fill if any are missing, else clear. */
function toggleRow(row: { sizes: string[] }) {
  const missing = row.sizes.filter(s => !store.matrix.sizes.includes(s))
  if (missing.length) store.matrix.sizes.push(...missing)
  else store.matrix.sizes = store.matrix.sizes.filter(s => !row.sizes.includes(s))
}

function toggleCol(tierIndex: number) {
  const col = SIZE_TABLE.map(r => r.sizes[tierIndex])
  const missing = col.filter(s => !store.matrix.sizes.includes(s))
  if (missing.length) store.matrix.sizes.push(...missing)
  else store.matrix.sizes = store.matrix.sizes.filter(s => !col.includes(s))
}

/** Counters tween to their new value, so a matrix change reads as the batch
 *  growing rather than a number silently swapping. */
const shownRequests = ref(store.totalRequests)
const shownImages = ref(store.totalImages)

watch(() => store.totalRequests, (to, from) => countTo(from, to, v => (shownRequests.value = v)))
watch(() => store.totalImages, (to, from) => countTo(from, to, v => (shownImages.value = v)))

/** Animate only cards that have not been seen before.
 *
 *  Keyed on job id rather than index, because new jobs are unshifted onto the
 *  front of the list — animating "the first N elements" would re-animate every
 *  older card each time a batch is queued.
 */
const animatedJobs = new Set<number>()

watch(() => visibleJobs.value.map(j => j.id).join(','), async () => {
  await nextTick()
  const grid = gridEl.value
  if (!grid) {
    // Grid is unmounted when the list empties; let ids animate again if reused.
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
})

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
  visibleJobs.value.flatMap(job =>
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
  for (const j of visibleJobs.value) {
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

/* When in batch mode the whole strip acts as a toggle target. The cursor
   changes to signal this, but buttons inside retain their own pointer. */
.config-head.head-clickable {
  cursor: pointer;
}
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
  color: var(--text-primary);
  font-size: 12px; font-weight: 600;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.tab:hover { color: var(--accent-strong); }
.tab.on {
  color: #fff;
  background: var(--accent-strong);
}

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
}
.spacer { flex: 1; }

/* Mirrors the editor's own status line, so the answer is visible even when the
   mask editor is scrolled out of view. */
.mask-flag {
  font-size: 10.5px; font-weight: 600;
  color: var(--text-muted);
}
.mask-flag.on { color: var(--accent-strong); }

.prompt-input :deep(.n-input__textarea-el) {
  background: transparent !important;
  font-size: 12.5px;
  line-height: 1.6;
}

/* ===== Size table ===== */
.size-table-scroll {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}
.size-table {
  border-collapse: separate;
  border-spacing: 4px;
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}
.size-table th {
  padding: 4px 8px;
  font-weight: 600;
  color: var(--text-primary);
  cursor: pointer;
  user-select: none;
  border-radius: 6px;
}
.size-table th:hover:not(.ratio-th) { color: var(--accent-strong); }
.ratio-th { cursor: default; color: var(--text-muted); }

.ratio-td {
  padding: 5px 8px;
  font-weight: 600;
  color: var(--text-primary);
  cursor: pointer;
  user-select: none;
  border-radius: 6px;
  text-align: right;
}
.ratio-td:hover { color: var(--accent-strong); }

.size-cell {
  padding: 5px 10px;
  border-radius: 7px;
  cursor: pointer;
  user-select: none;
  text-align: center;
  color: var(--text-primary);
  box-shadow: 2px 2px 4px var(--shadow-dark), -2px -2px 4px var(--shadow-light);
  transition: color 0.15s, box-shadow 0.15s;
}
.size-cell:hover { color: var(--accent-strong); }
.size-cell.on {
  color: #fff;
  background: var(--accent-strong);
  box-shadow: inset 2px 2px 4px rgba(0, 0, 0, 0.18);
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

/* Fixed square canvas. Everything inside is absolutely positioned so no image
   or state block can contribute intrinsic height — a tall portrait would
   otherwise out-vote aspect-ratio via min-content sizing and stretch the box,
   which is what made cards render at mismatched heights. */
.canvas {
  position: relative;
  aspect-ratio: 1 / 1;
  width: 100%;
  min-height: 0;
  overflow: hidden;
  cursor: pointer;
  background-color: var(--surface-sunken, #dfe4ea);
}

.thumb {
  position: absolute;
  inset: 0;
  width: 100%; height: 100%;
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
/* Keyboard users never trigger :hover, so the arrows have to surface on focus */
.nav:focus-visible { opacity: 1; outline: 2px solid #fff; outline-offset: -2px; }
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
  position: absolute;
  inset: 0;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  gap: 8px; padding: 12px; text-align: center;
}
.state-icon { font-size: 26px; }
.state-icon.dim { opacity: 0.45; }
.state-label { font-size: 11px; }
.canvas-state.err { color: var(--danger); }
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
.meta-row3.bad > :nth-child(3) { color: var(--danger); }

.meta-row3 > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.strong-num { font-weight: 600; }

.card-actions {
  display: flex; align-items: center;
  gap: 8px; margin-top: 7px;
}
/* Fills the row so the card's one action is an unmissable target */
.card-btn { flex: 1; min-width: 0; }
.revised {
  font-size: 10px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  max-width: 92px;
}

.empty-state {
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  min-height: 260px; gap: 12px; text-align: center;
}
.empty-icon { font-size: 48px; opacity: 0.4; }

/* The test panel stretches to fill whatever the outer column gives it.
   min-height keeps the terminal readable even when there are no results yet. */
.test-panel-wrapper { min-height: 600px; }

/* ===== Responsive ===== */
@media (max-width: 640px) {
  .config-card { padding: 10px 12px; }
  /* Tighter card grid on phones — one column is fine */
  .results-grid { grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); }
  /* Allow test panel to be auto-height on mobile rather than a fixed min */
  .test-panel-wrapper { min-height: 0; }
  /* meta-row3 col widths: give the label a bit less room */
  .meta-head,
  .meta-row3 { grid-template-columns: auto 1fr auto; gap: 4px; }
}
</style>
