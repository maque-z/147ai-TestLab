<template>
  <div class="layout-root">
    <SideNav
      :collapsed="collapsed"
      :username="auth.user?.username"
      @toggle="collapsed = !collapsed"
      @logout="handleLogout"
    />
    <div class="layout-main" :class="{ 'sidebar-collapsed': collapsed }">
      <header class="topbar nm-raised">
        <span class="topbar-title">{{ currentTitle }}</span>
        <div class="topbar-right">
          <!-- Route-scoped: the drawer it opens only exists on the image-gen view -->
          <button
            v-if="route.name === 'image-gen'"
            class="nm-btn config-btn"
            @click="imageGen.configOpen = true"
          >
            <span class="config-icon">⚙️</span> 配置
          </button>
        </div>
      </header>
      <main class="content-area">
        <router-view />
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useImageGenStore } from '@/stores/imageGen'
import SideNav from './SideNav.vue'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()
const imageGen = useImageGenStore()
const collapsed = ref(false)

const titleMap: Record<string, string> = {
  'image-gen': 'GPT Image 生成'
}

const currentTitle = computed(() => titleMap[route.name as string] ?? '147ai TestLab')

function handleLogout() {
  auth.logout()
  router.push('/login')
}
</script>

<style scoped>
.layout-root { display: flex; height: 100vh; overflow: hidden; }

.layout-main {
  flex: 1;
  margin-left: var(--sidebar-w);
  display: flex;
  flex-direction: column;
  transition: margin-left 0.25s ease;
  overflow: hidden;
}
.layout-main.sidebar-collapsed { margin-left: 64px; }

.topbar {
  height: 56px;
  background: var(--bg);
  border-radius: 0;
  padding: 0 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  z-index: 10;
}

.topbar-title { font-weight: 600; font-size: 15px; }
.topbar-right  { display: flex; align-items: center; gap: 12px; }

.config-btn {
  display: inline-flex; align-items: center; gap: 7px;
  height: 34px;
  padding: 0 16px;
  border: none;
  border-radius: 9px;
  background: var(--bg);
  color: var(--text-primary);
  cursor: pointer;
  font-size: 13px;
  transition: color 0.15s, box-shadow 0.15s;
}
.config-btn:hover { color: var(--accent); }
.config-btn:active {
  box-shadow: inset 2px 2px 4px var(--shadow-dark), inset -2px -2px 4px var(--shadow-light);
}
.config-icon { font-size: 14px; }

.content-area {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
}
</style>
