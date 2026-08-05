<template>
  <n-drawer v-model:show="visible" :width="460" placement="right" :mask-closable="false">
    <n-drawer-content title="API 配置" closable>
      <n-form :model="form" label-placement="left" label-width="110px" size="small">

        <n-divider title-placement="left">连接设置</n-divider>
        <n-form-item label="Base URL">
          <n-input v-model:value="form.baseurl" placeholder="https://api.openai.com/v1" />
        </n-form-item>
        <n-form-item label="API Key">
          <n-input v-model:value="form.api_key" type="password" show-password-on="click" placeholder="sk-..." />
        </n-form-item>
        <n-form-item label="Model ID">
          <n-input v-model:value="form.model_id" placeholder="gpt-image-alpha" />
        </n-form-item>
        <n-form-item label="超时 (秒)">
          <n-input-number v-model:value="form.timeout" :min="10" :max="600" style="width:100%" />
        </n-form-item>

        <n-divider title-placement="left">默认生成参数</n-divider>
        <n-form-item label="图片尺寸">
          <n-select v-model:value="form.size" :options="sizeOptions" />
        </n-form-item>
        <n-form-item label="质量">
          <n-select v-model:value="form.quality" :options="qualityOptions" />
        </n-form-item>
        <n-form-item label="生成数量">
          <n-input-number v-model:value="form.n" :min="1" :max="10" style="width:100%" />
        </n-form-item>
        <n-form-item label="输出格式">
          <n-select v-model:value="form.output_format" :options="formatOptions" />
        </n-form-item>
        <n-form-item v-if="form.output_format !== 'png'" label="压缩质量">
          <n-slider v-model:value="form.output_compression" :min="1" :max="100" :tooltip="true" />
        </n-form-item>
        <n-form-item label="背景">
          <n-select v-model:value="form.background" :options="bgOptions" />
        </n-form-item>
        <n-form-item label="内容审核">
          <n-select v-model:value="form.moderation" :options="modOptions" />
        </n-form-item>
      </n-form>

      <template #footer>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <n-button @click="visible = false">取消</n-button>
          <n-button type="primary" :loading="saving" @click="handleSave">保存配置</n-button>
        </div>
      </template>
    </n-drawer-content>
  </n-drawer>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { useMessage, NDrawer, NDrawerContent, NForm, NFormItem, NInput,
         NInputNumber, NSelect, NSlider, NButton, NDivider } from 'naive-ui'
import { useImageGenStore } from '@/stores/imageGen'
import type { ImageConfig } from '@/types'

const visible = defineModel<boolean>('show', { required: true })
const message = useMessage()
const store = useImageGenStore()
const saving = ref(false)
const form = ref<ImageConfig>({ ...store.config })

watch(visible, (v) => { if (v) form.value = { ...store.config } })

const sizeOptions = [
  { label: '1024×1024 (方形)', value: '1024x1024' },
  { label: '1536×1024 (横屏)', value: '1536x1024' },
  { label: '1024×1536 (竖屏)', value: '1024x1536' },
  { label: 'auto', value: 'auto' }
]
const qualityOptions = [
  { label: 'auto', value: 'auto' },
  { label: 'low', value: 'low' },
  { label: 'medium', value: 'medium' },
  { label: 'high', value: 'high' }
]
const formatOptions = [
  { label: 'PNG', value: 'png' },
  { label: 'JPEG', value: 'jpeg' },
  { label: 'WebP', value: 'webp' }
]
const bgOptions = [
  { label: 'auto', value: 'auto' },
  { label: 'opaque (不透明)', value: 'opaque' },
  { label: 'transparent (透明)', value: 'transparent' }
]
const modOptions = [
  { label: 'auto', value: 'auto' },
  { label: 'low', value: 'low' }
]

async function handleSave() {
  saving.value = true
  try {
    await store.updateConfig(form.value)
    message.success('配置已保存')
    visible.value = false
  } catch (e: any) {
    message.error(e?.response?.data?.detail || '保存失败')
  } finally {
    saving.value = false
  }
}
</script>
