<script setup lang="ts">
import { computed } from 'vue';
import { STATE_ICON, stateColor } from '@/composables/useFormat';

const props = defineProps<{ state: string; size?: 'x-small' | 'small' }>();
const color = computed(() => stateColor(props.state));
const icon = computed(() => STATE_ICON[props.state] ?? 'mdi-circle-outline');
</script>

<template>
  <v-chip
    :size="size ?? 'x-small'"
    :color="color"
    variant="tonal"
    class="font-weight-bold state-chip"
    :prepend-icon="icon"
  >
    {{ $t(`state.${state}`) }}
  </v-chip>
</template>

<style scoped>
.state-chip {
  letter-spacing: 0.02em;
}
</style>
