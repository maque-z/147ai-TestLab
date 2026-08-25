import type {
  BananaConfig, BananaGenerateRequest, BananaChatRequest, BananaGenerateResponse,
} from '@/types'
import { http, postStreamed } from './http'

export function getConfig(): Promise<BananaConfig> {
  return http.get<BananaConfig>('/banana-gen/config').then(r => r.data)
}

export function saveConfig(cfg: BananaConfig): Promise<BananaConfig> {
  return http.put<BananaConfig>('/banana-gen/config', cfg).then(r => r.data)
}

/** Gemini native. `signal` lets the caller abort a request already in flight, so
 *  stopping a batch drops open connections instead of waiting them out.
 *
 *  Heartbeat-streamed, same as the gpt-image endpoints — see api/http.ts. The
 *  resolved value and the thrown error shape are unchanged.
 */
export function generate(
  req: BananaGenerateRequest,
  signal?: AbortSignal,
): Promise<BananaGenerateResponse> {
  return postStreamed<BananaGenerateResponse>('/banana-gen/generate', req, signal)
}

/** OpenAI-compatible chat/completions. Same response shape comes back either
 *  way — the backend normalises both surfaces onto one card. */
export function chat(
  req: BananaChatRequest,
  signal?: AbortSignal,
): Promise<BananaGenerateResponse> {
  return postStreamed<BananaGenerateResponse>('/banana-gen/chat', req, signal)
}
