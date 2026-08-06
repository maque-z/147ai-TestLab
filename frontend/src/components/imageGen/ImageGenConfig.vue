<template>
  <n-drawer v-model:show="visible" :width="420" placement="right" :mask-closable="false">
    <n-drawer-content title="API 配置" closable>
      <n-form :model="form" label-placement="left" label-width="100px" size="small">
        <n-form-item label="Base URL">
          <n-input v-model:value="form.baseurl" placeholder="https://api.147ai.cn" />
        </n-form-item>
        <n-form-item label="API Key">
          <n-input v-model:value="form.api_key" type="password" show-password-on="click" placeholder="sk-..." />
        </n-form-item>
        <n-form-item label="Model ID">
          <n-input v-model:value="form.model_id" placeholder="gpt-image-2" />
        </n-form-item>
        <n-form-item label="超时 (秒)">
          <n-input-number v-model:value="form.timeout" :min="60" :max="600" style="width:100%" placeholder="360"/>
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
         NInputNumber, NButton } from 'naive-ui'
import { useImageGenStore } from '@/stores/imageGen'
import type { ImageConfig } from '@/types'

const visible = defineModel<boolean>('show', { required: true })
const message = useMessage()
const store = useImageGenStore()
const saving = ref(false)
const form = ref<ImageConfig>({ ...store.config })

watch(visible, (v) => { if (v) form.value = { ...store.config } })

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
