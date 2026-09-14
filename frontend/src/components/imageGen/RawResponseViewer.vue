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
        <!-- Who actually answered, judged from the headers/body below, and how
             the image bytes arrived. The evidence is quoted so the verdict can
             always be second-guessed against the transcript underneath. -->
        <div v-if="verdict || dataKind" class="raw-vendor">
          <span v-if="verdict" :class="['vendor-badge', `k-${verdict.vendor}`]">{{ verdict.label }}</span>
          <span
            v-if="dataKind"
            class="kind-chip"
            title="返回数据形式（官方规范：GPT image 模型仅返回 b64_json）"
          >{{ dataKind }}</span>
          <span v-if="verdict" class="vendor-evidence">{{ verdict.evidence.join(' · ') }}</span>
        </div>

        <!-- Content Credentials. Sits below the header/body verdict rather than
             merging with it: the two are judged from different evidence, and
             this one is the only cryptographic claim of the pair. -->
        <div v-if="c2pa" class="raw-c2pa" :title="c2paTooltip(c2pa)">
          <span :class="['c2pa-status', `s-${c2pa.status}`]">{{ c2pa.status_label }}</span>
          <span class="c2pa-line">{{ describeC2pa(c2pa) }}</span>
          <span class="c2pa-evidence">{{ c2pa.evidence.join(' · ') }}</span>
          <span v-if="c2pa.problems.length" class="c2pa-problems">
            ✗ {{ c2pa.problems.join(' · ') }}
          </span>
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
import type { C2paProvenance, UpstreamSnapshot, VendorVerdict } from '@/types'
import { c2paTooltip, describeC2pa } from '@/utils/vendor'

const props = defineProps<{
  show: boolean
  /** Card label, so the transcript says which probe it belongs to. */
  title: string
  snapshot: UpstreamSnapshot | null
  /** Judged by the store when the result landed — the same verdict the card
   *  chip and the report use, so the three can never disagree. */
  verdict?: VendorVerdict | null
  /** How the image bytes arrived (b64_json / data:URL / url→host). */
  dataKind?: string
  /** Content Credentials read off the image bytes. Not part of the HTTP
   *  exchange below — it is in the image, which is exactly why it is worth
   *  showing beside the headers both can be compared against. */
  c2pa?: C2paProvenance | null
}>()
const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
}>()

const copied = ref(false)

const statusOk = computed(() => (props.snapshot?.status ?? 0) < 400)

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
.vendor-badge.k-reverse { color: #E5A43A; background: rgba(229, 164, 58, 0.14); }
.vendor-badge.k-unknown { color: #8B93A3; background: rgba(139, 147, 163, 0.13); }

.kind-chip {
  flex-shrink: 0;
  font-family: 'Consolas', 'Menlo', 'Monaco', monospace;
  font-size: 10.5px;
  padding: 1px 7px;
  border-radius: 6px;
  color: #A8B0BD;
  background: rgba(168, 176, 189, 0.12);
}

.vendor-evidence {
  font-family: 'Consolas', 'Menlo', 'Monaco', monospace;
  font-size: 10.5px;
  line-height: 1.5;
  color: #8B93A3;
  word-break: break-all;
}

/* ── Content Credentials strip ── */
.raw-c2pa {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 6px 10px;
  padding: 7px 14px;
  background: #1E2530;
  border-bottom: 1px solid #2E3340;
  flex-shrink: 0;
  cursor: help;
}

.c2pa-status {
  flex-shrink: 0;
  font-size: 10.5px;
  font-weight: 700;
  padding: 1px 7px;
  border-radius: 6px;
}
.c2pa-status.s-trusted { color: #4DC98C; background: rgba(77, 201, 140, 0.14); }
.c2pa-status.s-valid   { color: #E5A43A; background: rgba(229, 164, 58, 0.14); }
.c2pa-status.s-invalid { color: #E05D5D; background: rgba(224, 93, 93, 0.14); }
.c2pa-status.s-not_present,
.c2pa-status.s-unreadable,
.c2pa-status.s-unsupported_format {
  color: #8B93A3;
  background: rgba(139, 147, 163, 0.12);
}

.c2pa-line {
  flex-shrink: 0;
  font-size: 11px;
  color: #C8D0DC;
}

.c2pa-evidence,
.c2pa-problems {
  font-family: 'Consolas', 'Menlo', 'Monaco', monospace;
  font-size: 10.5px;
  line-height: 1.5;
  color: #8B93A3;
  word-break: break-all;
  flex-basis: 100%;
}
.c2pa-problems { color: #E05D5D; }

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
