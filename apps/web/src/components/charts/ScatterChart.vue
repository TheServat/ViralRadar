<script setup lang="ts">
/**
 * Reach against growth, one dot per item.
 *
 * This is the chart that shows what a ranked list cannot: the outliers sit
 * visibly apart from the crowd. A small account far above its own normal lands
 * in the top-left, away from the big accounts doing their usual numbers, and
 * that separation is the whole product in one picture.
 *
 * Both axes are logarithmic, because reach spans several orders of magnitude.
 */
import { computed, ref, watch } from 'vue';
import { DEFAULT_MARGIN, logScale, stateColorOf } from './useChart';
import { useFormat } from '@/composables/useFormat';

export interface Point {
  id: string;
  label: string;
  x: number;
  y: number;
  size?: number | null;
  state: string;
  source: string;
}

const props = withDefaults(
  defineProps<{
    points: Point[];
    height?: number;
    xLabel?: string;
    yLabel?: string;
  }>(),
  { height: 300 },
);

const emit = defineEmits<{ select: [id: string] }>();

const W = 900;
const M = { ...DEFAULT_MARGIN, left: 54, bottom: 34 };
const { num } = useFormat();
const hovered = ref<Point | null>(null);
const animationKey = ref(0);
watch(() => props.points, () => { animationKey.value++; }, { deep: true });

const usable = computed(() => props.points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));

const innerW = W - M.left - M.right;
const innerH = computed(() => props.height - M.top - M.bottom);

const xMax = computed(() => Math.max(10, ...usable.value.map((p) => p.x)));
const yMax = computed(() => Math.max(10, ...usable.value.map((p) => p.y)));

const x = computed(() => logScale([0, xMax.value], [M.left, M.left + innerW]));
const y = computed(() => logScale([0, yMax.value], [M.top + innerH.value, M.top]));

/** Log ticks at powers of ten, which is what a log axis should read as. */
function logTicks(max: number): number[] {
  const ticks: number[] = [0];
  for (let power = 1; 10 ** power <= max * 1.5; power++) ticks.push(10 ** power);
  return ticks.length > 6 ? ticks.filter((_, i) => i % 2 === 0 || i === ticks.length - 1) : ticks;
}

const xTicks = computed(() => logTicks(xMax.value));
const yTicks = computed(() => logTicks(yMax.value));

const sizeScale = computed(() => {
  const sizes = usable.value.map((p) => p.size ?? 0).filter((s) => s > 0);
  const max = sizes.length > 0 ? Math.max(...sizes) : 1;
  return (value: number | null | undefined): number => {
    if (value === null || value === undefined || value <= 0) return 3;
    return 3 + 6 * Math.sqrt(Math.log1p(value) / Math.log1p(max));
  };
});

const dots = computed(() =>
  usable.value.map((point, index) => ({
    point,
    cx: x.value(point.x),
    cy: y.value(point.y),
    r: sizeScale.value(point.size),
    color: stateColorOf(point.state),
    delay: Math.min(600, index * 4),
  })),
);

const legendStates = computed(() => [...new Set(usable.value.map((p) => p.state))]);
</script>

<template>
  <div class="chart-wrap">
    <div v-if="dots.length === 0" class="chart-empty text-caption">{{ $t('reports.noData') }}</div>
    <template v-else>
      <svg :key="animationKey" :viewBox="`0 0 ${W} ${height}`" class="chart" role="img">
        <g class="grid">
          <line
            v-for="tick in yTicks"
            :key="`gy${tick}`"
            :x1="M.left"
            :x2="M.left + innerW"
            :y1="y(tick)"
            :y2="y(tick)"
          />
          <line
            v-for="tick in xTicks"
            :key="`gx${tick}`"
            :x1="x(tick)"
            :x2="x(tick)"
            :y1="M.top"
            :y2="M.top + innerH"
          />
        </g>

        <g class="axis">
          <text v-for="tick in yTicks" :key="`y${tick}`" :x="M.left - 8" :y="y(tick) + 3" text-anchor="end">
            {{ num(tick) }}
          </text>
          <text v-for="tick in xTicks" :key="`x${tick}`" :x="x(tick)" :y="height - 14" text-anchor="middle">
            {{ num(tick) }}
          </text>
          <text v-if="xLabel" :x="M.left + innerW / 2" :y="height - 1" text-anchor="middle" class="axis-title">
            {{ xLabel }}
          </text>
          <text
            v-if="yLabel"
            :x="12"
            :y="M.top + innerH / 2"
            text-anchor="middle"
            class="axis-title"
            :transform="`rotate(-90 12 ${M.top + innerH / 2})`"
          >
            {{ yLabel }}
          </text>
        </g>

        <g>
          <circle
            v-for="dot in dots"
            :key="dot.point.id"
            class="dot"
            :cx="dot.cx"
            :cy="dot.cy"
            :r="dot.r"
            :fill="dot.color"
            :class="{ focus: hovered?.id === dot.point.id }"
            :style="{ '--delay': `${dot.delay}ms` }"
            @mouseenter="hovered = dot.point"
            @mouseleave="hovered = null"
            @click="emit('select', dot.point.id)"
          />
        </g>
      </svg>

      <div class="legend">
        <span v-for="state in legendStates" :key="state" class="legend-item">
          <span class="swatch" :style="{ background: stateColorOf(state) }" />{{ $t(`state.${state}`) }}
        </span>
      </div>

      <div v-if="hovered" class="tooltip">
        <div class="tip-title">{{ hovered.label }}</div>
        <div class="tip-meta">
          {{ hovered.source }} · {{ $t(`state.${hovered.state}`) }} ·
          {{ xLabel }} {{ num(hovered.x) }} · {{ yLabel }} {{ num(hovered.y) }}
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.chart-wrap {
  position: relative;
}
.chart {
  width: 100%;
  display: block;
  overflow: visible;
}
.grid line {
  stroke: rgb(var(--v-theme-surface-variant));
  stroke-width: 1;
  stroke-dasharray: 3 4;
  opacity: 0.5;
}
.axis text {
  font-size: 10px;
  fill: rgb(var(--v-theme-on-surface-variant));
  font-variant-numeric: tabular-nums;
}
.axis-title {
  font-size: 10.5px;
  font-weight: 600;
}
.dot {
  opacity: 0.72;
  cursor: pointer;
  transition: opacity 0.15s ease, r 0.15s ease;
  animation: pop 0.4s cubic-bezier(0.22, 1, 0.36, 1) both;
  animation-delay: var(--delay);
}
.dot:hover,
.dot.focus {
  opacity: 1;
  stroke: rgb(var(--v-theme-on-surface));
  stroke-width: 1.5;
}
@keyframes pop {
  from {
    opacity: 0;
    transform: scale(0.2);
    transform-origin: center;
                     }
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 11px;
  margin-top: 4px;
  font-size: 0.72rem;
  color: rgb(var(--v-theme-on-surface-variant));
}
.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.swatch {
  width: 9px;
  height: 9px;
  border-radius: 3px;
}
.tooltip {
  /* Centred physically and clamped to the chart: a long title used to push it
     off the edge, and on a right-to-left page it left the viewport entirely. */
  position: absolute;
  top: 4px;
  left: 50%;
  right: auto;
  transform: translateX(-50%);
  pointer-events: none;
  background: rgb(var(--v-theme-surface));
  border: 1px solid rgb(var(--v-theme-surface-variant));
  border-radius: 8px;
  padding: 6px 10px;
  width: max-content;
  max-width: min(70%, 460px);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
  z-index: 2;
}
.tip-title {
  font-size: 0.76rem;
  font-weight: 600;
  /* Wrap rather than truncate: two lines of a real title beat one clipped one. */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.tip-meta {
  font-size: 0.68rem;
  color: rgb(var(--v-theme-on-surface-variant));
  font-variant-numeric: tabular-nums;
}
.chart-empty {
  padding: 34px;
  text-align: center;
  color: rgb(var(--v-theme-on-surface-variant));
  border: 1px dashed rgb(var(--v-theme-surface-variant));
  border-radius: 10px;
}
@media (prefers-reduced-motion: reduce) {
  .dot {
    animation: none;
  }
}
</style>
