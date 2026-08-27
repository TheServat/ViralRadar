<script setup lang="ts">
defineProps<{ title: string; hint?: string; count?: number | null; icon?: string }>();
</script>

<template>
  <div class="d-flex align-baseline flex-wrap ga-2 mb-3">
    <h2 class="section-title">
      <v-icon v-if="icon" :icon="icon" size="17" class="me-1" />
      {{ title }}
    </h2>
    <span v-if="count !== null && count !== undefined" class="count">{{ count }}</span>
    <span v-if="hint" class="hint ms-auto">{{ hint }}</span>
    <slot name="actions" />
  </div>
</template>

<style scoped>
.section-title {
  font-size: 0.95rem;
  font-weight: 650;
  letter-spacing: -0.01em;
}
.count {
  font-size: 0.75rem;
  color: rgb(var(--v-theme-on-surface-variant));
}
.hint {
  font-size: 0.75rem;
  color: rgb(var(--v-theme-on-surface-variant));
  opacity: 0.85;
}
</style>
