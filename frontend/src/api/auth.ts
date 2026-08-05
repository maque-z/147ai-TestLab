import axios from 'axios'
import type { TokenResponse, LoginRequest } from '@/types'

const http = axios.create({ baseURL: import.meta.env.VITE_API_BASE ?? '/api/v1' })

export function login(data: LoginRequest): Promise<TokenResponse> {
  return http.post<TokenResponse>('/auth/login', data).then(r => r.data)
}

export function register(data: LoginRequest): Promise<TokenResponse> {
  return http.post<TokenResponse>('/auth/register', data).then(r => r.data)
}
