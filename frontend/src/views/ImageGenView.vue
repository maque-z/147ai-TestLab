<template>
  <div class="image-gen-view">
    <div class="view-header nm-raised">
      <div>
        <h2 class="view-title">GPT Image 生成</h2>
        <p class="view-desc text-muted">基于 OpenAI gpt-image-2 API 的图像生成工具</p>
      </div>
      <button class="config-btn nm-btn" @click="showConfig = true">
        ⚙️ 配置
      </button>
    </div>

    <ImageGenPanel />
    <ImageGenConfig v-model:show="showConfig" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useImageGenStore } from '@/stores/imageGen'
import ImageGenPanel from '@/components/imageGen/ImageGenPanel.vue'
import ImageGenConfig from '@/components/imageGen/ImageGenConfig.vue'

const showConfig = ref(false)
const store = useImageGenStore()

onMounted(() => store.loadConfig())
</script>

<style scoped>
.image-gen-view { display: flex; flex-direction: column; gap: 20px; }

.view-header {
  background: var(--bg);
  border-radius: var(--radius-card);
  padding: 20px 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.view-title { font-size: 18px; font-weight: 700; margin-bottom: 4px; }
.view-desc  { font-size: 13px; }

.config-btn {
  height: 38px;
  padding: 0 18px;
  border: none;
  border-radius: 10px;
  background: var(--bg);
  color: var(--text-primary);
  font-size: 14px;
  cursor: pointer;
}
</style>
