<template>
  <!-- mask-closable: clicking outside dismisses it, which is why there is no
       cancel button — edits live in a local copy and are only committed by
       保存配置, so closing without saving already discards them. -->
  <n-drawer v-model:show="visible" :width="420" placement="right">
    <n-drawer-content title="API 配置" closable>
      <n-form :model="form" label-placement="left" label-width="100px" size="small">
        <!-- The backend appends /v1/images/generations itself, so a baseurl that
             already ends in /v1 produces /v1/v1/... and a 404. Said here because
             that failure reads like a bad key rather than a bad URL. -->
        <n-form-item label="Base URL">
          <n-input v-model:value="form.baseurl" placeholder="https://api.example.com（不要带 /v1）" />
        </n-form-item>
        <n-form-item label="API Key">
          <n-input v-model:value="form.api_key" type="password" show-password-on="click" placeholder="sk-..." />
        </n-form-item>
        <n-form-item label="Model ID">
          <n-input v-model:value="form.model_id" placeholder="gpt-image-2" />
        </n-form-item>
        <n-form-item label="超时 (秒)">
          <n-input-number v-model:value="form.timeout" :min="60" :max="600" style="width:100%" placeholder="480"/>
        </n-form-item>
      </n-form>

      <template #footer>
        <div style="display:flex;gap:10px;justify-content:flex-end">
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
