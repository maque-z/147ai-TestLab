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
          <n-select v-model:value="form.model_id" :options="modelOptions" placeholder="gemini-3.1-flash-image" />
        </n-form-item>
        <n-form-item label="自定义模型">
          <div class="custom-models">
            <div class="custom-add">
              <n-input
                v-model:value="customModelInput"
                placeholder="输入模型名称，例如 gemini-xxx-image"
                @keyup.enter="addCustomModel"
              />
              <n-button type="primary" :disabled="!customModelInput.trim()" @click="addCustomModel">
                添加
              </n-button>
            </div>
            <div v-if="form.custom_models.length" class="custom-model-list">
              <span v-for="model in form.custom_models" :key="model" class="model-tag">
                {{ model }}
                <button :title="`移除 ${model}`" @click="removeCustomModel(model)">×</button>
              </span>
            </div>
          </div>
        </n-form-item>
        <p class="field-help">
          自定义模型会出现在原生 Gemini 的模型选择中；名称将原样放入请求路径，适合测试网关别名或官方列表之外的新模型。
        </p>
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
import { ref, watch, onMounted, computed } from 'vue'
import { useMessage, NDrawer, NDrawerContent, NForm, NFormItem, NInput,
         NInputNumber, NSelect, NButton } from 'naive-ui'
import { useBananaGenStore } from '@/stores/bananaGen'
import { useImageGenStore } from '@/stores/imageGen'
import { NATIVE_MODELS } from '@/utils/bananaSpec'
import type { BananaConfig } from '@/types'

const visible = defineModel<boolean>('show', { required: true })
const message = useMessage()
const store = useBananaGenStore()
const imageGen = useImageGenStore()
const saving = ref(false)
const form = ref<BananaConfig>({ ...store.config })
const customModelInput = ref('')

// Every documented model, both surfaces, since this is the fallback used when a
// request leaves the model unset.
const modelOptions = computed(() => {
  const clean = (value: unknown) => typeof value === 'string' ? value.trim() : ''
  const documented = NATIVE_MODELS
  // Keep a saved default visible even when it predates custom_models. This
  // prevents Naive UI from rendering a value with no matching option.
  const customIds = [form.value.model_id, ...(form.value.custom_models || [])]
    .map(clean)
    .filter(Boolean)
  const custom = customIds.map(id => ({
    id,
    note: id === clean(form.value.model_id) ? '当前默认 · 手动添加' : '手动添加 · 文档未列出',
  }))
  const seen = new Set<string>()
  return [...documented, ...custom].filter(m => {
    const id = clean(m.id)
    if (!id || seen.has(id)) return false
    seen.add(id)
    return true
  }).map(m => ({ label: `${clean(m.id)} — ${m.note}`, value: clean(m.id) }))
})

watch(visible, (v) => {
  if (!v) return
  form.value = {
    ...store.config,
    custom_models: [...(store.config.custom_models || [])]
      .map(item => item.trim())
      .filter(Boolean),
  }
  customModelInput.value = ''
})

// The other module's config is loaded lazily by its own view, which may never
// have been visited, so the import button needs it fetched here too.
onMounted(() => imageGen.loadConfig())

function importFromImageGen() {
  form.value.baseurl = imageGen.config.baseurl
  form.value.api_key = imageGen.config.api_key
  message.info('已填入，仍需点击「保存配置」')
}

function addCustomModel() {
  const model = customModelInput.value.trim()
  if (!model) return
  if (/[/\\?#]|\.\.|\s/.test(model)) {
    message.error('模型名称不能包含空格或路径字符')
    return
  }
  if (!form.value.custom_models.includes(model)) {
    form.value.custom_models.push(model)
  }
  customModelInput.value = ''
}

function removeCustomModel(model: string) {
  form.value.custom_models = form.value.custom_models.filter(item => item !== model)
  // Do not leave a removed alias as the default. The visible select and the
  // model page then continue to describe the same saved configuration.
  if (form.value.model_id === model) {
    form.value.model_id = NATIVE_MODELS[0].id
  }
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

<style scoped>
.field-help { margin: -8px 0 12px 100px; color: var(--text-secondary); font-size: 11px; line-height: 1.6; }
.custom-models { width: 100%; display: flex; flex-direction: column; gap: 8px; }
.custom-add { display: flex; gap: 8px; }
.custom-add :deep(.n-input) { flex: 1; min-width: 0; }
.custom-model-list { display: flex; flex-wrap: wrap; gap: 6px; }
.model-tag { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; padding: 4px 7px; border-radius: 5px; background: var(--bg); box-shadow: inset 1px 1px 3px var(--shadow-dark), inset -1px -1px 3px var(--shadow-light); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; overflow-wrap: anywhere; }
.model-tag button { width: 16px; height: 16px; padding: 0; border: 0; border-radius: 50%; background: transparent; color: var(--text-secondary); cursor: pointer; font-size: 15px; line-height: 1; }
.model-tag button:hover { color: var(--danger); }
</style>
