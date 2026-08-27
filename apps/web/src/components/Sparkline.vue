<script setup lang="ts">
/**
 * A growth curve drawn as inline SVG.
 *
 * No chart library: one path, one filled area, one dot per observation. The
 * dots matter — they show how much evidence the curve rests on, which a smooth
 * line would quietly hide.
 */
import { computed } from 'vue';
import { useFormat } from '@/composables/useFormat';

const props = defineProps<{
  values: (number | null)[];
  color?: string;
  height?: number;
  showDots?: boolean;
}>();

const { num } = useFormat();
const H = computed(() => props.height ?? 160);
const W = 800;
const PAD = 8;

const points = computed(() => props.values.filter((v): v is number => v !== null && Number.isFinite(v)));

const geometry = computed(() => {
  const p = points.value;
  if (p.length < 2) return null;
  const max = Math.max(...p);
  const min = Math.min(...p);
  const span = max - min || 1;
  const step = (W - PAD * 2) / (p.length - 1);

  const coords = p.map((v, i) => [
    PAD + i * step,
    H.value - PAD - ((v - min) / span) * (H.value - PAD * 2),
  ] as const);

  const line = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const last = coords[coords.length - 1] as readonly [number, number];
  const area = `${line} L${last[0].toFixed(1)},${H.value - PAD} L${PAD},${H.value - PAD} Z`;
  return { coords, line, area, min, max, count: p.length };
});

const stroke = computed(() => props.color ?? 'rgb(var(--v-theme-primary))');
</script>

<template>
  <div v-if="geometry === null" class="empty text-caption">
    {{ $t('detail.notEnough') }}
  </div>
  <div v-else>
    <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" class="chart" role="img">
      <path :d="geometry.area" :fill="stroke" fill-opacity="0.13" />
      <path :d="geometry.line" fill="none" :stroke="stroke" stroke-width="2" stroke-linejoin="round" />
      <template v-if="showDots !== false">
        <circle
          v-for="(c, i) in geometry.coords"
          :key="i"
          :cx="c[0].toFixed(1)"
          :cy="c[1].toFixed(1)"
          r="2.6"
          :fill="stroke"
        />
      </template>
    </svg>
    <div class="text-caption faint mt-1">
      {{ $t('detail.observationsRange', { n: geometry.count, min: num(geometry.min), max: num(geometry.max) }) }}
    </div>
  </div>
</template>

<style scoped>
.chart {
  width: 100%;
  display: block;
}
.empty {
  padding: 20px;
  border: 1px dashed rgb(var(--v-theme-surface-variant));
  border-radius: 10px;
  text-align: center;
  color: rgb(var(--v-theme-on-surface-variant));
}
.faint {
  opacity: 0.7;
}
</style>
