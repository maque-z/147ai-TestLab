<template>
  <div class="image-gen-view">
    <ImageGenPanel />
    <!-- Opened from the top bar; the flag is shared through the store. -->
    <ImageGenConfig v-model:show="store.configOpen" />
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useImageGenStore } from '@/stores/imageGen'
import ImageGenPanel from '@/components/imageGen/ImageGenPanel.vue'
import ImageGenConfig from '@/components/imageGen/ImageGenConfig.vue'

const store = useImageGenStore()

onMounted(() => store.loadConfig())
</script>

<style scoped>
.image-gen-view { display: flex; flex-direction: column; gap: 20px; }
</style>
