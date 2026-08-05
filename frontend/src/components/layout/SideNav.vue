<template>
  <aside class="sidebar nm-raised" :class="{ collapsed }">
    <div class="sidebar-header">
      <span v-if="!collapsed" class="brand">147ai</span>
      <button class="toggle-btn nm-btn" @click="$emit('toggle')">
        {{ collapsed ? '›' : '‹' }}
      </button>
    </div>

    <nav class="nav-list">
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
  </aside>
</template>

<script setup lang="ts">
defineProps<{ collapsed: boolean }>()
defineEmits<{ toggle: [] }>()

const navItems = [
  { to: '/image-gen', icon: '🖼️', label: 'GPT Image 生成' }
]
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
</style>
