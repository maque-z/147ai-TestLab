import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/LoginView.vue'),
      meta: { public: true }
    },
    {
      path: '/',
      component: () => import('@/components/layout/AppLayout.vue'),
      meta: { requiresAuth: true },
      children: [
        {
          path: '',
          redirect: '/image-gen'
        },
        {
          path: 'image-gen',
          name: 'image-gen',
          component: () => import('@/views/ImageGenView.vue')
        }
      ]
    },
    { path: '/:pathMatch(.*)*', redirect: '/' }
  ]
})

// Run once per page load, not on every navigation. The token is validated
// against the backend so a forged or expired localStorage value is evicted
// before the guard decides whether to redirect.
//
// Memoised as a promise rather than a boolean: a boolean flipped before the
// await would let a navigation started while verify() is still in flight skip
// the wait entirely and read a half-populated auth state. Every concurrent
// navigation awaits the same request instead.
let bootPromise: Promise<void> | null = null

router.beforeEach(async (to) => {
  const auth = useAuthStore()

  bootPromise ??= auth.verify()
  await bootPromise

  if (to.meta.requiresAuth && !auth.isLoggedIn) {
    return { name: 'login' }
  }
  // Deliberately no "already logged in → bounce to /" redirect here.
  // Landing on the login page is treated as intent to re-authenticate: the view
  // clears any lingering session on mount, so the form always reflects a real
  // credential check instead of silently reusing a persisted token.
})

export default router
