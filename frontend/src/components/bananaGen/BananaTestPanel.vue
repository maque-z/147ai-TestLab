<template>
  <div class="test-panel">
    <div class="test-header nm-raised">
      <div class="header-left">
        <span class="test-title">Gemini 图片兼容性测试</span>
        <span class="test-meta">{{ BANANA_TEST_CASE_COUNT }} 个探测 · 并发 {{ BANANA_TEST_CONCURRENCY }} · 包含编辑与蒙版探测</span>
      </div>
      <div class="header-right">
        <span v-if="store.running" class="progress-label">{{ store.doneCount }} / {{ store.totalCount }}</span>
        <button v-if="!store.running" class="btn btn-primary" :disabled="!!blockReason" :title="blockReason || `约消耗 ${BANANA_TEST_CASE_COUNT} 次调用额度`" @click="store.run()">▶ 开始测试</button>
        <button v-else class="btn btn-danger" @click="store.stop()">■ 停止</button>
        <button v-if="store.results.length && !store.running" class="btn btn-sm" @click="store.clear()">🗑 清除</button>
      </div>
    </div>

    <div class="test-body">
      <div ref="terminalEl" class="terminal">
        <div v-if="!store.logs.length" class="term-placeholder">点击「开始测试」，不会自动消耗额度。</div>
        <div v-for="entry in store.logs" :key="entry.id" :class="['log-line', `lvl-${entry.level}`]">
          <span class="log-ts">{{ entry.ts }}</span><span>{{ entry.text }}</span>
        </div>
        <template v-if="store.summary">
          <div class="log-rule" />
          <div class="summary-block">
            <pre>{{ store.summary }}</pre>
            <button class="btn btn-sm copy-btn" @click="copySummary">{{ copied ? '✓ 已复制' : '📋 复制报告' }}</button>
          </div>
        </template>
      </div>

      <div class="results-col">
        <div v-if="!store.results.length" class="grid-placeholder text-muted">探测结果将在这里显示</div>
        <div class="results-grid">
          <div v-for="result in store.results" :key="result.case.id" :class="['test-card', result.verdict ? `v-${result.verdict}` : '']" @click="result.src && openPreview(result.src)">
            <div class="card-status-bar">
              <span v-if="result.status === 'pending'" class="status-dot pending">·</span>
              <n-spin v-else-if="result.status === 'running'" :size="10" />
              <span v-else :class="['status-dot', result.verdict]">{{ verdictIcon(result.verdict) }}</span>
              <span class="card-label" :title="result.case.label">{{ result.case.label }}</span>
            </div>
            <div class="card-img-wrap">
              <img v-if="result.src" :src="result.src" :alt="result.case.label" class="card-img" />
              <n-spin v-else-if="result.status === 'running'" :size="18" />
              <span v-else-if="result.status === 'error'" class="error-icon">✗</span>
            </div>
            <div class="card-detail" :title="result.detail">{{ result.detail ?? (result.status === 'pending' ? '等待中…' : result.status) }}</div>
            <div v-if="result.requestId" class="request-id" :title="result.requestId">ID {{ result.requestId }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { NSpin } from 'naive-ui'
import { useBananaGenStore } from '@/stores/bananaGen'
import { BANANA_TEST_CASE_COUNT, BANANA_TEST_CONCURRENCY, useBananaTestStore } from '@/stores/bananaTest'
import type { BananaTestVerdict } from '@/types'

const store = useBananaTestStore()
const banana = useBananaGenStore()
const terminalEl = ref<HTMLElement | null>(null)
const copied = ref(false)
const blockReason = computed(() => !banana.config.api_key ? '请先在 Gemini 配置中填写 API Key' : !banana.config.model_id ? '请先选择默认模型' : '')

watch(() => store.logs.length, async () => { await nextTick(); if (terminalEl.value) terminalEl.value.scrollTop = terminalEl.value.scrollHeight })
function verdictIcon(v?: BananaTestVerdict) { return v === 'pass' ? '✓' : v === 'fail' ? '✗' : v === 'ratelimit' ? '⚡' : '·' }
function openPreview(src: string) { window.open(src, '_blank') }
async function copySummary() {
  try { await navigator.clipboard.writeText(store.summary); copied.value = true; setTimeout(() => { copied.value = false }, 2000) }
  catch { copied.value = false }
}
</script>

<style scoped>
.test-panel { display:flex; flex-direction:column; gap:16px; min-height:0; }
.test-header { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:12px 16px; border-radius:var(--radius-card); background:var(--bg); }
.header-left { display:flex; flex-direction:column; gap:2px; }.test-title{font-size:13px;font-weight:700}.test-meta,.progress-label{font-size:11px;color:var(--text-muted)}
.header-right{display:flex;align-items:center;gap:10px}.test-body{display:flex;gap:14px;min-height:0}.terminal{flex:0 0 420px;max-height:640px;overflow:auto;padding:12px 14px;border-radius:var(--radius-card);background:#1b1f27;color:#a8b0bd;font:11px/1.65 Consolas,Menlo,monospace}
.term-placeholder{opacity:.55;padding:8px 0}.log-line{display:flex;gap:10px;min-height:20px;word-break:break-word}.log-ts{color:#546070;flex-shrink:0}.lvl-ok{color:#4dc98c}.lvl-warn{color:#e5a43a}.lvl-error{color:#e05d5d}.lvl-rule{border-top:1px solid #2e3340;margin:6px 0;height:1px}.log-rule{border-top:1px solid #2e3340;margin:8px 0}
.summary-block{background:#242830;border-radius:8px;padding:10px 12px}.summary-block pre{white-space:pre-wrap;margin:0 0 8px;font:11px/1.55 Consolas,Menlo,monospace}.copy-btn{background:#2e3340;color:#a8b0bd;box-shadow:none}
.results-col{flex:1;min-width:0;overflow-y:auto}.grid-placeholder{text-align:center;padding:20px}.results-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(165px,1fr));gap:10px}.test-card{overflow:hidden;border-radius:var(--radius-input);background:var(--bg);box-shadow:3px 3px 6px var(--shadow-dark),-3px -3px 6px var(--shadow-light)}.test-card:has(img){cursor:zoom-in}.v-pass{border-top:2px solid #2e9b5e}.v-fail{border-top:2px solid #c7362f}.v-info{border-top:2px solid #5a89c8}.v-ratelimit{border-top:2px solid #9a5b00}
.card-status-bar{display:flex;align-items:center;gap:5px;padding:5px 8px 3px}.status-dot{width:14px;text-align:center;font-size:10px;font-weight:700}.status-dot.pass{color:#2e9b5e}.status-dot.fail{color:#c7362f}.status-dot.info{color:#5a89c8}.status-dot.ratelimit{color:#9a5b00}.card-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;font-weight:600}.card-img-wrap{aspect-ratio:1;display:flex;align-items:center;justify-content:center;overflow:hidden;box-shadow:inset 2px 2px 4px var(--shadow-dark),inset -2px -2px 4px var(--shadow-light)}.card-img{width:100%;height:100%;object-fit:cover}.error-icon{color:#c7362f}.card-detail,.request-id{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:5px 8px;font-size:9.5px;color:var(--text-muted)}.request-id{padding-top:0;font-family:monospace;opacity:.7}
@media(max-width:900px){.test-body{flex-direction:column}.terminal{flex:none;max-height:220px}.results-col{overflow:visible}}@media(max-width:640px){.test-header{flex-wrap:wrap}.header-right{width:100%;justify-content:flex-end}.terminal{max-height:170px}}
</style>
