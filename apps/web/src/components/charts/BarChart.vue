<script setup lang="ts">
/**
 * Bars, horizontal or vertical.
 *
 * Bars grow from their baseline on mount, staggered by index, which reads as
 * the data arriving rather than as decoration.
 */
import { computed, ref, watch } from 'vue';
import { DEFAULT_MARGIN, extent, linearScale, niceTicks, seriesColor } from './useChart';
import { useFormat } from '@/composables/useFormat';

export interface Bar {
  key: string;
  label: string;
  value: number;
  color?: string;
}

const props = withDefaults(
  defineProps<{
    bars: Bar[];
    height?: number;
    horizontal?: boolean;
    valueFormat?: (value: number) => string;
    maxBars?: number;
  }>(),
  { height: 240, horizontal: false, maxBars: 24 },
);

const W = 900;
const { num } = useFormat();
const animationKey = ref(0);
watch(() => props.bars, () => { animationKey.value++; }, { deep: true });

const shown = computed(() => props.bars.slice(0, props.maxBars));
const margin = computed(() =>
  props.horizontal ? { ...DEFAULT_MARGIN, left: 130, bottom: 22 } : DEFAULT_MARGIN,
);

const domain = computed<[number, number]>(() => {
  const [, hi] = extent(shown.value.map((b) => b.value));
  return [0, hi === 0 ? 1 : hi * 1.05];
});

const innerW = computed(() => W - margin.value.left - margin.value.right);
const innerH = computed(() => props.height - margin.value.top - margin.value.bottom);

const value = computed(() =>
  props.horizontal
    ? linearScale(domain.value, [margin.value.left, margin.value.left + innerW.value])
    : linearScale(domain.value, [margin.value.top + innerH.value, margin.value.top]),
);

const band = computed(() => {
  const count = Math.max(1, shown.value.length);
  const span = props.horizontal ? innerH.value : innerW.value;
  const step = span / count;
  return { step, thickness: Math.max(4, Math.min(34, step * 0.68)) };
});

const items = computed(() =>
  shown.value.map((bar, index) => {
    const offset =
      (props.horizontal ? margin.value.top : margin.value.left) +
      index * band.value.step +
      (band.value.step - band.value.thickness) / 2;
    const length = props.horizontal
      ? value.value(bar.value) - margin.value.left
      : margin.value.top + innerH.value - value.value(bar.value);
    return {
      ...bar,
      color: bar.color ?? seriesColor(index),
      offset,
      length: Math.max(0, length),
      delay: index * 35,
    };
  }),
);

const ticks = computed(() => niceTicks(0, domain.value[1], 4));
const fmt = (v: number): string => (props.valueFormat ? props.valueFormat(v) : num(v));
</script>

<template>
  <div class="chart-wrap">
    <div v-if="items.length === 0" class="chart-empty text-caption">{{ $t('reports.noData') }}</div>
    <svg v-else :key="animationKey" :viewBox="`0 0 ${W} ${height}`" class="chart" role="img">
      <g class="grid">
        <line
          v-for="tick in ticks"
          :key="tick"
          :x1="horizontal ? value(tick) : margin.left"
          :x2="horizontal ? value(tick) : margin.left + innerW"
          :y1="horizontal ? margin.top : value(tick)"
          :y2="horizontal ? margin.top + innerH : value(tick)"
        />
      </g>

      <g class="axis">
        <template v-if="horizontal">
          <text v-for="tick in ticks" :key="`t${tick}`" :x="value(tick)" :y="height - 6" text-anchor="middle">
            {{ fmt(tick) }}
          </text>
          <text
            v-for="item in items"
            :key="`l${item.key}`"
            :x="margin.left - 10"
            :y="item.offset + band.thickness / 2 + 3.5"
            text-anchor="end"
            class="label"
          >
            {{ item.label }}
          </text>
        </template>
        <template v-else>
          <text v-for="tick in ticks" :key="`t${tick}`" :x="margin.left - 8" :y="value(tick) + 3" text-anchor="end">
            {{ fmt(tick) }}
          </text>
          <text
            v-for="item in items"
            :key="`l${item.key}`"
            :x="item.offset + band.thickness / 2"
            :y="height - 8"
            text-anchor="middle"
            class="label"
          >
            {{ item.label }}
          </text>
        </template>
      </g>

      <g>
        <g v-for="item in items" :key="item.key" :style="{ '--delay': `${item.delay}ms` }">
          <rect
            class="bar"
            :class="horizontal ? 'grow-x' : 'grow-y'"
            :x="horizontal ? margin.left : item.offset"
            :y="horizontal ? item.offset : margin.top + innerH - item.length"
            :width="horizontal ? item.length : band.thickness"
            :height="horizontal ? band.thickness : item.length"
            :fill="item.color"
            rx="3"
          >
            <title>{{ item.label }}: {{ fmt(item.value) }}</title>
          </rect>
          <text
            class="value"
            :x="horizontal ? margin.left + item.length + 6 : item.offset + band.thickness / 2"
            :y="horizontal ? item.offset + band.thickness / 2 + 3.5 : margin.top + innerH - item.length - 5"
            :text-anchor="horizontal ? 'start' : 'middle'"
          >
            {{ fmt(item.value) }}
          </text>
        </g>
      </g>
    </svg>
  </div>
</template>

<style scoped>
.chart {
  width: 100%;
  display: block;
  overflow: visible;
}
.chart-empty {
  padding: 34px;
  text-align: center;
  color: rgb(var(--v-theme-on-surface-variant));
  border: 1px dashed rgb(var(--v-theme-surface-variant));
  border-radius: 10px;
}
.grid line {
  stroke: rgb(var(--v-theme-surface-variant));
  stroke-width: 1;
  stroke-dasharray: 3 4;
  opacity: 0.6;
}
.axis text {
  font-size: 10px;
  fill: rgb(var(--v-theme-on-surface-variant));
  font-variant-numeric: tabular-nums;
}
.axis .label {
  font-size: 10.5px;
}
.value {
  font-size: 10px;
  fill: rgb(var(--v-theme-on-surface));
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  animation: fade-in 0.4s ease both;
  animation-delay: calc(var(--delay) + 320ms);
}
.bar {
  transition: opacity 0.15s ease;
}
.bar:hover {
  opacity: 0.82;
}
.grow-y {
  transform-origin: center bottom;
  animation: grow-y 0.55s cubic-bezier(0.22, 1, 0.36, 1) both;
  animation-delay: var(--delay);
}
.grow-x {
  transform-origin: left center;
  animation: grow-x 0.55s cubic-bezier(0.22, 1, 0.36, 1) both;
  animation-delay: var(--delay);
}
@keyframes grow-y {
  from {
    transform: scaleY(0);
  }
}
@keyframes grow-x {
  from {
    transform: scaleX(0);
  }
}
@keyframes fade-in {
  from {
    opacity: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .grow-x,
  .grow-y,
  .value {
    animation: none;
  }
}
</style>
