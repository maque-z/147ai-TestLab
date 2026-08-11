<template>
  <aside class="sidebar nm-raised" :class="{ collapsed }">
    <div class="sidebar-header">
      <span v-if="!collapsed" class="brand">147ai</span>
      <button class="toggle-btn nm-btn" @click="onToggle">
        {{ collapsed ? '›' : '‹' }}
      </button>
    </div>

    <nav ref="navEl" class="nav-list">
      <router-link
        v-for="item in navItems"
        :key="item.to"
        :to="item.to"
        class="nav-item"
        :class="{ active: $route.path.startsWith(item.to) }"
      >
        <span class="nav-icon">{{ item.icon }}</span>
        <span v-if="!collapsed" class="nav-label">{{ item.label }}</span>
      </router-link>
    </nav>

    <!-- Account lives at the foot of the rail: present, but out of the way of
         the工作区 up top. -->
    <div ref="footerEl" class="sidebar-footer">
      <div class="account" :class="{ mini: collapsed }" :title="username">
        <span class="avatar">{{ initial }}</span>
        <span v-if="!collapsed" class="account-name">{{ username }}</span>
      </div>
      <button
        class="logout-btn"
        :class="{ mini: collapsed }"
        :title="collapsed ? '退出登录' : undefined"
        @click="$emit('logout')"
      >
        <span class="logout-icon">⏻</span>
        <span v-if="!collapsed">退出</span>
      </button>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { fadeInUp, pulse } from '@/utils/motion'

const props = defineProps<{ collapsed: boolean; username?: string }>()
const emit = defineEmits<{ toggle: []; logout: [] }>()

const username = computed(() => props.username || '未登录')
const initial = computed(() => username.value.charAt(0).toUpperCase())

const navEl = ref<HTMLElement | null>(null)
const footerEl = ref<HTMLElement | null>(null)

const navItems = [
  { to: '/image-gen', icon: '🖼️', label: 'GPT Image 生成' },
  { to: '/banana-gen', icon: '🍌', label: 'Gemini 图片生成' }
]

function onToggle(e: MouseEvent) {
  pulse(e.currentTarget as HTMLElement)
  emit('toggle')
}

onMounted(() => {
  if (navEl.value) {
    fadeInUp(Array.from(navEl.value.querySelectorAll<HTMLElement>('.nav-item')), { distance: 8 })
  }
  if (footerEl.value) fadeInUp(footerEl.value, { delay: 120, distance: 8 })
})
</script>

<style scoped>
.sidebar {
  position: fixed;
  left: 0; top: 0; bottom: 0;
  width: var(--sidebar-w);
  background: var(--bg);
  border-radius: 0;
  display: flex;
  flex-direction: column;
  padding: 16px 12px;
  transition: width 0.25s ease;
  z-index: 100;
  overflow: hidden;
}
.sidebar.collapsed { width: 64px; }

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 24px;
  padding: 0 4px;
}

.brand { font-size: 18px; font-weight: 700; color: var(--accent); }

.toggle-btn {
  width: 32px; height: 32px;
  border: none;
  border-radius: 8px;
  background: var(--bg);
  cursor: pointer;
  font-size: 18px;
  color: var(--text-muted);
  display: flex; align-items: center; justify-content: center;
}

.nav-list { display: flex; flex-direction: column; gap: 6px; }

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 12px;
  text-decoration: none;
  color: var(--text-primary);
  font-size: 14px;
  transition: all 0.15s ease;
  white-space: nowrap;
}
.nav-item:hover  { background: rgba(108,155,209,.12); color: var(--accent); }
.nav-item.active { box-shadow: inset 3px 3px 6px var(--shadow-dark), inset -3px -3px 6px var(--shadow-light); color: var(--accent); font-weight: 600; }

.nav-icon  { font-size: 18px; flex-shrink: 0; }
.nav-label { overflow: hidden; text-overflow: ellipsis; }

/* ===== Account footer ===== */
/* margin-top:auto pins this to the bottom regardless of how many nav items
   there are, so adding pages later does not push it around. */
.sidebar-footer {
  margin-top: auto;
  padding-top: 12px;
  border-top: 1px solid var(--shadow-dark);
  display: flex; flex-direction: column; gap: 8px;
}

.account {
  display: flex; align-items: center; gap: 9px;
  padding: 6px 4px;
  min-width: 0;
}
.account.mini { justify-content: center; padding: 6px 0; }

.avatar {
  width: 28px; height: 28px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  font-size: 12px; font-weight: 700;
  display: flex; align-items: center; justify-content: center;
}
.account-name {
  font-size: 13px;
  color: var(--text-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.logout-btn {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px;
  border: none;
  border-radius: 10px;
  background: var(--bg);
  color: var(--text-muted);
  font-size: 13px;
  cursor: pointer;
  box-shadow: 3px 3px 6px var(--shadow-dark), -3px -3px 6px var(--shadow-light);
  transition: color 0.15s, box-shadow 0.15s;
}
.logout-btn.mini { justify-content: center; padding: 8px 0; }
.logout-btn:hover { color: #c0564a; }
.logout-btn:active {
  box-shadow: inset 2px 2px 4px var(--shadow-dark), inset -2px -2px 4px var(--shadow-light);
}
.logout-icon { font-size: 14px; }

/* ===== Mobile (≤ 640px): sidebar becomes a full-width overlay ===== */
@media (max-width: 640px) {
  /* Override the desktop icon-only width so the sidebar is always full-width
     on mobile; visibility is controlled entirely by translateX. */
  .sidebar {
    width: var(--sidebar-w) !important;
    transition: transform 0.25s ease;
    /* Hidden by default: sits off-screen to the left */
    transform: translateX(-100%);
  }
  .sidebar:not(.collapsed) {
    /* Tap the hamburger → collapsed becomes false → sidebar slides in */
    transform: translateX(0);
    /* Cast a shadow over the content area behind it */
    box-shadow: 4px 0 24px rgba(0, 0, 0, 0.22);
  }
}
</style>
