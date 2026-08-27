<script setup lang="ts">
/**
 * A donut with a readable centre.
 *
 * Segments sweep in from twelve o'clock; hovering one lifts it and writes its
 * share into the hole, so the chart answers "how much is that slice" without a
 * legend lookup.
 */
import { computed, ref, watch } from 'vue';
import { arcPath, seriesColor } from './useChart';
import { useFormat } from '@/composables/useFormat';

export interface Slice {
  key: string;
  label: string;
  value: number;
  color?: string;
}

const props = withDefaults(
  defineProps<{ slices: Slice[]; size?: number; centreLabel?: string; maxSlices?: number }>(),
  { size: 220, maxSlices: 8 },
);

const { exact, percent } = useFormat();
const hovered = ref<string | null>(null);
const animationKey = ref(0);
watch(() => props.slices, () => { animationKey.value++; }, { deep: true });

/** Everything past the cut-off becomes one honest "other" slice. */
const prepared = computed(() => {
  const sorted = [...props.slices].filter((s) => s.value > 0).sort((a, b) => b.value - a.value);
  const head = sorted.slice(0, props.maxSlices);
  const tail = sorted.slice(props.maxSlices);
  if (tail.length > 0) {
    head.push({
      key: '__other',
      label: `+${tail.length}`,
      value: tail.reduce((a, b) => a + b.value, 0),
      color: 'rgb(var(--v-theme-on-surface-variant))',
    });
  }
  return head;
});

const total = computed(() => prepared.value.reduce((a, b) => a + b.value, 0));

const segments = computed(() => {
  const cx = props.size / 2;
  const cy = props.size / 2;
  const outer = props.size / 2 - 6;
  const inner = outer * 0.62;
  let angle = 0;

  return prepared.value.map((slice, index) => {
    const share = total.value === 0 ? 0 : slice.value / total.value;
    const start = angle;
    const end = angle + share * Math.PI * 2;
    angle = end;
    const mid = (start + end) / 2;
    return {
      ...slice,
      color: slice.color ?? seriesColor(index),
      share,
      // A hovered segment is nudged outward along its own bisector.
      d: arcPath(cx, cy, outer, inner, start, Math.max(end, start + 0.004)),
      lift: `translate(${(Math.sin(mid) * 4).toFixed(2)}px, ${(-Math.cos(mid) * 4).toFixed(2)}px)`,
      delay: index * 70,
    };
  });
});

const focused = computed(() => segments.value.find((s) => s.key === hovered.value) ?? null);
</script>

<template>
  <div class="donut-wrap">
    <div v-if="total === 0" class="chart-empty text-caption">{{ $t('reports.noData') }}</div>
    <template v-else>
      <div class="donut">
        <svg :key="animationKey" :viewBox="`0 0 ${size} ${size}`" :style="{ width: `${size}px` }" role="img">
          <g>
            <path
              v-for="segment in segments"
              :key="segment.key"
              :d="segment.d"
              :fill="segment.color"
              class="segment"
              :class="{ dim: hovered !== null && hovered !== segment.key }"
              :style="{
                '--delay': `${segment.delay}ms`,
                transform: hovered === segment.key ? segment.lift : undefined,
              }"
              @mouseenter="hovered = segment.key"
              @mouseleave="hovered = null"
            >
              <title>{{ segment.label }}: {{ exact(segment.value) }}</title>
            </path>
          </g>
        </svg>
        <div class="centre">
          <div class="centre-value">
            {{ focused ? percent(focused.share, 0) : exact(total) }}
          </div>
          <div class="centre-label">{{ focused ? focused.label : (centreLabel ?? '') }}</div>
        </div>
      </div>

      <div class="legend">
        <span
          v-for="segment in segments"
          :key="segment.key"
          class="legend-item"
          :class="{ dim: hovered !== null && hovered !== segment.key }"
          @mouseenter="hovered = segment.key"
          @mouseleave="hovered = null"
        >
          <span class="swatch" :style="{ background: segment.color }" />
          <span class="legend-label">{{ segment.label }}</span>
          <b>{{ exact(segment.value) }}</b>
        </span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.donut-wrap {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 18px;
}
.donut {
  position: relative;
  display: grid;
  place-items: center;
  flex: none;
}
.donut svg {
  display: block;
  overflow: visible;
}
.centre {
  position: absolute;
  text-align: center;
  pointer-events: none;
}
.centre-value {
  font-size: 1.3rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}
.centre-label {
  font-size: 0.68rem;
  color: rgb(var(--v-theme-on-surface-variant));
  max-width: 14ch;
}
.segment {
  cursor: pointer;
  transform-origin: center;
  transition: transform 0.18s ease, opacity 0.18s ease;
  animation: sweep 0.6s cubic-bezier(0.22, 1, 0.36, 1) both;
  animation-delay: var(--delay);
}
.segment.dim,
.legend-item.dim {
  opacity: 0.38;
}
@keyframes sweep {
  from {
    opacity: 0;
    transform: scale(0.86) rotate(-14deg);
  }
}
.legend {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 0.75rem;
  min-width: 130px;
  flex: 1 1 130px;
}
.legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  transition: opacity 0.18s ease;
  font-variant-numeric: tabular-nums;
}
.legend-label {
  flex: 1 1 auto;
  color: rgb(var(--v-theme-on-surface-variant));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.swatch {
  width: 9px;
  height: 9px;
  border-radius: 3px;
  flex: none;
}
.chart-empty {
  padding: 34px;
  text-align: center;
  color: rgb(var(--v-theme-on-surface-variant));
  border: 1px dashed rgb(var(--v-theme-surface-variant));
  border-radius: 10px;
  width: 100%;
}
@media (prefers-reduced-motion: reduce) {
  .segment {
    animation: none;
  }
}
</style>
