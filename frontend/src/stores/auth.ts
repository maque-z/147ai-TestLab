import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { User } from '@/types'
import * as authApi from '@/api/auth'

export const useAuthStore = defineStore('auth', () => {
  const token = ref<string | null>(null)
  const user = ref<User | null>(null)

  const isLoggedIn = computed(() => !!token.value)

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

  return { token, user, isLoggedIn, login, register, logout }
}, {
  persist: true
})
