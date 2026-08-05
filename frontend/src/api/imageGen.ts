import axios from 'axios'
import type { ImageConfig, GenerateRequest, GenerateResponse } from '@/types'
import { useAuthStore } from '@/stores/auth'

const http = axios.create({ baseURL: import.meta.env.VITE_API_BASE ?? '/api/v1' })

http.interceptors.request.use(cfg => {
  const auth = useAuthStore()
  if (auth.token) cfg.headers.Authorization = `Bearer ${auth.token}`
  return cfg
})

export function getConfig(): Promise<ImageConfig> {
  return http.get<ImageConfig>('/image-gen/config').then(r => r.data)
}

export function saveConfig(cfg: ImageConfig): Promise<ImageConfig> {
  return http.put<ImageConfig>('/image-gen/config', cfg).then(r => r.data)
}

export function generate(req: GenerateRequest): Promise<GenerateResponse> {
  return http.post<GenerateResponse>('/image-gen/generate', req).then(r => r.data)
}
