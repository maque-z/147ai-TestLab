<template>
  <div class="banana-gen-view">
    <BananaGenPanel />
    <!-- Opened from the top bar; the flag is shared through the store. -->
    <BananaGenConfig v-model:show="store.configOpen" />
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useBananaGenStore } from '@/stores/bananaGen'
import BananaGenPanel from '@/components/bananaGen/BananaGenPanel.vue'
import BananaGenConfig from '@/components/bananaGen/BananaGenConfig.vue'

const store = useBananaGenStore()

onMounted(() => store.loadConfig())
</script>

<style scoped>
.banana-gen-view { display: flex; flex-direction: column; gap: 20px; }
</style>
