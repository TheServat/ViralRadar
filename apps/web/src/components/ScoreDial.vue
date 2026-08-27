<script setup lang="ts">
/**
 * Score and confidence in one mark.
 *
 * The ring is the score; its opacity is the confidence. A big number backed by
 * one observation therefore *looks* uncertain, which is the distinction the
 * engine works hard to preserve and the interface should not throw away.
 */
import { computed } from 'vue';
import { stateColor } from '@/composables/useFormat';

const props = defineProps<{
  score: number;
  confidence?: number | null;
  state?: string;
  size?: number;
}>();

const dimension = computed(() => props.size ?? 46);
const color = computed(() => (props.state === undefined ? 'primary' : stateColor(props.state)));
const opacity = computed(() => {
  const c = props.confidence;
  return c === null || c === undefined ? 1 : 0.35 + 0.65 * Math.min(1, Math.max(0, c));
});
</script>

<template>
  <v-tooltip>
    <template #activator="{ props: tip }">
      <div v-bind="tip" class="dial" :style="{ width: `${dimension}px` }">
        <v-progress-circular
          :model-value="Math.max(3, Math.min(100, score))"
          :size="dimension"
          :width="3"
          :color="color"
          :style="{ opacity }"
        >
          <span class="value">{{ Math.round(score) }}</span>
        </v-progress-circular>
      </div>
    </template>
    <div class="text-caption">
      {{ $t('metric.score') }}: {{ Math.round(score) }}
      <template v-if="confidence !== null && confidence !== undefined">
        · {{ $t('metric.confidence') }}: {{ Math.round(confidence * 100) }}%
      </template>
    </div>
  </v-tooltip>
</template>

<style scoped>
.dial {
  flex: none;
  display: grid;
  place-items: center;
}
.value {
  font-size: 0.85rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
</style>
