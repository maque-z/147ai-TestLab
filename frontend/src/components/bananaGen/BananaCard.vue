<template>
  <div class="card nm-raised" :data-job="job.id">
    <div class="canvas" @click="activeImg?.src && emit('preview', job)">
      <img
        v-if="activeImg?.src"
        :src="activeImg.src"
        :alt="job.aspectRatio ?? '生成结果'"
        class="thumb"
        @load="onImgLoad"
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

      <!-- Carousel, only when the request actually returned more than one image.
           Its presence is itself the signal that candidateCount took effect. -->
      <template v-if="job.images.length > 1">
        <button class="nav prev" title="上一张" @click.stop="step(-1)">‹</button>
        <button class="nav next" title="下一张" @click.stop="step(1)">›</button>
        <div class="pager">{{ job.activeIndex + 1 }} / {{ job.images.length }}</div>
      </template>
    </div>

    <div class="meta">
      <!-- Model gets its own line: it is the widest value and the one that
           identifies the card. -->
      <div class="model-line" :title="job.model">{{ job.model }}</div>

      <div class="meta-head">
        <span>项</span>
        <span>请求 / 文档</span>
        <span>→ 实际</span>
      </div>
      <div
        v-for="row in compareRows"
        :key="row.label"
        class="meta-row3"
        :class="{ bad: row.bad }"
      >
        <span class="text-muted">{{ row.label }}</span>
        <span :title="row.wantTitle">{{ row.want }}</span>
        <span :title="row.bad ? row.badWhy ?? '与文档/请求不一致' : undefined">{{ row.got }}</span>
      </div>

      <div class="meta-row plain">
        <span class="text-muted">文件大小</span>
        <span>{{ activeImg?.bytes ? fmtBytes(activeImg.bytes) : '—' }}</span>
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
      <!-- usageMetadata, named as the doc names them -->
      <div class="meta-row plain">
        <span class="text-muted">token</span>
        <span :title="`promptTokenCount / candidatesTokenCount / totalTokenCount`">
          <span class="text-muted split-label">入/出/总</span>
          {{ job.promptTokens ?? '—' }} / {{ job.candidatesTokens ?? '—' }} / {{ job.totalTokens ?? '—' }}
        </span>
      </div>

      <div class="card-actions">
        <button
          v-if="job.status === 'pending' || job.status === 'running'"
          class="btn btn-sm btn-danger card-btn"
          :title="job.status === 'running' ? '中断这一张，其余继续' : '这一张还没发出，取消它'"
          @click.stop="emit('stop', job.id)"
        >
          <span class="btn-icon">■</span>
          {{ job.status === 'running' ? '停止' : '取消排队' }}
        </button>

        <button
          v-else-if="activeImg?.src"
          class="btn btn-sm btn-primary card-btn"
          title="保存这张图片"
          @click.stop="download"
        >
          <span class="btn-icon">⤓</span>
          下载{{ job.images.length > 1 ? ` 第 ${job.activeIndex + 1} 张` : '' }}
        </button>

        <!-- The model's text parts. Worth surfacing: text with no image is the
             documented symptom of responseModalities missing IMAGE. -->
        <span
          v-if="job.texts?.length"
          class="text-muted revised"
          :title="job.texts.join('\n\n')"
        >附带文本</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { NSpin } from 'naive-ui'
import { docPixels, effectiveSize, fmtPixels, nearestRatio, FINISH_REASONS } from '@/utils/bananaSpec'
import type { BananaJob } from '@/types'

const props = defineProps<{ job: BananaJob }>()
const emit = defineEmits<{ preview: [BananaJob]; stop: [number] }>()

const job = computed(() => props.job)
const activeImg = computed(() => props.job.images[props.job.activeIndex])

/** Move the carousel, wrapping at both ends. */
function step(delta: number) {
  const n = props.job.images.length
  if (n < 2) return
  props.job.activeIndex = (props.job.activeIndex + delta + n) % n
}

/** The backend reads dimensions from the file header, which covers every format
 *  Gemini returns. This fills them in for the hosted-URL case, where there were
 *  no bytes to inspect server-side. */
function onImgLoad(e: Event) {
  const el = e.target as HTMLImageElement
  const img = activeImg.value
  if (!img || img.width) return
  img.width = el.naturalWidth
  img.height = el.naturalHeight
}

interface CompareRow {
  label: string
  want: string
  got: string
  bad?: boolean
  wantTitle?: string
  badWhy?: string
}

const DASH = '—'

/** Build the 请求/文档 → 实际 rows.
 *
 *  The middle column is what the documentation promises, not merely what was
 *  requested — for a size/ratio pair the doc publishes an exact pixel count, so
 *  the card can hold the API to that figure rather than just echoing the request.
 *  A row is flagged only where the response genuinely contradicts the doc.
 */
const compareRows = computed<CompareRow[]>(() => {
  const j = props.job
  const img = activeImg.value
  const rows: CompareRow[] = []
  const done = j.status === 'done'

  // ---- size: requested tier + documented pixels vs measured pixels ----
  const eff = effectiveSize(j.model, j.imageSize)
  const expected = docPixels(j.model, j.aspectRatio, j.imageSize)
  const measured = img?.width ? `${img.width}×${img.height}` : undefined
  const fellBack = !!j.imageSize && eff !== j.imageSize

  rows.push({
    label: '分辨率',
    want: expected
      ? `${j.imageSize ?? '默认 1K'} · ${fmtPixels(expected)}`
      : `${j.imageSize ?? '默认 1K'} · 文档未列出`,
    got: measured ?? DASH,
    // Only a claim where the doc actually publishes a figure.
    bad: !!expected && !!measured && measured !== fmtPixels(expected),
    wantTitle: fellBack
      ? `文档称此模型不支持 ${j.imageSize}，会回退到 ${eff}；这里的期望像素按 ${eff} 计算`
      : undefined,
    badWhy: '实际像素与文档发布的对照表不一致',
  })

  // The documented silent fallback, called out separately so "got 1K when I asked
  // for 4K" reads as the documented behaviour rather than a surprise.
  if (fellBack) {
    rows.push({
      label: '└ 文档回退',
      want: `${j.imageSize} → ${eff}`,
      got: measured && expected && measured === fmtPixels(expected) ? '符合' : DASH,
    })
  }

  // ---- aspect ratio ----
  const gotRatio = img?.width && img?.height ? nearestRatio(img.width, img.height) : undefined
  rows.push({
    label: '比例',
    want: j.aspectRatio ?? '默认 1:1',
    got: gotRatio ?? DASH,
    bad: !!j.aspectRatio && !!gotRatio && gotRatio !== j.aspectRatio,
    // nearestRatio is approximate by design; say so rather than implying precision.
    wantTitle: '实际比例由解码像素反推，取最接近的文档比例',
  })

  // ---- format: magic bytes are authoritative over the declared mimeType ----
  rows.push({
    label: '格式',
    want: img?.declaredMime ?? DASH,
    got: img?.actualFormat ?? DASH,
    bad: !!img?.declaredMime && !!img?.actualFormat
      && !img.declaredMime.includes(img.actualFormat),
    badWhy: 'inlineData.mimeType 与实际魔术字节不符',
  })

  // ---- candidateCount: how many images actually came back ----
  const wantN = j.candidateCount ?? 1
  rows.push({
    label: '张数',
    want: j.candidateCount != null ? String(wantN) : '默认 1',
    got: done ? String(j.images.length) : DASH,
    bad: done && j.images.length !== wantN,
  })

  // ---- finishReason ----
  if (j.finishReasons?.length) {
    const reasons = j.finishReasons.join(', ')
    const clean = j.finishReasons.every(r => r === 'STOP')
    rows.push({
      label: 'finishReason',
      want: 'STOP',
      got: reasons,
      bad: !clean,
      badWhy: j.finishReasons.map(r => FINISH_REASONS[r] ?? r).join(' / '),
    })
  }

  // A 200 that refused. Distinct from an HTTP error, and the doc says these
  // cannot be turned off with safety params.
  if (j.blockReason) {
    rows.push({
      label: '拦截',
      want: '无',
      got: j.blockReason,
      bad: true,
      badWhy: FINISH_REASONS[j.blockReason] ?? '文档称此类拦截无法通过参数关闭',
    })
  }

  // The API echoes none of these back, so only the requested value is knowable.
  if (j.modalities) {
    rows.push({ label: 'modalities', want: j.modalities, got: DASH })
  }
  if (j.temperature != null) {
    rows.push({ label: 'temperature', want: String(j.temperature), got: DASH })
  }
  if (j.safetyThreshold) {
    rows.push({ label: 'safety', want: j.safetyThreshold, got: DASH })
  }

  // Only worth a row when the API reports having used a different model — a
  // gateway silently swapping models is exactly what this tool exists to catch.
  if (j.actualModel && j.actualModel !== j.model) {
    rows.push({ label: '模型', want: j.model, got: j.actualModel, bad: true })
  }

  return rows
})

function download() {
  const img = activeImg.value
  if (!img?.src) return
  const ext = img.actualFormat ?? 'png'
  const idx = props.job.images.length > 1 ? `_${props.job.activeIndex + 1}` : ''
  const parts = [
    props.job.model,
    props.job.aspectRatio?.replace(':', '-'),
    props.job.imageSize,
    String(props.job.id),
  ].filter(Boolean)
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

function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
}

function fmtFullTime(ts: number) {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}
</script>

<style scoped>
.card {
  background: var(--bg);
  border-radius: var(--radius-card);
  overflow: hidden;
  display: flex; flex-direction: column;
}

/* Fixed square canvas. Everything inside is absolutely positioned so no image or
   state block can contribute intrinsic height — a 9:16 4K portrait would
   otherwise out-vote aspect-ratio via min-content sizing and stretch the box. */
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

/* ===== Carousel (only rendered when candidateCount>1 actually returned) ===== */
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

/* The model is what identifies the card, and it is long — its own line, monospace
   so a 3.1 and a 2.5 are distinguishable at a glance. */
.model-line {
  font-family: 'Consolas', 'Menlo', 'Monaco', monospace;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  padding-bottom: 4px;
}

.meta-row { display: flex; justify-content: space-between; gap: 8px; }
.meta-row.plain { font-size: 10.5px; }
.split-label { font-size: 9.5px; margin-right: 4px; }

/* 请求/文档 → 实际 comparison table */
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
/* Highlight only the actual value — the doc is never the thing that is wrong */
.meta-row3.bad > :nth-child(3) { color: var(--danger); }

.meta-row3 > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-actions {
  display: flex; align-items: center;
  gap: 8px; margin-top: 7px;
}
.card-btn { flex: 1; min-width: 0; }
.revised {
  font-size: 10px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  max-width: 92px;
}

@media (max-width: 640px) {
  .meta-head,
  .meta-row3 { grid-template-columns: auto 1fr auto; gap: 4px; }
}
</style>
