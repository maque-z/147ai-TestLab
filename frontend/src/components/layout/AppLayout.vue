<template>
  <div class="layout-root">
    <SideNav :collapsed="collapsed" @toggle="collapsed = !collapsed" />
    <div class="layout-main" :class="{ 'sidebar-collapsed': collapsed }">
      <header class="topbar nm-raised">
        <span class="topbar-title">{{ currentTitle }}</span>
        <div class="topbar-right">
          <span class="username text-muted">{{ auth.user?.username }}</span>
          <button class="nm-btn logout-btn" @click="handleLogout">退出</button>
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
import SideNav from './SideNav.vue'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()
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
.username      { font-size: 13px; }

.logout-btn {
  padding: 6px 14px;
  border: none;
  border-radius: 8px;
  background: var(--bg);
  color: var(--text-primary);
  cursor: pointer;
  font-size: 13px;
}

.content-area {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
}
</style>
