import type { ImageConfig, GenerateRequest, GenerateResponse } from '@/types'
import { http, postStreamed } from './http'

export function getConfig(): Promise<ImageConfig> {
  return http.get<ImageConfig>('/image-gen/config').then(r => r.data)
}

export function saveConfig(cfg: ImageConfig): Promise<ImageConfig> {
  return http.put<ImageConfig>('/image-gen/config', cfg).then(r => r.data)
}

/** `signal` lets the caller abort a request that is already in flight, so
 *  stopping a batch drops open connections instead of waiting them out.
 *
 *  Goes through postStreamed because this endpoint answers with a heartbeat
 *  stream — see api/http.ts for why. Resolves to the same GenerateResponse it
 *  always did, and throws the same error shape, so callers are unaffected.
 */
export function generate(req: GenerateRequest, signal?: AbortSignal): Promise<GenerateResponse> {
  return postStreamed<GenerateResponse>('/image-gen/generate', req, signal)
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
  if (req.background) fd.append('background', req.background)
  if (req.input_fidelity) fd.append('input_fidelity', req.input_fidelity)

  images.forEach(f => fd.append('images', f, f.name))
  if (mask) fd.append('mask', mask, 'mask.png')

  // Heartbeat-streamed like /generate. The upload itself is unchanged — only the
  // response framing differs, and postStreamed passes FormData through untouched
  // so the browser still sets its own multipart boundary.
  return postStreamed<GenerateResponse>('/image-gen/edit', fd, signal)
}
