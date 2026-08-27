<script setup lang="ts">
/**
 * A ranked breakdown: label, share, count.
 *
 * A bar per row rather than a pie, because the question these answer is always
 * "which is biggest and by how much" — a comparison bars make and pies do not.
 */
import { computed } from 'vue';
import type { Bucketed } from '@/api/types';
import { useFormat } from '@/composables/useFormat';

const props = defineProps<{
  items: Bucketed[];
  title: string;
  labeller?: (key: string) => string;
  color?: string;
  limit?: number;
  colorFor?: (key: string) => string;
}>();

const { exact, percent } = useFormat();

const rows = computed(() => {
  const shown = props.items.slice(0, props.limit ?? 10);
  const total = props.items.reduce((a, b) => a + b.n, 0) || 1;
  const top = shown[0]?.n ?? 1;
  return shown.map((item) => ({
    key: item.key,
    label: props.labeller ? props.labeller(item.key) || item.key : item.key,
    n: item.n,
    share: item.n / total,
    width: Math.max(2, (item.n / top) * 100),
    color: props.colorFor ? props.colorFor(item.key) : undefined,
  }));
});
</script>

<template>
  <v-card>
    <v-card-title class="section-title">{{ title }}</v-card-title>
    <v-card-text class="pt-0">
      <div v-if="rows.length === 0" class="text-caption faint py-4 text-center">
        {{ $t('reports.noData') }}
      </div>
      <div v-for="row in rows" :key="row.key" class="row">
        <div class="d-flex justify-space-between align-baseline">
          <span class="name text-truncate">{{ row.label }}</span>
          <span class="figure">{{ exact(row.n) }} <span class="faint">{{ percent(row.share, 0) }}</span></span>
        </div>
        <div class="track">
          <div
            class="fill"
            :style="{ width: `${row.width}%`, background: row.color ?? `rgb(var(--v-theme-${color ?? 'primary'}))` }"
          />
        </div>
      </div>
    </v-card-text>
  </v-card>
</template>

<style scoped>
.section-title {
  font-size: 0.9rem;
  font-weight: 650;
  padding-bottom: 8px;
}
.row + .row {
  margin-top: 10px;
}
.name {
  font-size: 0.8rem;
  max-width: 60%;
}
.figure {
  font-size: 0.78rem;
  font-variant-numeric: tabular-nums;
}
.track {
  height: 5px;
  border-radius: 3px;
  background: rgb(var(--v-theme-surface-variant));
  overflow: hidden;
  margin-top: 4px;
}
.fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.3s ease;
}
.faint {
  opacity: 0.6;
}
</style>
