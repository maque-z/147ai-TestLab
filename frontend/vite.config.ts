import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import { execSync } from 'node:child_process'

// Stamped into the bundle so the running page can state which commit built it.
// Exists because a stale deployment and a missing feature look identical from
// the browser; the stamp in the test panel header settles it in one glance.
let commit = 'dev'
try {
  commit = execSync('git rev-parse --short HEAD').toString().trim()
} catch {
  /* building outside a git checkout — keep 'dev' */
}
const buildInfo = `${commit} ${new Date().toISOString().slice(0, 16).replace('T', ' ')}Z`

export default defineConfig({
  plugins: [vue()],
  define: {
    __BUILD_INFO__: JSON.stringify(buildInfo),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true
      }
    }
  }
})
