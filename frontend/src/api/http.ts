import axios from 'axios'
import { useAuthStore } from '@/stores/auth'

/** The one axios instance every api/ module shares.
 *
 *  Extracted so the auth header and the 401 handling below exist once. Two copies
 *  of a logout path is exactly the kind of thing that drifts, and a module that
 *  forgot the interceptor would leave a dead token in place instead of clearing it.
 */
export const http = axios.create({ baseURL: import.meta.env.VITE_API_BASE ?? '/api/v1' })

http.interceptors.request.use(cfg => {
  const auth = useAuthStore()
  if (auth.token) cfg.headers.Authorization = `Bearer ${auth.token}`
  return cfg
})

/** An error shaped exactly like the axios error a real 4xx/5xx used to produce.
 *
 *  Every existing handler reads `e.response.data.detail` and `e.response.status`
 *  (utils/batch.ts, stores/apiTest.ts, the config drawers). The streamed
 *  endpoints no longer *have* a meaningful HTTP status — see below — so their
 *  failures are rebuilt into this shape rather than making every call site learn
 *  a second error format.
 */
function streamedError(status: number, detail: string, upstream?: unknown) {
  const err = new Error(detail) as Error & {
    response: { status: number; data: { detail: string } }
    isStreamedError: true
    upstream?: unknown
  }
  err.response = { status, data: { detail } }
  err.isStreamedError = true
  // Raw upstream exchange, when the backend captured one for this failure.
  // Optional and unread by most call sites; the test panel shows it.
  if (upstream !== undefined) err.upstream = upstream
  return err
}

/** POST to an endpoint that answers with a heartbeat stream.
 *
 *  The problem being solved is on the network, not in the API: a generation takes
 *  60-120s, and a plain JSON response sends nothing at all for that whole time.
 *  Anything on the path that reaps idle connections — a TUN proxy, a carrier NAT,
 *  a load balancer — cannot tell such a connection from a dead one and closes it.
 *  Observed as nginx logging 499 (client gone, 0 bytes sent) on every generate
 *  request at the 60s mark, with the backend healthy and still waiting upstream.
 *
 *  So the backend now frames the body as newline-delimited JSON: a bare newline
 *  every 10s while it waits, then one final line carrying the result. Those
 *  newlines are never read here, and they do not need to be — their entire job is
 *  to be bytes on the wire so no device on the path sees an idle socket. XHR
 *  buffers them like any other body, and only the last line is parsed.
 *
 *  The unavoidable cost: an HTTP status is committed when the first byte leaves,
 *  which now happens long before the upstream answers. So an upstream failure
 *  arrives inside a 200 and is re-thrown here via streamedError().
 *
 *  One consequence worth naming, because it is a fix rather than a regression: an
 *  upstream 401 used to surface as a genuine 401 from our own API, which tripped
 *  the interceptor below and logged the user out — someone else's expired API key
 *  ended their session. Streamed failures never reach that interceptor, so a
 *  401 from the image provider now stays on the card where it belongs.
 */
export async function postStreamed<T>(
  url: string,
  data: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const resp = await http.post<string>(url, data, {
    signal,
    // The body is NDJSON, not JSON. Left to its own devices axios would try to
    // JSON.parse the whole thing — heartbeats included — and hand back the raw
    // string when that fails, which is the same value by a more confusing route.
    responseType: 'text',
    transformResponse: [(raw: string) => raw],
  })

  // Walk back to the last non-empty line: everything before it is heartbeats.
  const lines = (resp.data ?? '').split('\n')
  let last = ''
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim()
    if (trimmed) { last = trimmed; break }
  }

  // Heartbeats but no terminal frame: the connection was cut mid-flight after
  // all. Distinct from an upstream error, and worth saying so plainly rather
  // than surfacing as a JSON parse failure.
  if (!last) {
    throw streamedError(502, '连接在结果返回前中断，请重试')
  }

  let envelope: {
    ok?: boolean; data?: T; status?: number; detail?: string; upstream?: unknown
  }
  try {
    envelope = JSON.parse(last)
  } catch {
    throw streamedError(502, '响应格式错误：无法解析结果')
  }

  if (!envelope.ok) {
    throw streamedError(envelope.status ?? 502, envelope.detail || '生成失败', envelope.upstream)
  }
  return envelope.data as T
}

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
