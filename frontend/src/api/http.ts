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
