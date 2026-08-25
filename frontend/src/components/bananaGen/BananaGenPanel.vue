<template>
  <div class="panel">
    <!-- ===== Config card (collapsible) ===== -->
    <div class="config-card nm-raised">
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

        <!-- Match the GPT Image workflow: task first, protocol second. -->
        <div class="tabs">
          <button class="tab" :class="{ on: isBatch && store.operation === 'generate' }" @click="switchOperation('generate', $event)">
            生成
          </button>
          <button class="tab" :class="{ on: isBatch && store.operation === 'edit' }" @click="switchOperation('edit', $event)">
            编辑
          </button>
          <button class="tab" :class="{ on: store.view === 'test' }" @click="switchView('test', $event)">测试</button>
        </div>

        <div class="head-info">
          <span v-if="isBatch" class="count-badge nm-inset">
            {{ shownRequests }} 请求 / {{ shownImages }} 图
          </span>
          <span v-else class="count-badge nm-inset">{{ BANANA_TEST_CASE_COUNT }} 探测 / 并发 {{ BANANA_TEST_CONCURRENCY }}</span>
        </div>

        <div v-if="isBatch" class="head-actions">
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

      <div v-show="isBatch && !store.paramsCollapsed" ref="bodyEl" class="config-body">
        <div class="surface-row">
          <span class="surface-label">接口协议</span>
          <div class="surface-tabs">
            <button class="surface-tab" :class="{ on: store.mode === 'native' }" @click="switchMode('native', $event)">原生 Gemini</button>
            <button class="surface-tab" :class="{ on: store.mode === 'openai' }" :disabled="store.operation === 'edit'" @click="switchMode('openai', $event)">OpenAI 兼容</button>
          </div>
          <span class="text-muted operation-help">
            {{ store.operation === 'edit' ? '编辑按文档把参考图作为 inlineData 放入 contents.parts' : '原生接口可检测比例、分辨率与完整生成参数' }}
          </span>
        </div>
        <template v-if="store.mode === 'native' && store.operation === 'edit'">
          <RefImages v-model="store.referenceImages" />
          <div class="field">
            <div class="field-label">
              蒙版探测
              <span class="text-muted" style="font-weight:400">约定式 · 文档没有独立 mask 字段</span>
              <span class="spacer" />
              <span class="mask-flag" :class="{ on: !!store.mask }">
                {{ store.mask ? '将作为最后一张 inlineData 发送' : '本次不发送蒙版' }}
              </span>
            </div>
            <MaskEditor :image="store.referenceImages[0] ?? null" @change="store.mask = $event" />
          </div>
        </template>

        <!-- Prompt -->
        <div class="field">
          <div class="field-label">
            提示词
            <span class="text-muted" style="font-weight:400">{{ store.prompt.length }} 字</span>
            <span class="spacer" />
            <button class="btn btn-xs prompt-expand" title="在大编辑框中编辑提示词" @click="promptEditorOpen = true">⤢ 展开编辑</button>
          </div>
          <n-input
            v-model:value="store.prompt"
            type="textarea"
            :placeholder="store.operation === 'edit' ? '描述要如何修改这些图片...' : '描述你想生成的图片...'"
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
          <div class="field">
            <div class="field-label">
              图片尺寸
              <span class="text-muted" style="font-weight:400">
                imageConfig · {{ store.matrix.sizePairs.length ? `已选 ${store.matrix.sizePairs.length} 项` : '默认 auto（1:1 · 1K）' }}
              </span>
              <span class="spacer" />
              <button class="btn btn-xs" @click="selectAllSizes">全选</button>
              <button
                class="btn btn-xs"
                :disabled="!store.matrix.sizePairs.length"
                @click="store.matrix.sizePairs = []"
              >清空</button>
            </div>
            <div class="size-table-scroll">
              <table class="size-table">
                <thead>
                  <tr>
                    <th class="tier-head">尺寸</th>
                    <th v-for="ratio in ALL_RATIOS" :key="ratio" :class="{ warn: ratioUnsupported(ratio) }">{{ ratio }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="tier in SIZE_TIERS" :key="tier">
                    <td class="tier-cell">~{{ tier }}</td>
                    <td
                      v-for="ratio in ALL_RATIOS"
                      :key="`${tier}-${ratio}`"
                      class="size-cell"
                      :class="{ on: store.matrix.sizePairs.includes(sizeKey(tier, ratio)), unavailable: !sizeCellAvailable(tier, ratio) }"
                      :title="sizeCellTitle(tier, ratio)"
                      @click="sizeCellAvailable(tier, ratio) && toggle(store.matrix.sizePairs, sizeKey(tier, ratio))"
                    >{{ sizePixels(tier, ratio) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p class="size-note text-muted">按钮文字是文档公布的实际像素；“—”表示文档未公布该组合，红色列表示部分所选模型不支持。</p>
          </div>

          <!-- responseModalities -->
          <div class="field">
            <div class="field-label">
              返回内容
              <span class="text-muted" style="font-weight:400">
                responseModalities · 必须含 IMAGE 才会返回图片
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

          <!-- Official safetySettings is category-specific. -->
          <div class="field">
            <div class="field-label">
              安全过滤
              <span class="text-muted" style="font-weight:400">
                safetySettings · 每个类别可单独设置；留空使用上游默认策略
              </span>
            </div>
            <div class="safety-grid">
              <div v-for="category in SAFETY_CATEGORIES" :key="category.value" class="safety-row">
                <span class="safety-category">{{ category.label }}</span>
                <select v-model="store.matrix.safetySettings[category.value]" class="native-select">
                  <option :value="null">跟随默认</option>
                  <option v-for="threshold in SAFETY_THRESHOLDS" :key="threshold" :value="threshold">{{ threshold }}</option>
                </select>
              </div>
            </div>
            <p class="size-note text-muted">官方允许不同类别使用不同阈值；实际可用性以模型和网关响应为准。</p>
          </div>
        </template>

        <!-- Numeric params -->
        <div class="num-grid">
          <div class="field">
            <div class="field-label">随机程度 <span class="text-muted" style="font-weight:400">temperature · 默认 1.0</span></div>
            <n-input-number
              v-model:value="store.matrix.temperature"
              :min="0" :max="2" :step="0.1" size="small" style="width:100%"
              placeholder="默认 1.0" clearable
            />
          </div>
          <div v-if="store.mode === 'native'" class="field">
            <div class="field-label">候选图片数 <span class="text-muted" style="font-weight:400">candidateCount · 默认 1</span></div>
            <n-input-number
              v-model:value="store.matrix.candidateCount"
              :min="1" :max="8" size="small" style="width:100%"
              placeholder="默认 1" clearable
            />
          </div>
          <div v-if="store.mode === 'native'" class="field">
            <div class="field-label">最大输出 Token <span class="text-muted" style="font-weight:400">maxOutputTokens · 不填使用模型默认值</span></div>
            <n-input-number
              v-model:value="store.matrix.maxOutputTokens"
              :min="1" :max="1000000" size="small" style="width:100%"
              placeholder="使用模型默认值" clearable
            />
          </div>
          <div class="field">
            <div class="field-label">最大并发数 <span class="text-muted" style="font-weight:400">每个参数组合独立请求</span></div>
            <n-input-number v-model:value="store.matrix.concurrency" :min="1" :max="50" size="small" style="width:100%" />
          </div>
        </div>

        <div v-if="store.mode === 'native'" class="num-grid">
          <div class="field">
            <div class="field-label">核采样 <span class="text-muted" style="font-weight:400">topP · 0 到 1 · 文档可选</span></div>
            <n-input-number v-model:value="store.matrix.topP" :min="0" :max="1" :step="0.05" size="small" style="width:100%" clearable placeholder="不发送" />
          </div>
          <div class="field">
            <div class="field-label">候选池 <span class="text-muted" style="font-weight:400">topK · 部分模型支持</span></div>
            <n-input-number v-model:value="store.matrix.topK" :min="1" :max="1000" size="small" style="width:100%" clearable placeholder="不发送" />
          </div>
          <div class="field">
            <div class="field-label">随机种子 <span class="text-muted" style="font-weight:400">seed · 图片模型不保证生效</span></div>
            <n-input-number v-model:value="store.matrix.seed" :min="0" :max="2147483647" size="small" clearable style="width:100%" placeholder="不发送" />
          </div>
        </div>

        <div v-if="store.mode === 'native'" class="field">
          <div class="field-label">思考等级 <span class="text-muted" style="font-weight:400">thinkingConfig.thinkingLevel · Gemini 3 推荐</span></div>
          <p v-if="!thinkingSupported" class="size-note text-muted">当前选择的模型未启用 Gemini 3 思考模式；为避免上游拒绝请求，思考参数不会发送。</p>
          <div class="chips">
            <button v-for="level in THINKING_LEVELS" :key="level.value" class="chip" :disabled="!thinkingSupported" :class="{ on: store.matrix.thinkingLevel === level.value }" :title="level.note" @click="store.matrix.thinkingLevel = store.matrix.thinkingLevel === level.value ? null : level.value">{{ level.label }}</button>
          </div>
          <div class="thinking-options">
            <label class="check-option"><input v-model="store.matrix.includeThoughts" :disabled="!thinkingSupported || !store.matrix.thinkingLevel" type="checkbox" /> 返回思考过程 <span class="text-muted">includeThoughts（需先启用思考）</span></label>
            <n-input-number v-model:value="store.matrix.thinkingBudget" :disabled="!thinkingSupported" :min="-1" :max="1000000" size="small" clearable placeholder="thinkingBudget（可选）" style="width:220px" />
          </div>
        </div>

        <div v-if="store.mode === 'native'" class="field">
          <div class="field-label">
            停止序列
            <span class="text-muted" style="font-weight:400">stopSequences · 多个值用英文逗号分隔，不填则不发送</span>
          </div>
          <n-input
            v-model:value="stopSequencesText"
            size="small"
            placeholder="例如 END, STOP"
          />
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

    <BananaTestPanel v-if="store.view === 'test'" />

    <!-- ===== Results ===== -->
    <div v-if="isBatch && visibleJobs.length" ref="gridEl" class="results-grid">
      <BananaCard
        v-for="job in visibleJobs"
        :key="job.id"
        :job="job"
        @preview="openPreview"
        @stop="store.stopJob"
      />
    </div>

    <div v-else-if="isBatch" class="empty-state text-muted">
      <div class="empty-icon">🍌</div>
      <p>选择模型与参数，点右上角「生成」开始并发测试</p>
    </div>

    <n-modal
      v-model:show="promptEditorOpen"
      preset="card"
      :title="store.operation === 'edit' ? 'Gemini 编辑提示词' : 'Gemini 生成提示词'"
      style="width: min(760px, 94vw)"
      :header-extra="() => `${store.prompt.length} 字`"
      :bordered="false"
      :segmented="{ content: true }"
    >
      <n-input v-model:value="store.prompt" type="textarea" :rows="18" class="prompt-editor" />
      <template #footer><button class="btn btn-primary" @click="promptEditorOpen = false">完成</button></template>
    </n-modal>

    <ImagePreview v-model:show="previewVisible" :items="previewItems" :start="previewStart" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { NInput, NInputNumber, NModal } from 'naive-ui'
import { useBananaGenStore } from '@/stores/bananaGen'
import { enterCards, fadeInUp, pulse, countTo } from '@/utils/motion'
import {
  ALL_RATIOS, DOC_PIXELS, MODALITY_SETS, SAFETY_CATEGORIES, SAFETY_THRESHOLDS, THINKING_LEVELS,
  ratioSupported, sizeSupported, supportsThinking,
} from '@/utils/bananaSpec'
import BananaCard from './BananaCard.vue'
import RefImages from '@/components/imageGen/RefImages.vue'
import MaskEditor from '@/components/imageGen/MaskEditor.vue'
import BananaTestPanel from './BananaTestPanel.vue'
import ImagePreview, { type PreviewItem } from '@/components/imageGen/ImagePreview.vue'
import { BANANA_TEST_CASE_COUNT, BANANA_TEST_CONCURRENCY } from '@/stores/bananaTest'
import type { BananaJob, BananaMode } from '@/types'

/** Prompt, matrix and mode all live in the store: the run button sits in the top
 *  bar, in a different component tree, and needs the same state. */
const store = useBananaGenStore()
const promptEditorOpen = ref(false)
const SIZE_TIERS = ['512', '1K', '2K', '4K'] as const
const isBatch = computed(() => store.view === 'batch')

const stopSequencesText = computed({
  get: () => store.matrix.stopSequences.join(', '),
  set: (value: string) => {
    const unique = new Set<string>()
    store.matrix.stopSequences = value.split(',')
      .map(item => item.trim())
      .filter(item => item && !unique.has(item) && !!unique.add(item))
      .slice(0, 5)
  },
})

/** Jobs for whichever surface is active. The two pools are separate so switching
 *  tabs never loses the other side's results. */
const visibleJobs = computed(() =>
  (store.mode === 'openai' ? store.openaiJobs : store.nativeJobs)
    .filter(job => job.operation === store.operation)
)

const previewVisible = ref(false)
const previewStart = ref(0)
const gridEl = ref<HTMLElement | null>(null)
const bodyEl = ref<HTMLElement | null>(null)

/** Switching surfaces swaps the whole param body, so the new content is revealed
 *  rather than replaced instantly. The model list differs between the two, so the
 *  selection is reset to that surface's default. */
function switchMode(next: BananaMode, e: MouseEvent) {
  if (store.mode === next && isBatch.value) return
  if (store.operation === 'edit' && next === 'openai') return
  store.mode = next
  store.view = 'batch'
  store.matrix.models = [store.availableModels[0].id]
  pulse(e.currentTarget as HTMLElement)
  nextTick(() => {
    if (bodyEl.value) fadeInUp(bodyEl.value, { distance: 6 })
  })
}

function switchOperation(next: 'generate' | 'edit', e: MouseEvent) {
  if (store.operation === next && isBatch.value) return
  store.operation = next
  store.view = 'batch'
  if (next === 'edit' && store.mode !== 'native') {
    store.mode = 'native'
    store.matrix.models = [store.availableModels[0].id]
  }
  pulse(e.currentTarget as HTMLElement)
  nextTick(() => {
    if (bodyEl.value) fadeInUp(bodyEl.value, { distance: 6 })
  })
}

function switchView(next: 'batch' | 'test', e: MouseEvent) {
  if (store.view === next) return
  store.view = next
  pulse(e.currentTarget as HTMLElement)
}

/** Collapse/expand from anywhere on the header strip. The tabs and the
 *  stop/clear buttons live in the same strip, so anything interactive is
 *  excluded — switching surface must not also collapse the body. */
function onHeadClick(e: MouseEvent) {
  if (!isBatch.value) return
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

const thinkingSupported = computed(() => store.matrix.models.some(model => supportsThinking(model)))

watch(thinkingSupported, supported => {
  if (!supported) {
    store.matrix.thinkingLevel = null
    store.matrix.includeThoughts = false
    store.matrix.thinkingBudget = null
  }
})

/** Whether any currently selected model lacks documented support. Flagged rather
 *  than disabled: sending an unsupported combination on purpose is how the
 *  documented fallback gets verified. */
function ratioUnsupported(ratio: string) {
  return store.matrix.models.some(m => !ratioSupported(m, ratio))
}

function sizeKey(tier: string, ratio: string) {
  return `${tier}|${ratio}`
}

function sizePixels(tier: string, ratio: string) {
  return DOC_PIXELS[tier]?.[ratio]?.replace('x', '×') ?? '—'
}

function sizeCellAvailable(tier: string, ratio: string) {
  return !!DOC_PIXELS[tier]?.[ratio]
}

function sizeCellTitle(tier: string, ratio: string) {
  if (!sizeCellAvailable(tier, ratio)) return '文档未公布该清晰度与比例的像素尺寸'
  const bad = store.matrix.models.filter(model =>
    !sizeSupported(model, tier) || !ratioSupported(model, ratio),
  )
  return bad.length
    ? `文档称以下所选模型不支持此组合，可能回退：\n${bad.join('\n')}`
    : `${ratio} · ${tier} · ${sizePixels(tier, ratio)}`
}

function selectAllSizes() {
  store.matrix.sizePairs = SIZE_TIERS.flatMap(tier =>
    ALL_RATIOS
      .filter(ratio => sizeCellAvailable(tier, ratio))
      .map(ratio => sizeKey(tier, ratio)),
  )
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

.surface-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.surface-label { font-size: 12px; font-weight: 600; }
.surface-tabs {
  display: flex;
  gap: 4px;
  padding: 3px;
  border-radius: 8px;
  box-shadow: inset 2px 2px 4px var(--shadow-dark), inset -2px -2px 4px var(--shadow-light);
}
.surface-tab {
  border: 0;
  border-radius: 6px;
  padding: 4px 11px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}
.surface-tab:hover { color: var(--accent-strong); }
.surface-tab.on { color: #fff; background: var(--accent-strong); }
.surface-tab:disabled { cursor: not-allowed; opacity: 0.45; }
.operation-help { margin-left: 4px; font-size: 10.5px; }

.safety-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 8px;
}
.safety-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 6px 8px;
  border-radius: 7px;
  background: var(--bg);
  box-shadow: inset 1px 1px 3px var(--shadow-dark), inset -1px -1px 3px var(--shadow-light);
}
.safety-category {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--text-primary);
}
.native-select {
  min-width: 0;
  max-width: 100%;
  padding: 5px 7px;
  border: 0;
  border-radius: 6px;
  color: var(--text-primary);
  background: var(--bg);
  box-shadow: inset 1px 1px 3px var(--shadow-dark), inset -1px -1px 3px var(--shadow-light);
  font-size: 10px;
}
.thinking-options { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
.check-option { font-size:11px; color:var(--text-primary); display:flex; align-items:center; gap:6px; }
.check-option input { accent-color:var(--accent-strong); }

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
.prompt-editor :deep(.n-input__textarea-el) { font-size: 14px; line-height: 1.7; }
.prompt-expand { flex-shrink: 0; }
.mask-flag { font-size: 10.5px; font-weight: 600; color: var(--text-muted); }
.mask-flag.on { color: var(--accent-strong); }

/* Screenshot-style Gemini size matrix: ratios run across, documented tiers run
   down, and every clickable cell maps to exactly one upstream request. */
.size-table-scroll { overflow-x: auto; padding-bottom: 5px; -webkit-overflow-scrolling: touch; }
.size-table { min-width: 100%; border-collapse: separate; border-spacing: 5px; font-size: 10.5px; font-variant-numeric: tabular-nums; }
.size-table th { padding: 4px 8px; white-space: nowrap; font-weight: 600; }
.size-table th.warn { color: var(--danger); }
.tier-head, .tier-cell { position: sticky; left: 0; z-index: 1; background: var(--bg); text-align: left; white-space: nowrap; }
.tier-cell { padding: 5px 7px; color: var(--text-muted); font-weight: 600; }
.size-cell {
  min-width: 88px;
  padding: 7px 10px;
  border-radius: 7px;
  text-align: center;
  white-space: nowrap;
  cursor: pointer;
  color: var(--text-primary);
  background: var(--bg);
  box-shadow: 2px 2px 5px var(--shadow-dark), -2px -2px 5px var(--shadow-light);
  transition: color .15s, background .15s, transform .15s;
}
.size-cell:hover { color: var(--accent-strong); transform: translateY(-1px); }
.size-cell.on { color: #fff; background: var(--accent-strong); box-shadow: inset 2px 2px 4px rgba(0,0,0,.18); }
.size-cell.unavailable { cursor: not-allowed; opacity: .35; box-shadow: inset 1px 1px 3px var(--shadow-dark); }
.size-cell.unavailable:hover { color: var(--text-primary); transform: none; }
.size-note { margin: 0; font-size: 10px; line-height: 1.5; }

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
.chip:disabled { cursor: not-allowed; opacity: .45; box-shadow: inset 1px 1px 3px var(--shadow-dark); }

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
