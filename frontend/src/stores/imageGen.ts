import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ImageConfig, GeneratedImage } from '@/types'
import * as imageGenApi from '@/api/imageGen'

const DEFAULT_CONFIG: ImageConfig = {
  baseurl: 'https://api.openai.com/v1',
  api_key: '',
  model_id: 'gpt-image-alpha',
  timeout: 120,
  size: '1024x1024',
  quality: 'auto',
  n: 1,
  output_format: 'png',
  output_compression: 90,
  background: 'auto',
  moderation: 'auto',
}

export const useImageGenStore = defineStore('imageGen', () => {
  const config = ref<ImageConfig>({ ...DEFAULT_CONFIG })
  const results = ref<GeneratedImage[]>([])
  const generating = ref(false)
  const configLoaded = ref(false)

  async function loadConfig() {
    if (configLoaded.value) return
    try {
      config.value = await imageGenApi.getConfig()
      configLoaded.value = true
    } catch {
      // use defaults, will retry on next load
    }
  }

  async function updateConfig(cfg: ImageConfig) {
    config.value = await imageGenApi.saveConfig(cfg)
  }

  async function generate(prompt: string, overrides?: Partial<ImageConfig>) {
    generating.value = true
    try {
      const res = await imageGenApi.generate({ prompt, ...overrides })
      results.value = res.images
      return res
    } finally {
      generating.value = false
    }
  }

  function clearResults() {
    results.value = []
  }

  return { config, results, generating, configLoaded, loadConfig, updateConfig, generate, clearResults }
})
