<template>
  <n-modal :show="show" @update:show="$emit('update:show', $event)">
    <div class="raw-overlay" @click="close">
      <div class="raw-panel" @click.stop>
        <div class="raw-header">
          <span :class="['raw-status', statusOk ? 'ok' : 'err']">
            {{ snapshot?.status ?? '—' }}
          </span>
          <span class="raw-title" :title="title">{{ title }}</span>
          <span class="raw-hint">base64 图片数据已过滤，其余为完整原文</span>
          <button class="raw-btn" @click="copyRaw">
            {{ copied ? '✓ 已复制' : '📋 复制' }}
          </button>
          <button class="raw-btn close" title="关闭 ( Esc )" @click="close">×</button>
        </div>
        <!-- Who actually answered, judged from the headers/body below. The
             evidence is quoted so the verdict can always be second-guessed. -->
        <div v-if="verdict" class="raw-vendor">
          <span :class="['vendor-badge', `k-${verdict.vendor}`]">{{ verdict.label }}</span>
          <span class="vendor-evidence">{{ verdict.evidence.join(' · ') }}</span>
        </div>
        <!-- One merged transcript: status line, every header, blank line, body.
             Reads like the wire format so it can be pasted into a report as-is. -->
        <pre class="raw-pre">{{ rawText }}</pre>
      </div>
    </div>
  </n-modal>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { NModal } from 'naive-ui'
import { detectVendor } from '@/utils/vendor'
import type { UpstreamSnapshot } from '@/types'

const props = defineProps<{
  show: boolean
  /** Card label, so the transcript says which probe it belongs to. */
  title: string
  snapshot: UpstreamSnapshot | null
}>()
const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
}>()

const copied = ref(false)

const statusOk = computed(() => (props.snapshot?.status ?? 0) < 400)

const verdict = computed(() => props.snapshot ? detectVendor(props.snapshot) : null)

const rawText = computed(() => {
  const s = props.snapshot
  if (!s) return ''
  const statusLine = `${s.http_version || 'HTTP'} ${s.status}${s.reason ? ' ' + s.reason : ''}`
  const headerLines = (s.headers ?? []).map(([k, v]) => `${k}: ${v}`).join('\n')

  let body: string
  if (s.body !== undefined && s.body !== null) {
    body = typeof s.body === 'string' ? s.body : JSON.stringify(s.body, null, 2)
  } else if (s.body_text) {
    body = s.body_text
  } else {
    body = '（空响应体）'
  }
  return `${statusLine}\n${headerLines}\n\n${body}`
})

function close() {
  emit('update:show', false)
}

async function copyRaw() {
  try {
    await navigator.clipboard.writeText(rawText.value)
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  } catch {
    // clipboard not available (non-https), fall back to select
    const el = document.querySelector('.raw-pre') as HTMLElement
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
.raw-overlay {
  width: 100vw;
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

/* Same palette as the test panel's terminal — this is the same kind of text. */
.raw-panel {
  display: flex;
  flex-direction: column;
  width: min(860px, 100%);
  max-height: 86vh;
  background: #1B1F27;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
}

.raw-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: #242830;
  flex-shrink: 0;
}

.raw-status {
  font-family: 'Consolas', 'Menlo', 'Monaco', monospace;
  font-size: 12px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  padding: 1px 8px;
  border-radius: 6px;
  flex-shrink: 0;
}
.raw-status.ok  { color: #4DC98C; background: rgba(77, 201, 140, 0.12); }
.raw-status.err { color: #E05D5D; background: rgba(224, 93, 93, 0.12); }

.raw-title {
  font-size: 12px;
  font-weight: 600;
  color: #E8ECF3;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.raw-hint {
  font-size: 10.5px;
  color: #546070;
  margin-left: auto;
  flex-shrink: 0;
}

.raw-btn {
  flex-shrink: 0;
  border: 1px solid #3A3F4E;
  border-radius: 6px;
  background: #2E3340;
  color: #A8B0BD;
  font-size: 11px;
  padding: 3px 8px;
  cursor: pointer;
}
.raw-btn:hover { color: #4DC98C; }
.raw-btn.close {
  font-size: 14px;
  line-height: 1;
  padding: 3px 7px;
}
.raw-btn.close:hover { color: #E05D5D; }

/* ── Vendor verdict strip ── */
.raw-vendor {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 7px 14px;
  background: #20242D;
  border-bottom: 1px solid #2E3340;
  flex-shrink: 0;
}

.vendor-badge {
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 700;
  padding: 1px 8px;
  border-radius: 6px;
}
.vendor-badge.k-openai  { color: #4DC98C; background: rgba(77, 201, 140, 0.12); }
.vendor-badge.k-azure   { color: #5A9BD5; background: rgba(90, 155, 213, 0.14); }
.vendor-badge.k-other   { color: #E5A43A; background: rgba(229, 164, 58, 0.13); }
.vendor-badge.k-unknown { color: #8B93A3; background: rgba(139, 147, 163, 0.13); }

.vendor-evidence {
  font-family: 'Consolas', 'Menlo', 'Monaco', monospace;
  font-size: 10.5px;
  line-height: 1.5;
  color: #8B93A3;
  word-break: break-all;
}

.raw-pre {
  margin: 0;
  padding: 12px 14px;
  overflow: auto;
  font-family: 'Consolas', 'Menlo', 'Monaco', monospace;
  font-size: 11.5px;
  line-height: 1.6;
  color: #C8D0DC;
  white-space: pre-wrap;
  word-break: break-all;
}

@media (max-width: 640px) {
  .raw-overlay { padding: 10px; }
  .raw-panel   { max-height: 92vh; }
  .raw-hint    { display: none; }
}
</style>
