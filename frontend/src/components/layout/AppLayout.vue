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
        <!-- Route-scoped: both controls act on the image-gen view only -->
        <div v-if="route.name === 'image-gen'" class="topbar-right">
          <button class="btn" @click="imageGen.configOpen = true">
            <span class="btn-icon">⚙️</span> 配置
          </button>

          <!--
            Never turns into a stop button. Stopping is per-card, on the card, so
            the two actions cannot be confused for one another — and so stopping
            one combination does not read as stopping the batch.
            While a batch runs this shows its progress instead.

            Hidden on the test pane: that suite has its own run button, and this
            one would fire a matrix batch the user is not looking at.
          -->
          <button
            v-if="imageGen.view === 'batch'"
            class="btn btn-lg btn-primary"
            :disabled="!imageGen.canRun"
            :title="imageGen.blockReason || '点击开始生成，可与进行中的批次并发'"
            @click="imageGen.run()"
          >
            <template v-if="imageGen.generating">
              <n-spin :size="13" stroke="#fff" />
              <span class="run-count">{{ imageGen.doneCount }} / {{ imageGen.totalCount }}</span>
            </template>
            <template v-else>
              <span class="btn-icon">✨</span>
              {{ imageGen.mode === 'edit' ? '编辑' : '生成' }}
              <span class="run-count">{{ imageGen.totalImages }}</span> 张
            </template>
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
import { NSpin } from 'naive-ui'
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

.btn-icon { font-size: 14px; }
/* Tabular so the progress counter does not jitter as the digits change */
.run-count { font-variant-numeric: tabular-nums; }

.content-area {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
}
</style>
