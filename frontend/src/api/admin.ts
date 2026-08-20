import { http } from './http'
import type { User } from '@/types'

// Uses the shared instance from api/http.ts, not a bare axios client: that one
// carries the Authorization header and the 401 interceptor. An admin whose own
// account is disabled mid-session must be logged out by this page too, and the
// interceptor is what does it.

export function listUsers(): Promise<User[]> {
  return http.get<User[]>('/admin/users').then(r => r.data)
}

export function setActive(id: number, is_active: boolean): Promise<User> {
  return http.patch<User>(`/admin/users/${id}`, { is_active }).then(r => r.data)
}

export function resetPassword(id: number, password: string): Promise<User> {
  return http.post<User>(`/admin/users/${id}/password`, { password }).then(r => r.data)
}

export function deleteUser(id: number): Promise<void> {
  return http.delete(`/admin/users/${id}`).then(() => undefined)
}
