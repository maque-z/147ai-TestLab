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
        <n-form-item label="超时 (秒)">
          <n-input-number v-model:value="form.timeout" :min="60" :max="600" style="width:100%" placeholder="480"/>
        </n-form-item>
      </n-form>

      <!-- The model used to be a field here. It is a matrix dimension now, so
           it lives with the other params — and this drawer must not carry a
           copy of it, or saving the drawer would overwrite a selection made
           since it was opened. -->
      <p class="field-help">
        模型不在这里填：参数面板的「模型」一栏可勾选多个官方模型，或添加自定义 ID；勾选和添加会自动保存到当前账号。
      </p>

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

/** Only the connection fields. The model lists are written by the parameter
 *  panel through the same endpoint, which applies whatever subset it is sent —
 *  so this form deliberately never carries them. */
type ConnectionForm = Pick<ImageConfig, 'baseurl' | 'api_key' | 'timeout'>

const visible = defineModel<boolean>('show', { required: true })
const message = useMessage()
const store = useImageGenStore()
const saving = ref(false)

function snapshot(): ConnectionForm {
  const { baseurl, api_key, timeout } = store.config
  return { baseurl, api_key, timeout }
}

const form = ref<ConnectionForm>(snapshot())

watch(visible, (v) => { if (v) form.value = snapshot() })

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

<style scoped>
.field-help { margin: -4px 0 0; color: var(--text-secondary); font-size: 11px; line-height: 1.6; }
</style>
