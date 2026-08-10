<template>
  <div class="test-panel">

    <!-- ── Header ── -->
    <div class="test-header nm-raised">
      <div class="header-left">
        <span class="test-title">API 参数兼容性测试</span>
        <span class="test-meta">
          {{ TEST_CASE_COUNT }} 个探测 · 并发 {{ CONCURRENCY }} · spring.jpg 参考图
        </span>
      </div>
      <div class="header-right">
        <span v-if="store.running" class="progress-label">
          {{ store.doneCount }} / {{ store.totalCount }}
        </span>
        <button
          v-if="!store.running"
          class="btn btn-primary"
          :disabled="!!blockReason"
          :title="blockReason || `并发发射全部探测，约消耗 ${TEST_CASE_COUNT} 次生图额度`"
          @click="store.run()"
        >
          ▶ 开始测试
        </button>
        <button
          v-else
          class="btn btn-danger"
          @click="store.stop()"
        >
          ■ 停止
        </button>
        <button
          v-if="store.results.length && !store.running"
          class="btn btn-sm"
          title="清空本次结果和日志"
          @click="store.clear()"
        >
          🗑 清除
        </button>
      </div>
    </div>

    <!-- ── Body: terminal + cards ── -->
    <div class="test-body">

      <!-- Terminal log -->
      <div class="terminal" ref="terminalEl">
        <div v-if="!store.logs.length" class="term-placeholder text-muted">
          点击「开始测试」，日志将在此实时滚动…
        </div>
        <div
          v-for="entry in store.logs"
          :key="entry.id"
          :class="['log-line', `lvl-${entry.level}`]"
        >
          <span class="log-ts">{{ entry.ts }}</span>
          <span class="log-text">{{ entry.text }}</span>
        </div>

        <!-- Summary + copy -->
        <template v-if="store.summary">
          <div class="log-line lvl-rule" />
          <div class="summary-block">
            <pre class="summary-pre">{{ store.summary }}</pre>
            <button class="btn btn-sm copy-btn" @click="copySummary">
              {{ copied ? '✓ 已复制' : '📋 复制报告' }}
            </button>
          </div>
        </template>
      </div>

      <!-- Results grid -->
      <div class="results-col">
        <div v-if="!store.results.length" class="grid-placeholder text-muted">
          测试结果图片将在此显示
        </div>
        <div ref="gridEl" class="results-grid">
          <div
            v-for="result in store.results"
            :key="result.case.id"
            :class="['test-card', `status-${result.status}`, result.verdict ? `v-${result.verdict}` : '']"
            @click="result.src && openPreview(result)"
          >
            <!-- Status indicator bar -->
            <div class="card-status-bar">
              <span v-if="result.status === 'pending'" class="status-dot pending" />
              <n-spin v-else-if="result.status === 'running'" :size="10" />
              <span v-else-if="result.verdict === 'pass'"    class="status-dot pass">✓</span>
              <span v-else-if="result.verdict === 'fail'"    class="status-dot fail">✗</span>
              <span v-else-if="result.verdict === 'ratelimit'" class="status-dot rl">⚡</span>
              <span v-else                                   class="status-dot info">·</span>
              <span class="card-label">{{ result.case.label }}</span>
            </div>

            <!-- Image -->
            <div class="card-img-wrap">
              <img
                v-if="result.src"
                :src="result.src"
                :alt="result.case.label"
                class="card-img"
                @load="onImgLoad(result, $event)"
              />
              <!-- Only the first image is rendered, so the count has to be stated
                   or a request that returned 2 would look identical to one. -->
              <span v-if="(result.imageCount ?? 0) > 1" class="img-count-badge">
                {{ result.imageCount }} 张
              </span>
              <div v-else-if="result.status === 'running'" class="card-img-ph loading">
                <n-spin :size="18" />
              </div>
              <div v-else-if="result.status === 'error'" class="card-img-ph error">
                <span class="err-icon">✗</span>
              </div>
              <div v-else class="card-img-ph" />
            </div>

            <!-- Detail line -->
            <div class="card-detail text-muted">
              {{ result.detail ?? (result.status === 'pending' ? '等待中…' : result.error ?? '') }}
            </div>
          </div>
        </div>
      </div>

    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick, computed } from 'vue'
import { NSpin } from 'naive-ui'
import { useApiTestStore, TEST_CASE_COUNT } from '@/stores/apiTest'
import { useImageGenStore } from '@/stores/imageGen'
import type { TestResult } from '@/types'

const CONCURRENCY = 50

const store     = useApiTestStore()
const imageGen  = useImageGenStore()

const terminalEl = ref<HTMLElement | null>(null)
const gridEl     = ref<HTMLElement | null>(null)
const copied     = ref(false)

const blockReason = computed(() => {
  if (!imageGen.config.api_key) return '请先在配置中填写 API Key'
  return ''
})

// Auto-scroll terminal to bottom on new log entries.
watch(() => store.logs.length, async () => {
  await nextTick()
  const el = terminalEl.value
  if (el) el.scrollTop = el.scrollHeight
})

function onImgLoad(result: TestResult, e: Event) {
  const img = e.target as HTMLImageElement
  result.width  = img.naturalWidth
  result.height = img.naturalHeight
}

function openPreview(result: TestResult) {
  // Open the image in a new tab for a quick full-size look.
  if (result.src) window.open(result.src, '_blank')
}

async function copySummary() {
  try {
    await navigator.clipboard.writeText(store.summary)
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  } catch {
    // clipboard not available (non-https), fall back to select
    const el = document.querySelector('.summary-pre') as HTMLElement
    if (el) {
      const range = document.createRange()
      range.selectNodeContents(el)
      window.getSelection()?.removeAllRanges()
      window.getSelection()?.addRange(range)
    }
  }
}
</script>

<style scoped>
/* ── Layout ── */
.test-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
  height: 100%;
}

.test-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-radius: var(--radius-card);
  background: var(--bg);
}

.header-left { display: flex; flex-direction: column; gap: 2px; }
.test-title  { font-weight: 700; font-size: 13px; color: var(--text-primary); }
.test-meta   { font-size: 11px; color: var(--text-muted); }

.header-right {
  display: flex;
  align-items: center;
  gap: 10px;
}

.progress-label {
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  color: var(--text-muted);
}

/* ── Body ── */
.test-body {
  display: flex;
  gap: 14px;
  flex: 1;
  min-height: 0;
}

/* ── Terminal ── */
.terminal {
  flex: 0 0 420px;
  background: #1B1F27;
  border-radius: var(--radius-card);
  padding: 12px 14px;
  overflow-y: auto;
  font-family: 'Consolas', 'Menlo', 'Monaco', monospace;
  font-size: 11.5px;
  line-height: 1.65;
  color: #A8B0BD;
}

.term-placeholder {
  font-size: 11px;
  opacity: 0.5;
  padding: 8px 0;
}

.log-line {
  display: flex;
  gap: 10px;
  min-height: 20px;
}

.log-line.lvl-rule {
  border-top: 1px solid #2E3340;
  margin: 6px 0;
}

.log-ts   { color: #546070; flex-shrink: 0; }
.log-text { word-break: break-all; }

.lvl-ok    .log-text { color: #4DC98C; }
.lvl-warn  .log-text { color: #E5A43A; }
.lvl-error .log-text { color: #E05D5D; }
.lvl-info  .log-text { color: #A8B0BD; }
.lvl-rule  .log-text { display: none; }

/* Summary */
.summary-block {
  margin-top: 10px;
  background: #242830;
  border-radius: 8px;
  padding: 10px 12px;
}
.summary-pre {
  white-space: pre-wrap;
  font-family: inherit;
  font-size: 11px;
  color: #C8D0DC;
  margin: 0 0 8px;
}
.copy-btn {
  background: #2E3340;
  color: #A8B0BD;
  box-shadow: none;
  border: 1px solid #3A3F4E;
}
.copy-btn:hover:not(:disabled) { color: #4DC98C; }

/* ── Results column ── */
.results-col {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
}

.grid-placeholder {
  font-size: 11px;
  opacity: 0.5;
  padding: 16px 0;
  text-align: center;
}

.results-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 10px;
}

/* ── Test card ── */
.test-card {
  background: var(--bg);
  border-radius: var(--radius-input);
  box-shadow: 3px 3px 6px var(--shadow-dark), -3px -3px 6px var(--shadow-light);
  overflow: hidden;
  cursor: default;
  transition: box-shadow 0.15s;
}
.test-card:has(img) { cursor: zoom-in; }
.test-card:has(img):hover {
  box-shadow: 4px 4px 8px var(--shadow-dark), -4px -4px 8px var(--shadow-light);
}

/* Accent strip at top for verdict */
.v-pass   { border-top: 2px solid #2E9B5E; }
.v-fail   { border-top: 2px solid #C7362F; }
.v-info   { border-top: 2px solid #5A89C8; }
.v-ratelimit { border-top: 2px solid #9A5B00; }

.card-status-bar {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 8px 2px;
}

.status-dot {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 700;
  width: 14px;
  text-align: center;
}
.status-dot.pending { color: var(--text-muted); }
.status-dot.pass    { color: #2E9B5E; }
.status-dot.fail    { color: #C7362F; }
.status-dot.rl      { color: #9A5B00; }
.status-dot.info    { color: #5A89C8; }

.card-label {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}

/* Count badge sits over the thumbnail; the wrapper is its containing block. */
.img-count-badge {
  position: absolute;
  right: 5px;
  bottom: 5px;
  padding: 1px 6px;
  border-radius: 6px;
  background: rgba(22, 24, 29, 0.78);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}

.card-img-wrap {
  position: relative;
  width: 100%;
  aspect-ratio: 1 / 1;
  background: var(--bg);
  box-shadow: inset 2px 2px 4px var(--shadow-dark), inset -2px -2px 4px var(--shadow-light);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.card-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.card-img-ph {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}
.card-img-ph.loading { opacity: 0.5; }
.card-img-ph.error   { color: #C7362F; font-size: 18px; }

.card-detail {
  padding: 4px 8px 6px;
  font-size: 10px;
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
