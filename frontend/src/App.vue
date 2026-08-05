<template>
  <n-config-provider :theme-overrides="themeOverrides">
    <n-message-provider>
      <router-view />
    </n-message-provider>
  </n-config-provider>
</template>

<script setup lang="ts">
import { NConfigProvider, NMessageProvider } from 'naive-ui'

const themeOverrides = {
  common: {
    primaryColor: '#6C9BD1',
    primaryColorHover: '#5a89bf',
    primaryColorPressed: '#4a7aaf',
    borderRadius: '12px',
    bodyColor: '#E8EDF2',
    cardColor: '#E8EDF2'
  }
}
</script>
