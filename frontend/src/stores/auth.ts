import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { User } from '@/types'
import * as authApi from '@/api/auth'

export const useAuthStore = defineStore('auth', () => {
  const token = ref<string | null>(null)
  const user = ref<User | null>(null)

  // Both token and user must be present. A token without user data means
  // verify() could not confirm it (network error during boot with no prior
  // user hydrated), which is not a valid session.
  const isLoggedIn = computed(() => !!token.value && !!user.value)

  async function login(username: string, password: string) {
    const res = await authApi.login({ username, password })
    token.value = res.access_token
    user.value = res.user
  }

  async function register(username: string, password: string) {
    const res = await authApi.register({ username, password })
    token.value = res.access_token
    user.value = res.user
  }

  function logout() {
    token.value = null
    user.value = null
  }

  /** Call on app boot. Validates the persisted token against the backend.
   *
   *  localStorage is readable by any script on the page (XSS risk), so a
   *  client-side isLoggedIn flag is cosmetic. The token must be accepted by the
   *  backend to mean anything. If /auth/me rejects it (401, expired, forged),
   *  clear state immediately so the user sees the login page rather than a
   *  shell that refuses every API call.
   */
  async function verify(): Promise<void> {
    if (!token.value) return
    // Remember whether there was already a hydrated user from persistence.
    // If verify fails due to a network error and there was no prior user,
    // the token is an orphan (e.g. localStorage token without matching user)
    // and should be evicted rather than kept as a false isLoggedIn signal.
    const hadUser = !!user.value
    try {
      const me = await authApi.me(token.value)
      user.value = me
    } catch (e: any) {
      const status = e?.response?.status
      if (status === 401 || status === 403) {
        // Token rejected by server — clear everything.
        token.value = null
        user.value = null
      } else if (!hadUser) {
        // Network error (server down / offline) but no prior user data.
        // We cannot validate this token, and there's no session to preserve.
        token.value = null
      }
      // Network error with a previously loaded user: keep the session alive
      // so a backend restart doesn't log the user out mid-session.
    }
  }

  return { token, user, isLoggedIn, login, register, logout, verify }
}, {
  persist: true
})
