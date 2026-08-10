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
let bootVerified = false

router.beforeEach(async (to) => {
  const auth = useAuthStore()

  if (!bootVerified) {
    bootVerified = true
    await auth.verify()
  }

  if (to.meta.requiresAuth && !auth.isLoggedIn) {
    return { name: 'login' }
  }
  // Deliberately no "already logged in → bounce to /" redirect here.
  // Landing on the login page is treated as intent to re-authenticate: the view
  // clears any lingering session on mount, so the form always reflects a real
  // credential check instead of silently reusing a persisted token.
})

export default router
