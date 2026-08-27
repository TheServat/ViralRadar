<script setup lang="ts">
/**
 * Weekday against hour of day.
 *
 * This is the same grid the scoring engine normalises against. Seeing it makes
 * an otherwise invisible decision legible: if the platform is reliably busy at
 * a certain hour, an item posted then is judged against that hour, not against
 * the daily average.
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useFormat } from '@/composables/useFormat';

const props = withDefaults(
  defineProps<{ cells: { dow: number; hour: number; n: number }[]; height?: number }>(),
  { height: 190 },
);

const { locale } = useI18n();
const { exact } = useFormat();

const dayNames = computed(() => {
  const format = new Intl.DateTimeFormat(locale.value, { weekday: 'short' });
  // 2024-01-07 was a Sunday, which is what strftime('%w') calls 0.
  return Array.from({ length: 7 }, (_, i) => format.format(new Date(Date.UTC(2024, 0, 7 + i))));
});

const max = computed(() => Math.max(1, ...props.cells.map((c) => c.n)));
const lookup = computed(() => {
  const map = new Map<string, number>();
  for (const cell of props.cells) map.set(`${cell.dow}:${cell.hour}`, cell.n);
  return map;
});

const grid = computed(() =>
  Array.from({ length: 7 }, (_, dow) =>
    Array.from({ length: 24 }, (_, hour) => {
      const n = lookup.value.get(`${dow}:${hour}`) ?? 0;
      return {
        dow,
        hour,
        n,
        // Square-root scaling: linear intensity makes everything but the peak
        // hour look empty on a distribution this skewed.
        intensity: n === 0 ? 0 : 0.12 + 0.88 * Math.sqrt(n / max.value),
        delay: (dow * 24 + hour) * 3,
      };
    }),
  ),
);

const busiest = computed(() => {
  let best: { dow: number; hour: number; n: number } | null = null;
  for (const cell of props.cells) if (best === null || cell.n > best.n) best = cell;
  return best;
});
</script>

<template>
  <div>
    <div v-if="cells.length === 0" class="chart-empty text-caption">{{ $t('reports.noData') }}</div>
    <template v-else>
      <div class="heatmap" :style="{ height: `${height}px` }">
        <div class="hours">
          <span v-for="h in [0, 4, 8, 12, 16, 20]" :key="h" :style="{ insetInlineStart: `${(h / 24) * 100}%` }">
            {{ String(h).padStart(2, '0') }}
          </span>
        </div>
        <div v-for="(row, dow) in grid" :key="dow" class="row">
          <span class="day">{{ dayNames[dow] }}</span>
          <div class="cells">
            <span
              v-for="cell in row"
              :key="cell.hour"
              class="cell"
              :style="{
                '--intensity': cell.intensity,
                '--delay': `${cell.delay}ms`,
              }"
              :title="`${dayNames[dow]} ${String(cell.hour).padStart(2, '0')}:00 — ${exact(cell.n)}`"
            />
          </div>
        </div>
      </div>
      <div class="scale">
        <span class="text-caption faint">0</span>
        <span class="ramp" />
        <span class="text-caption faint">{{ exact(max) }}</span>
        <span v-if="busiest" class="text-caption faint ms-auto">
          {{ dayNames[busiest.dow] }} {{ String(busiest.hour).padStart(2, '0') }}:00
        </span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.heatmap {
  display: flex;
  flex-direction: column;
  gap: 3px;
  position: relative;
  padding-top: 16px;
}
.hours {
  position: absolute;
  top: 0;
  inset-inline-start: 42px;
  inset-inline-end: 0;
  height: 14px;
}
.hours span {
  position: absolute;
  font-size: 9.5px;
  color: rgb(var(--v-theme-on-surface-variant));
  font-variant-numeric: tabular-nums;
}
.row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1 1 0;
}
.day {
  width: 36px;
  font-size: 10px;
  color: rgb(var(--v-theme-on-surface-variant));
  text-align: end;
  flex: none;
}
.cells {
  display: grid;
  grid-template-columns: repeat(24, 1fr);
  gap: 3px;
  flex: 1 1 auto;
  height: 100%;
}
.cell {
  border-radius: 3px;
  background: rgb(var(--v-theme-primary));
  opacity: calc(var(--intensity) * 0.95 + 0.05);
  animation: pop 0.35s ease both;
  animation-delay: var(--delay);
  transition: transform 0.12s ease;
}
.cell:hover {
  transform: scale(1.35);
  z-index: 1;
}
@keyframes pop {
  from {
    opacity: 0;
    transform: scale(0.4);
  }
}
.scale {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
}
.ramp {
  width: 90px;
  height: 6px;
  border-radius: 3px;
  background: linear-gradient(
    to right,
    rgba(var(--v-theme-primary), 0.08),
    rgb(var(--v-theme-primary))
  );
}
.faint {
  opacity: 0.65;
}
.chart-empty {
  padding: 34px;
  text-align: center;
  color: rgb(var(--v-theme-on-surface-variant));
  border: 1px dashed rgb(var(--v-theme-surface-variant));
  border-radius: 10px;
}
@media (prefers-reduced-motion: reduce) {
  .cell {
    animation: none;
  }
}
</style>
