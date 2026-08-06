<template>
  <div class="ref-images">
    <div class="field-label">
      参考图
      <span class="text-muted" style="font-weight:400">
        {{ images.length }} / {{ MAX_REF_IMAGES }}
        <template v-if="images.length">· 共 {{ fmtBytes(totalBytes) }}</template>
      </span>
      <span class="spacer" />
      <n-button text size="tiny" :disabled="!images.length" @click="clearAll">清空</n-button>
    </div>

    <!-- Drop zone doubles as the picker; both paths run the same validation. -->
    <div
      class="dropzone"
      :class="{ over: dragging, full: images.length >= MAX_REF_IMAGES }"
      @click="images.length < MAX_REF_IMAGES && fileInput?.click()"
      @dragover.prevent="dragging = true"
      @dragleave.prevent="dragging = false"
      @drop.prevent="onDrop"
    >
      <input
        ref="fileInput"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        class="hidden-input"
        @change="onPick"
      />
      <span v-if="images.length >= MAX_REF_IMAGES" class="text-muted">
        已达 {{ MAX_REF_IMAGES }} 张上限
      </span>
      <span v-else class="text-muted">
        点击或拖入图片 · png / jpeg / webp · 单张 &lt; 50MB
      </span>
    </div>

    <p v-if="errors.length" class="errors">
      <span v-for="(e, i) in errors" :key="i" class="err-line">{{ e }}</span>
    </p>

    <!-- First slot is the canvas being edited; the rest are references. Order is
         meaningful, so it is shown and reorderable rather than implicit. -->
    <div v-if="images.length" class="thumbs">
      <div v-for="(img, i) in images" :key="img.id" class="thumb-card" :class="{ main: i === 0 }">
        <div class="thumb-box">
          <img :src="img.url" class="thumb-img" :alt="img.name" @load="onThumbLoad(img, $event)" />
          <span class="badge">{{ i === 0 ? '主图' : i + 1 }}</span>
          <button class="remove" title="移除" @click.stop="remove(i)">×</button>
        </div>
        <div class="thumb-meta text-muted">
          <span class="thumb-name" :title="img.name">{{ img.name }}</span>
          <span>{{ img.width ? `${img.width}×${img.height}` : '…' }} · {{ fmtBytes(img.bytes) }}</span>
        </div>
        <div class="thumb-actions">
          <button :disabled="i === 0" title="前移" @click.stop="move(i, -1)">←</button>
          <button :disabled="i === 0" title="设为主图" @click.stop="makeMain(i)">设为主图</button>
          <button :disabled="i === images.length - 1" title="后移" @click.stop="move(i, 1)">→</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { NButton } from 'naive-ui'
import type { RefImage } from '@/types'

/** Official ceiling for the edits endpoint. */
const MAX_REF_IMAGES = 16
const MAX_BYTES = 50 * 1024 * 1024
const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp']

const images = defineModel<RefImage[]>({ required: true })

const fileInput = ref<HTMLInputElement | null>(null)
const dragging = ref(false)
const errors = ref<string[]>([])

let seq = 0

const totalBytes = computed(() => images.value.reduce((a, b) => a + b.bytes, 0))

function onPick(e: Event) {
  const input = e.target as HTMLInputElement
  add(Array.from(input.files ?? []))
  input.value = ''
}

function onDrop(e: DragEvent) {
  dragging.value = false
  add(Array.from(e.dataTransfer?.files ?? []))
}

/** Validate against the documented limits up front, so a bad file is rejected
 *  here instead of burning a round trip and coming back as an upstream 400. */
function add(files: File[]) {
  errors.value = []
  const room = MAX_REF_IMAGES - images.value.length
  if (files.length > room) {
    errors.value.push(`最多 ${MAX_REF_IMAGES} 张，已忽略多出的 ${files.length - room} 张`)
    files = files.slice(0, Math.max(0, room))
  }

  for (const file of files) {
    if (!ACCEPTED.includes(file.type)) {
      errors.value.push(`${file.name}：仅支持 png / jpeg / webp`)
      continue
    }
    if (file.size > MAX_BYTES) {
      errors.value.push(`${file.name}：${fmtBytes(file.size)}，超过 50MB 上限`)
      continue
    }
    images.value.push({
      id: ++seq,
      file,
      name: file.name,
      url: URL.createObjectURL(file),
      bytes: file.size,
    })
  }
}

/** Real pixel dimensions, read once the thumbnail decodes. The mask has to match
 *  the first image exactly, so these are not cosmetic. */
function onThumbLoad(img: RefImage, e: Event) {
  const el = e.target as HTMLImageElement
  img.width = el.naturalWidth
  img.height = el.naturalHeight
}

function remove(i: number) {
  const [gone] = images.value.splice(i, 1)
  if (gone) URL.revokeObjectURL(gone.url)
}

function clearAll() {
  images.value.forEach(i => URL.revokeObjectURL(i.url))
  images.value = []
  errors.value = []
}

function move(i: number, delta: number) {
  const j = i + delta
  if (j < 0 || j >= images.value.length) return
  const arr = images.value
  ;[arr[i], arr[j]] = [arr[j], arr[i]]
}

function makeMain(i: number) {
  if (i === 0) return
  const arr = images.value
  arr.unshift(...arr.splice(i, 1))
}

function fmtBytes(b: number) {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}
</script>

<style scoped>
.ref-images { display: flex; flex-direction: column; gap: 8px; }

.field-label {
  display: flex; align-items: center; gap: 8px;
  font-size: 12px; font-weight: 600;
  color: var(--text-primary);
}
.spacer { flex: 1; }

.hidden-input { display: none; }

.dropzone {
  display: flex; align-items: center; justify-content: center;
  padding: 14px;
  border-radius: var(--radius-input);
  font-size: 11.5px;
  cursor: pointer;
  box-shadow: inset 4px 4px 8px var(--shadow-dark), inset -4px -4px 8px var(--shadow-light);
  transition: box-shadow 0.15s;
}
.dropzone.over { box-shadow: inset 0 0 0 2px var(--accent); }
.dropzone.full { cursor: not-allowed; opacity: 0.65; }

.errors { display: flex; flex-direction: column; gap: 2px; }
.err-line { color: #c0564a; font-size: 11px; }

.thumbs {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
  gap: 10px;
}

.thumb-card {
  display: flex; flex-direction: column; gap: 4px;
  padding: 6px;
  border-radius: var(--radius-input);
  box-shadow: 3px 3px 6px var(--shadow-dark), -3px -3px 6px var(--shadow-light);
}
/* The first image is what the mask applies to, so it is called out visually */
.thumb-card.main { box-shadow: 0 0 0 2px var(--accent), 3px 3px 6px var(--shadow-dark); }

.thumb-box {
  position: relative;
  aspect-ratio: 1;
  border-radius: 7px;
  overflow: hidden;
  background: #dfe4ea;
  display: flex; align-items: center; justify-content: center;
}
.thumb-img { max-width: 100%; max-height: 100%; object-fit: contain; display: block; }

.badge {
  position: absolute; left: 4px; top: 4px;
  padding: 1px 7px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 9.5px;
}
.remove {
  position: absolute; right: 4px; top: 4px;
  width: 18px; height: 18px;
  border: none; border-radius: 50%;
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  font-size: 13px; line-height: 1;
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
}
.remove:hover { background: #c0564a; }

.thumb-meta {
  display: flex; flex-direction: column;
  font-size: 9.5px;
  font-variant-numeric: tabular-nums;
}
.thumb-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.thumb-actions { display: flex; gap: 3px; }
.thumb-actions button {
  flex: 1;
  padding: 2px 0;
  border: none; border-radius: 5px;
  background: var(--bg);
  color: var(--text-muted);
  font-size: 9.5px;
  cursor: pointer;
  box-shadow: 1px 1px 3px var(--shadow-dark), -1px -1px 3px var(--shadow-light);
}
.thumb-actions button:disabled { opacity: 0.35; cursor: not-allowed; }
.thumb-actions button:not(:disabled):hover { color: var(--accent); }
</style>
