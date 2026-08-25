<template>
  <div class="layout-root">
    <SideNav
      :collapsed="collapsed"
      :username="auth.user?.username"
      :is-admin="auth.user?.is_admin === true"
      @toggle="collapsed = !collapsed"
      @logout="handleLogout"
    />
    <!-- Backdrop: visible on mobile only when sidebar is open; tap to close -->
    <div class="sidebar-backdrop" :class="{ active: !collapsed }" @click="collapsed = true" />
    <div class="layout-main" :class="{ 'sidebar-collapsed': collapsed }">
      <header class="topbar nm-raised">
        <div class="topbar-left">
          <!-- Hamburger: only visible on mobile via CSS; opens the sidebar overlay -->
          <button class="hamburger btn" @click="collapsed = false" aria-label="打开菜单">☰</button>
          <span class="topbar-title">{{ currentTitle }}</span>
        </div>
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
            @click="confirmRun"
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

        <!-- Route-scoped, same arrangement as the image-gen controls above: the
             two modules keep separate configs and separate batches, so neither
             button may act on the other's state. -->
        <div v-else-if="route.name === 'banana-gen'" class="topbar-right">
          <button class="btn" @click="bananaGen.configOpen = true">
            <span class="btn-icon">⚙️</span> 配置
          </button>

          <!-- Never turns into a stop button. Stopping is per-card, on the card,
               so the two actions cannot be confused for one another. While a
               batch runs this shows its progress instead. -->
          <button
            v-if="bananaGen.view === 'batch'"
            class="btn btn-lg btn-primary"
            :disabled="!bananaGen.canRun"
            :title="bananaGen.blockReason || '点击开始生成，可与进行中的批次并发'"
            @click="confirmBananaRun"
          >
            <template v-if="bananaGen.generating">
              <n-spin :size="13" stroke="#fff" />
              <span class="run-count">{{ bananaGen.doneCount }} / {{ bananaGen.totalCount }}</span>
            </template>
            <template v-else>
              <span class="btn-icon">✨</span>
              生成
              <span class="run-count">{{ bananaGen.totalImages }}</span> 张
            </template>
          </button>
        </div>
      </header>

      <!--
        Cost gate. A batch is billed per upstream request, and 全选 尺寸 is a
        single click away from 270 of them — so anything past a handful gets
        confirmed before it goes out. Requests already sent cannot be un-billed,
        which is why this sits in front of run() rather than relying on 停止.
      -->
      <n-modal
        v-model:show="confirmOpen"
        preset="dialog"
        type="warning"
        title="确认发送这批请求"
        positive-text="确认发送"
        negative-text="取消"
        @positive-click="runConfirmed"
      >
        <div class="confirm-body">
          <div class="confirm-row">
            <span>上游请求</span>
            <b>{{ confirmTarget.totalRequests }} 个</b>
          </div>
          <div class="confirm-row">
            <span>出图</span>
            <b>{{ confirmTarget.totalImages }} 张</b>
          </div>
          <p class="confirm-note">
            计费按上游请求数算。已经发出的请求点「停止」也退不回来，停止只拦得住还在排队的部分。
          </p>
        </div>
      </n-modal>

      <main class="content-area">
        <router-view />
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { NSpin, NModal } from 'naive-ui'
import { useAuthStore } from '@/stores/auth'
import { useImageGenStore } from '@/stores/imageGen'
import { useApiTestStore } from '@/stores/apiTest'
import { useBananaGenStore } from '@/stores/bananaGen'
import { useBananaTestStore } from '@/stores/bananaTest'
import SideNav from './SideNav.vue'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()
const imageGen = useImageGenStore()
const apiTest = useApiTestStore()
const bananaGen = useBananaGenStore()
const bananaTest = useBananaTestStore()
// On mobile the sidebar starts hidden; on desktop it starts expanded.
const collapsed = ref(typeof window !== 'undefined' && window.innerWidth <= 640)

const titleMap: Record<string, string> = {
  'image-gen': 'GPT Image 生成',
  'banana-gen': 'Gemini 图片生成',
  'admin-users': '账号管理'
}

const currentTitle = computed(() => titleMap[route.name as string] ?? '147ai TestLab')

/** Batches at or above this many images ask first. Below it the run is small
 *  enough that a confirmation would just be a click to dismiss. */
const CONFIRM_AT = 10

const confirmOpen = ref(false)

/** Which module the open dialog is about. Both surfaces bill per upstream
 *  request, so both go through this gate — and the dialog has to show the counts
 *  for the one that was actually clicked. */
const confirmMode = ref<'image' | 'banana'>('image')
const confirmTarget = computed(() =>
  confirmMode.value === 'banana' ? bananaGen : imageGen
)

/** Gate run() behind a confirmation once the batch is large enough to be worth
 *  money. Counted in images to match the number printed on the button — that is
 *  what the user just looked at when they decided to click. */
function confirmRun() {
  confirmMode.value = 'image'
  if (imageGen.totalImages >= CONFIRM_AT) confirmOpen.value = true
  else imageGen.run()
}

/** Same gate for the Gemini surface: a full model × ratio × size matrix is a few
 *  clicks away from hundreds of billed requests. */
function confirmBananaRun() {
  confirmMode.value = 'banana'
  if (bananaGen.totalImages >= CONFIRM_AT) confirmOpen.value = true
  else bananaGen.run()
}

/** Deliberately does not return run()'s promise. Naive UI keeps a dialog open
 *  with the confirm button spinning until a returned promise settles — and that
 *  promise only settles when the entire batch is done, so returning it would
 *  block the UI behind the modal for the whole run. Do not shorten this to
 *  `@positive-click="imageGen.run"`. */
function runConfirmed() {
  if (confirmMode.value === 'banana') bananaGen.run()
  else imageGen.run()
}

function handleLogout() {
  // Abort in-flight work before dropping the token. Otherwise every queued
  // request fires against a cleared session, comes back 401, and re-enters the
  // 401 interceptor — one pointless round trip per remaining card.
  //
  // Done here rather than inside auth.logout(): the auth store cannot import
  // these two, because api/imageGen.ts already imports the auth store for its
  // interceptors, and closing that loop makes module init order load-bearing.
  imageGen.stop()
  apiTest.stop()
  bananaGen.stop()
  bananaTest.stop()
  auth.logout()
  router.push('/login')
}
</script>

<style scoped>
.layout-root { display: flex; height: 100vh; overflow: hidden; }

/* Backdrop: hidden on desktop; on mobile it covers the page behind the open sidebar */
.sidebar-backdrop {
  display: none;
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: 99;
}

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

.topbar-left  { display: flex; align-items: center; gap: 10px; }
.topbar-title { font-weight: 600; font-size: 15px; }
.topbar-right { display: flex; align-items: center; gap: 12px; }

/* Hidden on desktop; shown on mobile as a sidebar trigger */
.hamburger { display: none; width: 36px; height: 36px; padding: 0; font-size: 18px; }

.btn-icon { font-size: 14px; }
/* Tabular so the progress counter does not jitter as the digits change */
.run-count { font-variant-numeric: tabular-nums; }

/* Counts are the point of the dialog, so they get the mono treatment the rest
   of the parameter tables use. */
.confirm-body { display: flex; flex-direction: column; gap: 6px; }
.confirm-row {
  display: flex; justify-content: space-between; align-items: baseline;
  font-size: 13px; color: var(--text-muted);
}
.confirm-row b {
  font-variant-numeric: tabular-nums;
  font-size: 16px; color: var(--text-primary); font-weight: 600;
}
.confirm-note {
  margin: 6px 0 0; font-size: 12px; line-height: 1.6; color: var(--text-primary);
}

.content-area {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
}

/* ===== Mobile (≤ 640px) ===== */
@media (max-width: 640px) {
  /* Sidebar is an overlay on mobile — main content fills the full width */
  .layout-main        { margin-left: 0 !important; }
  .topbar             { padding: 0 14px; height: 50px; }
  .topbar-title       { font-size: 13px; }
  .content-area       { padding: 12px; }
  .hamburger          { display: flex; }
  .sidebar-backdrop.active { display: block; }
}
</style>
