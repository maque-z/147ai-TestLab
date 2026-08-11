<template>
  <!-- mask-closable: clicking outside dismisses it, which is why there is no
       cancel button — edits live in a local copy and are only committed by
       保存配置, so closing without saving already discards them. -->
  <n-drawer v-model:show="visible" :width="420" placement="right">
    <n-drawer-content title="Gemini API 配置" closable>
      <n-form :model="form" label-placement="left" label-width="100px" size="small">
        <!-- The backend appends /v1beta/... itself, so a baseurl that already ends
             in a version segment produces a 404. Said here because that failure
             reads like a bad key rather than a bad URL. -->
        <n-form-item label="Base URL">
          <n-input v-model:value="form.baseurl" placeholder="https://api.147ai.cn（不要带 /v1beta）" />
        </n-form-item>
        <n-form-item label="API Key">
          <n-input v-model:value="form.api_key" type="password" show-password-on="click" placeholder="sk-..." />
        </n-form-item>
        <!-- Only the default: the batch matrix sends a model per request, since
             the documented size and ratio support differs between them. -->
        <n-form-item label="默认模型">
          <n-select v-model:value="form.model_id" :options="modelOptions" placeholder="gemini-3-pro-image-preview" />
        </n-form-item>
        <n-form-item label="超时 (秒)">
          <n-input-number v-model:value="form.timeout" :min="60" :max="600" style="width:100%" placeholder="480" />
        </n-form-item>
      </n-form>

      <!-- Both surfaces usually sit behind the same gateway as the gpt-image
           config, so retyping the URL and key is the common case. -->
      <n-button
        quaternary size="small" block
        :disabled="!imageGen.config.baseurl && !imageGen.config.api_key"
        title="复制 GPT Image 配置里的 Base URL 与 API Key"
        @click="importFromImageGen"
      >
        ⇄ 从 GPT Image 配置导入连接信息
      </n-button>

      <template #footer>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <n-button type="primary" :loading="saving" @click="handleSave">保存配置</n-button>
        </div>
      </template>
    </n-drawer-content>
  </n-drawer>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import { useMessage, NDrawer, NDrawerContent, NForm, NFormItem, NInput,
         NInputNumber, NSelect, NButton } from 'naive-ui'
import { useBananaGenStore } from '@/stores/bananaGen'
import { useImageGenStore } from '@/stores/imageGen'
import { NATIVE_MODELS, OPENAI_MODELS } from '@/utils/bananaSpec'
import type { BananaConfig } from '@/types'

const visible = defineModel<boolean>('show', { required: true })
const message = useMessage()
const store = useBananaGenStore()
const imageGen = useImageGenStore()
const saving = ref(false)
const form = ref<BananaConfig>({ ...store.config })

// Every documented model, both surfaces, since this is the fallback used when a
// request leaves the model unset.
const modelOptions = [...NATIVE_MODELS, ...OPENAI_MODELS].map(m => ({
  label: `${m.id} — ${m.note}`,
  value: m.id,
}))

watch(visible, (v) => { if (v) form.value = { ...store.config } })

// The other module's config is loaded lazily by its own view, which may never
// have been visited, so the import button needs it fetched here too.
onMounted(() => imageGen.loadConfig())

function importFromImageGen() {
  form.value.baseurl = imageGen.config.baseurl
  form.value.api_key = imageGen.config.api_key
  message.info('已填入，仍需点击「保存配置」')
}

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
