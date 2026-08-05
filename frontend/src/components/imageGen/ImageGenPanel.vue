<template>
  <div class="panel">
    <!-- Prompt area -->
    <div class="prompt-card nm-raised">
      <n-input
        v-model:value="prompt"
        type="textarea"
        placeholder="描述你想生成的图片..."
        :autosize="{ minRows: 3, maxRows: 6 }"
        class="prompt-input"
      />
      <div class="prompt-actions">
        <div class="param-row">
          <n-select v-model:value="overrides.size" :options="sizeOptions"
                    size="small" style="width:160px" placeholder="尺寸 (默认)" clearable />
          <n-select v-model:value="overrides.quality" :options="qualityOptions"
                    size="small" style="width:130px" placeholder="质量 (默认)" clearable />
          <n-select v-model:value="overrides.background" :options="bgOptions"
                    size="small" style="width:140px" placeholder="背景 (默认)" clearable />
          <n-input-number v-model:value="overrides.n" :min="1" :max="10"
                          size="small" style="width:90px" placeholder="数量" clearable />
        </div>
        <button class="gen-btn nm-btn" :disabled="generating || !prompt.trim()" @click="handleGenerate">
          <span v-if="generating">生成中...</span>
          <span v-else>✨ 生成</span>
        </button>
      </div>
    </div>

    <!-- Results grid -->
    <div v-if="store.results.length" class="results-section">
      <div class="results-header">
        <span class="text-muted">共 {{ store.results.length }} 张</span>
        <n-button text size="small" @click="store.clearResults()">清除</n-button>
      </div>
      <div class="results-grid">
        <div v-for="(img, i) in store.results" :key="i" class="result-item nm-raised">
          <img
            :src="img.b64_json ? `data:image/png;base64,${img.b64_json}` : img.url"
            :alt="`生成图片 ${i + 1}`"
            class="result-img"
            @click="openPreview(img)"
          />
          <div class="result-footer">
            <n-button text size="small" @click="downloadImage(img, i)">下载</n-button>
            <span v-if="img.revised_prompt" class="revised text-muted" :title="img.revised_prompt">
              已优化提示词
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- Empty state -->
    <div v-else-if="!generating" class="empty-state text-muted">
      <div class="empty-icon">🖼️</div>
      <p>输入提示词，点击生成按钮开始创作</p>
    </div>

    <!-- Loading state -->
    <div v-if="generating" class="loading-state">
      <n-spin size="large" />
      <p class="text-muted" style="margin-top:12px">正在生成，请稍候...</p>
    </div>

    <!-- Image preview modal -->
    <n-modal v-model:show="previewVisible" :mask-closable="true">
      <div class="preview-wrap" @click="previewVisible = false">
        <img :src="previewSrc" alt="预览" class="preview-img" @click.stop />
      </div>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useMessage, NInput, NSelect, NInputNumber, NButton, NSpin, NModal } from 'naive-ui'
import { useImageGenStore } from '@/stores/imageGen'
import type { GeneratedImage } from '@/types'

const message = useMessage()
const store = useImageGenStore()
const prompt = ref('')
const generating = store.generating
const previewVisible = ref(false)
const previewSrc = ref('')

const overrides = ref<{
  size?: string; quality?: string; background?: string; n?: number
}>({})

const sizeOptions = [
  { label: '1024×1024', value: '1024x1024' },
  { label: '1536×1024', value: '1536x1024' },
  { label: '1024×1536', value: '1024x1536' },
  { label: 'auto', value: 'auto' }
]
const qualityOptions = [
  { label: 'auto', value: 'auto' },
  { label: 'low', value: 'low' },
  { label: 'medium', value: 'medium' },
  { label: 'high', value: 'high' }
]
const bgOptions = [
  { label: 'auto', value: 'auto' },
  { label: 'opaque', value: 'opaque' },
  { label: 'transparent', value: 'transparent' }
]

async function handleGenerate() {
  if (!prompt.value.trim()) return
  try {
    await store.generate(prompt.value, overrides.value)
  } catch (e: any) {
    message.error(e?.response?.data?.detail || '生成失败')
  }
}

function openPreview(img: GeneratedImage) {
  previewSrc.value = img.b64_json ? `data:image/png;base64,${img.b64_json}` : (img.url ?? '')
  previewVisible.value = true
}

function downloadImage(img: GeneratedImage, index: number) {
  const src = img.b64_json ? `data:image/png;base64,${img.b64_json}` : img.url
  if (!src) return
  const a = document.createElement('a')
  a.href = src
  a.download = `generated-${Date.now()}-${index}.png`
  a.click()
}
</script>

<style scoped>
.panel { display: flex; flex-direction: column; gap: 20px; }

.prompt-card {
  background: var(--bg);
  border-radius: var(--radius-card);
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.prompt-input :deep(.n-input__textarea-el) {
  background: transparent !important;
  resize: none;
}

.prompt-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.param-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }

.gen-btn {
  height: 38px;
  padding: 0 24px;
  border: none;
  border-radius: 10px;
  background: var(--accent);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
}
.gen-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.gen-btn:not(:disabled):hover { background: var(--accent-hover); }

.results-section { display: flex; flex-direction: column; gap: 12px; }
.results-header   { display: flex; align-items: center; justify-content: space-between; }

.results-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 16px;
}

.result-item {
  background: var(--bg);
  border-radius: var(--radius-card);
  overflow: hidden;
  cursor: pointer;
}

.result-img {
  width: 100%;
  aspect-ratio: 1;
  object-fit: cover;
  display: block;
  transition: opacity 0.2s;
}
.result-img:hover { opacity: 0.9; }

.result-footer {
  padding: 8px 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.revised { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 120px; }

.empty-state, .loading-state {
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  min-height: 240px; gap: 12px; text-align: center;
}
.empty-icon { font-size: 48px; opacity: 0.4; }

.preview-wrap {
  display: flex; align-items: center; justify-content: center;
  padding: 24px; cursor: pointer;
}
.preview-img { max-width: 90vw; max-height: 88vh; border-radius: 12px; cursor: default; }
</style>
