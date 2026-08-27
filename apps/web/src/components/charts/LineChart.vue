<script setup lang="ts">
/**
 * Multi-series time chart: line, area or stacked area.
 *
 * The draw-in is a stroke-dashoffset animation, so the line writes itself once
 * on mount and on every data change rather than flickering. Hovering snaps to
 * the nearest x, which is what people actually mean when they point at a chart.
 */
import { computed, ref, watch } from 'vue';
import {
  DEFAULT_MARGIN,
  extent,
  linearScale,
  linePath,
  niceTicks,
  seriesColor,
  smoothPath,
} from './useChart';
import { useFormat } from '@/composables/useFormat';

export interface Series {
  key: string;
  label: string;
  color?: string;
  points: { x: number; y: number }[];
}

const props = withDefaults(
  defineProps<{
    series: Series[];
    height?: number;
    mode?: 'line' | 'area' | 'stacked';
    smooth?: boolean;
    xFormat?: (value: number) => string;
    yFormat?: (value: number) => string;
    showLegend?: boolean;
    showDots?: boolean;
    zeroBased?: boolean;
  }>(),
  { height: 240, mode: 'area', smooth: true, showLegend: true, showDots: false, zeroBased: true },
);

const W = 900;
const M = DEFAULT_MARGIN;
const { num, clock } = useFormat();
const hoverIndex = ref<number | null>(null);
const svg = ref<SVGSVGElement | null>(null);
/** Bumped on every data change to restart the draw-in animation. */
const animationKey = ref(0);

watch(() => props.series, () => { animationKey.value++; }, { deep: true });

const innerW = computed(() => W - M.left - M.right);
const innerH = computed(() => props.height - M.top - M.bottom);

const xValues = computed(() => {
  const set = new Set<number>();
  for (const s of props.series) for (const p of s.points) set.add(p.x);
  return [...set].sort((a, b) => a - b);
});

/** Stacked mode accumulates series in order; the others stand alone. */
const resolved = computed(() => {
  const xs = xValues.value;
  const running = new Map<number, number>();
  return props.series.map((s, index) => {
    const byX = new Map(s.points.map((p) => [p.x, p.y]));
    const values = xs.map((x) => {
      const y = byX.get(x) ?? 0;
      if (props.mode !== 'stacked') return { x, y, base: 0 };
      const base = running.get(x) ?? 0;
      running.set(x, base + y);
      return { x, y: base + y, base };
    });
    return { ...s, color: s.color ?? seriesColor(index), values };
  });
});

const yDomain = computed<[number, number]>(() => {
  const all = resolved.value.flatMap((s) => s.values.map((v) => v.y));
  const [lo, hi] = extent(all);
  const min = props.zeroBased ? Math.min(0, lo) : lo;
  const max = hi === min ? min + 1 : hi;
  return [min, max + (max - min) * 0.08];
});

const x = computed(() => {
  const xs = xValues.value;
  const [lo, hi] = xs.length > 0 ? [xs[0] as number, xs[xs.length - 1] as number] : [0, 1];
  return linearScale([lo, hi === lo ? lo + 1 : hi], [M.left, M.left + innerW.value]);
});

const y = computed(() => linearScale(yDomain.value, [M.top + innerH.value, M.top]));

const yTicks = computed(() => niceTicks(yDomain.value[0], yDomain.value[1], 4));
const xTicks = computed(() => {
  const xs = xValues.value;
  if (xs.length <= 6) return xs;
  const step = Math.ceil(xs.length / 6);
  return xs.filter((_, i) => i % step === 0);
});

const paths = computed(() =>
  resolved.value.map((s) => {
    const pts = s.values.map((v) => [x.value(v.x), y.value(v.y)] as const);
    const line = props.smooth ? smoothPath(pts) : linePath(pts);
    const basePts = s.values.map((v) => [x.value(v.x), y.value(props.mode === 'stacked' ? v.base : yDomain.value[0])] as const);
    const back = props.smooth ? smoothPath([...basePts].reverse()) : linePath([...basePts].reverse());
    return {
      key: s.key,
      label: s.label,
      color: s.color,
      line,
      area: pts.length > 0 ? `${line} L${back.slice(1)} Z` : '',
      dots: pts,
    };
  }),
);

const hovered = computed(() => {
  const i = hoverIndex.value;
  if (i === null || i < 0 || i >= xValues.value.length) return null;
  const xv = xValues.value[i] as number;
  return {
    x: x.value(xv),
    xValue: xv,
    rows: resolved.value
      .map((s) => ({ label: s.label, color: s.color, value: (s.values[i]?.y ?? 0) - (s.values[i]?.base ?? 0) }))
      .filter((r) => r.value !== 0 || props.series.length === 1)
      .reverse(),
  };
});

function onMove(event: MouseEvent): void {
  const el = svg.value;
  if (el === null || xValues.value.length === 0) return;
  const box = el.getBoundingClientRect();
  const ratio = (event.clientX - box.left) / box.width;
  const px = ratio * W;
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < xValues.value.length; i++) {
    const distance = Math.abs(x.value(xValues.value[i] as number) - px);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  hoverIndex.value = best;
}

const fmtY = (v: number): string => (props.yFormat ? props.yFormat(v) : num(v));
const fmtX = (v: number): string => (props.xFormat ? props.xFormat(v) : clock(v));
const empty = computed(() => xValues.value.length === 0);
</script>

<template>
  <div class="chart-wrap">
    <div v-if="empty" class="chart-empty text-caption">{{ $t('reports.noData') }}</div>
    <template v-else>
      <svg
        ref="svg"
        :viewBox="`0 0 ${W} ${height}`"
        class="chart"
        role="img"
        @mousemove="onMove"
        @mouseleave="hoverIndex = null"
      >
        <!-- Grid first, so every mark sits above it. -->
        <g class="grid">
          <line
            v-for="tick in yTicks"
            :key="`g${tick}`"
            :x1="M.left"
            :x2="M.left + innerW"
            :y1="y(tick).toFixed(1)"
            :y2="y(tick).toFixed(1)"
          />
        </g>

        <g class="axis">
          <text v-for="tick in yTicks" :key="`y${tick}`" :x="M.left - 8" :y="y(tick) + 3" text-anchor="end">
            {{ fmtY(tick) }}
          </text>
          <text
            v-for="tick in xTicks"
            :key="`x${tick}`"
            :x="x(tick)"
            :y="height - 8"
            text-anchor="middle"
          >
            {{ fmtX(tick) }}
          </text>
        </g>

        <g v-for="(p, i) in paths" :key="p.key" :style="{ '--delay': `${i * 90}ms` }">
          <path v-if="mode !== 'line'" class="area" :d="p.area" :fill="p.color" />
          <path :key="animationKey" class="line" :d="p.line" :stroke="p.color" />
          <template v-if="showDots">
            <circle
              v-for="(dot, di) in p.dots"
              :key="di"
              :cx="dot[0]"
              :cy="dot[1]"
              r="2.6"
              :fill="p.color"
              class="dot"
            />
          </template>
        </g>

        <g v-if="hovered" class="cursor">
          <line :x1="hovered.x" :x2="hovered.x" :y1="M.top" :y2="M.top + innerH" />
          <circle
            v-for="(p, i) in paths"
            :key="`h${p.key}`"
            :cx="hovered.x"
            :cy="p.dots[hoverIndex ?? 0]?.[1] ?? 0"
            r="4"
            :fill="p.color"
            :style="{ '--delay': `${i * 0}ms` }"
          />
        </g>
      </svg>

      <div
        v-if="hovered"
        class="tooltip"
        :style="{ left: `${Math.min(88, Math.max(12, (hovered.x / W) * 100))}%` }"
      >
        <div class="tip-head">{{ fmtX(hovered.xValue) }}</div>
        <div v-for="row in hovered.rows" :key="row.label" class="tip-row">
          <span class="swatch" :style="{ background: row.color }" />
          <span class="tip-label">{{ row.label }}</span>
          <b>{{ fmtY(row.value) }}</b>
        </div>
      </div>

      <div v-if="showLegend && series.length > 1" class="legend">
        <span v-for="p in paths" :key="p.key" class="legend-item">
          <span class="swatch" :style="{ background: p.color }" />{{ p.label }}
        </span>
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
  opacity: 0.65;
}
.axis text {
  font-size: 10px;
  fill: rgb(var(--v-theme-on-surface-variant));
  font-variant-numeric: tabular-nums;
}
.area {
  opacity: 0.14;
  animation: fade-in 0.5s ease both;
  animation-delay: var(--delay, 0ms);
}
.line {
  fill: none;
  stroke-width: 2.25;
  stroke-linecap: round;
  stroke-linejoin: round;
  /* Long enough for any path this size; the line writes itself in. */
  stroke-dasharray: 4000;
  stroke-dashoffset: 4000;
  animation: draw 1s cubic-bezier(0.22, 1, 0.36, 1) forwards;
  animation-delay: var(--delay, 0ms);
}
.dot {
  animation: fade-in 0.4s ease both;
  animation-delay: calc(var(--delay, 0ms) + 500ms);
}
.cursor line {
  stroke: rgb(var(--v-theme-on-surface-variant));
  stroke-width: 1;
  stroke-dasharray: 2 3;
}
.cursor circle {
  stroke: rgb(var(--v-theme-surface));
  stroke-width: 2;
}
@keyframes draw {
  to {
    stroke-dashoffset: 0;
  }
}
@keyframes fade-in {
  from {
    opacity: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .line,
  .area,
  .dot {
    animation: none;
    stroke-dashoffset: 0;
    opacity: initial;
  }
  .area {
    opacity: 0.14;
  }
}
.tooltip {
  position: absolute;
  top: 6px;
  transform: translateX(-50%);
  pointer-events: none;
  background: rgb(var(--v-theme-surface));
  border: 1px solid rgb(var(--v-theme-surface-variant));
  border-radius: 8px;
  padding: 6px 9px;
  font-size: 0.72rem;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
  white-space: nowrap;
  z-index: 2;
}
.tip-head {
  font-weight: 700;
  margin-bottom: 3px;
}
.tip-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-variant-numeric: tabular-nums;
}
.tip-label {
  color: rgb(var(--v-theme-on-surface-variant));
  margin-inline-end: 6px;
}
/* The SVG never mirrors, so neither may the marker that points into it. */
.tooltip {
  direction: ltr;
  text-align: start;
}
[dir='rtl'] .tooltip {
  direction: rtl;
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 6px;
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
  display: inline-block;
  flex: none;
}
</style>
