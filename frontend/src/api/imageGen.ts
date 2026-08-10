import axios from 'axios'
import type { ImageConfig, GenerateRequest, GenerateResponse } from '@/types'
import { useAuthStore } from '@/stores/auth'

const http = axios.create({ baseURL: import.meta.env.VITE_API_BASE ?? '/api/v1' })

http.interceptors.request.use(cfg => {
  const auth = useAuthStore()
  if (auth.token) cfg.headers.Authorization = `Bearer ${auth.token}`
  return cfg
})

/** A 401 here means the token expired or was revoked while the user was working.
 *
 *  Only the store is touched — no redirect from this layer. The router guard
 *  already sends a logged-out user to /login, and clearing state is what makes
 *  isLoggedIn false. Navigating from inside an axios interceptor would also
 *  fight the boot-time verify() in the auth store, which handles the same
 *  condition on first load.
 */
http.interceptors.response.use(
  r => r,
  err => {
    if (err?.response?.status === 401) {
      useAuthStore().logout()
    }
    return Promise.reject(err)
  },
)

export function getConfig(): Promise<ImageConfig> {
  return http.get<ImageConfig>('/image-gen/config').then(r => r.data)
}

export function saveConfig(cfg: ImageConfig): Promise<ImageConfig> {
  return http.put<ImageConfig>('/image-gen/config', cfg).then(r => r.data)
}

/** `signal` lets the caller abort a request that is already in flight, so
 *  stopping a batch drops open connections instead of waiting them out. */
export function generate(req: GenerateRequest, signal?: AbortSignal): Promise<GenerateResponse> {
  return http.post<GenerateResponse>('/image-gen/generate', req, { signal }).then(r => r.data)
}

/** The edits endpoint takes binary uploads, so this one goes out as multipart
 *  rather than JSON. The first file is the canvas being edited and the rest are
 *  reference images, so their order is meaningful and preserved here.
 *
 *  Content-Type is deliberately not set: the browser has to add the multipart
 *  boundary itself, and naming the header would strip it.
 */
export function edit(
  req: GenerateRequest,
  images: File[],
  mask: Blob | null,
  signal?: AbortSignal,
): Promise<GenerateResponse> {
  const fd = new FormData()
  fd.append('prompt', req.prompt)
  // Unset params are simply absent, matching the JSON path's "let the API decide".
  if (req.size) fd.append('size', req.size)
  if (req.quality) fd.append('quality', req.quality)
  if (req.n != null) fd.append('n', String(req.n))
  if (req.output_format) fd.append('output_format', req.output_format)
  if (req.output_compression != null) fd.append('output_compression', String(req.output_compression))
  if (req.moderation) fd.append('moderation', req.moderation)

  images.forEach(f => fd.append('images', f, f.name))
  if (mask) fd.append('mask', mask, 'mask.png')

  return http.post<GenerateResponse>('/image-gen/edit', fd, { signal }).then(r => r.data)
}
