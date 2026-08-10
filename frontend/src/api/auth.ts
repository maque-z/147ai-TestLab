import axios from 'axios'
import type { TokenResponse, LoginRequest, User } from '@/types'

const http = axios.create({ baseURL: import.meta.env.VITE_API_BASE ?? '/api/v1' })

// No interceptors here on purpose.
//
// login/register are the two calls that must work without a token, and me() is
// only ever called by the auth store, which already holds the token and passes
// it explicitly. Reaching into localStorage from this layer would hardcode both
// the persistence key and pinia-plugin-persistedstate's serialised shape.
//
// A 401 arriving mid-session is handled where the token is actually used — see
// the response interceptor in api/imageGen.ts.

export function login(data: LoginRequest): Promise<TokenResponse> {
  return http.post<TokenResponse>('/auth/login', data).then(r => r.data)
}

export function register(data: LoginRequest): Promise<TokenResponse> {
  return http.post<TokenResponse>('/auth/register', data).then(r => r.data)
}

/** Validate a token against the backend. The caller supplies it rather than this
 *  module reading it back out of storage — that keeps the dependency one-way. */
export function me(token: string): Promise<User> {
  return http
    .get<User>('/auth/me', { headers: { Authorization: `Bearer ${token}` } })
    .then(r => r.data)
}
