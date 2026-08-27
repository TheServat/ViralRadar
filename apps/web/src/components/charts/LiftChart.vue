<script setup lang="ts">
/**
 * A diverging bar with a confidence whisker.
 *
 * Every other chart here answers "how much". This one answers "is this real",
 * which needs a different shape: bars grow left or right from a baseline that
 * is drawn rather than implied, and each carries the interval its sample size
 * actually supports.
 *
 * The whisker is the point of the chart, not decoration. A bar that reaches
 * further than its whisker is a result; one whose whisker crosses the baseline
 * is a bar that happens to be long. Drawing both makes the difference visible
 * without asking anyone to read a p-value.
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

export interface LiftRow {
  readonly key: string;
  readonly label: string;
  readonly n: number;
  readonly lift: number;
  readonly margin: number;
  readonly percentile: number;
  readonly significant: boolean;
  readonly thin: boolean;
}

// `minSample` comes from the server rather than being repeated here: if the
// threshold ever changes there, a stale number in a tooltip would be worse
// than no number at all.
const props = withDefaults(
  defineProps<{ rows: readonly LiftRow[]; minSample: number; showRank?: boolean }>(),
  { showRank: true },
);
const { t } = useI18n();

const ROW_HEIGHT = 34;
const LABEL_WIDTH = 116;
const RIGHT_PAD = 58;

/**
 * The domain covers the whiskers, not just the bars, so an interval is never
 * clipped at the edge - a cut-off whisker would read as a narrower one.
 * A floor of ±10 stops a set of tiny differences from being magnified into
 * dramatic-looking bars.
 */
const extent = computed(() => {
  let max = 10;
  for (const row of props.rows) {
    max = Math.max(max, Math.abs(row.lift) + (Number.isFinite(row.margin) ? row.margin : 0));
  }
  return Math.min(max, 60);
});

/** 0..100 within the plotting area, as a percentage for a fluid viewBox. */
function x(value: number): number {
  const clamped = Math.max(-extent.value, Math.min(extent.value, value));
  return 50 + (clamped / extent.value) * 50;
}

function barStart(row: LiftRow): number {
  return Math.min(x(0), x(row.lift));
}

function barWidth(row: LiftRow): number {
  return Math.abs(x(row.lift) - x(0));
}

function colorOf(row: LiftRow): string {
  if (row.thin || !row.significant) return 'var(--lift-muted)';
  return row.lift >= 0 ? 'var(--lift-up)' : 'var(--lift-down)';
}

function titleOf(row: LiftRow): string {
  const state = row.thin
    ? t('formats.tipThin', { min: props.minSample })
    : row.significant
      ? t('formats.tipReal')
      : t('formats.tipNoise');
  // The timing view hides the rank on purpose: its values are re-centred to
  // remove the age effect, so they are differences rather than true
  // percentiles and can fall outside 0-100. The lift is the real quantity.
  const rank = props.showRank ? `${t('formats.tipRank', { rank: row.percentile })}\n` : '';
  return `${row.label}\n${rank}${t('formats.tipLift', {
    lift: row.lift > 0 ? `+${row.lift}` : String(row.lift),
    margin: row.margin,
  })}\n${t('formats.tipItems', { n: row.n })}\n${state}`;
}
</script>

<template>
  <div class="lift">
    <div v-for="row in rows" :key="row.key" class="lift-row" :title="titleOf(row)">
      <div class="lift-label" :class="{ faded: row.thin }">
        {{ row.label }}
        <span class="lift-n">{{ row.n }}</span>
      </div>

      <svg class="lift-plot" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
        <!-- The baseline: what "typical for this platform" looks like. -->
        <line :x1="x(0)" :x2="x(0)" y1="0" y2="24" class="baseline" vector-effect="non-scaling-stroke" />
        <rect :x="barStart(row)" :width="barWidth(row)" y="6" height="12" rx="1" :fill="colorOf(row)" />
        <!-- The interval. A whisker crossing the baseline means "not proven". -->
        <line
          v-if="row.margin < 100"
          :x1="x(row.lift - row.margin)"
          :x2="x(row.lift + row.margin)"
          y1="12"
          y2="12"
          class="whisker"
          vector-effect="non-scaling-stroke"
        />
      </svg>

      <div class="lift-value" :class="{ real: row.significant, faded: row.thin }">
        {{ row.lift > 0 ? '+' : '' }}{{ row.lift }}
      </div>
    </div>

    <div class="lift-legend">
      <span><i class="swatch up" />{{ $t('formats.legendUp') }}</span>
      <span><i class="swatch down" />{{ $t('formats.legendDown') }}</span>
      <span><i class="swatch muted" />{{ $t('formats.legendUnproven') }}</span>
      <span class="whisker-key"><i class="swatch-line" />{{ $t('formats.legendWhisker') }}</span>
    </div>
  </div>
</template>

<style scoped>
.lift {
  --lift-up: #46d39a;
  --lift-down: #ff6b7a;
  --lift-muted: rgba(var(--v-theme-on-surface), 0.18);
}

.lift-row {
  display: grid;
  grid-template-columns: v-bind('LABEL_WIDTH + "px"') 1fr v-bind('RIGHT_PAD + "px"');
  align-items: center;
  gap: 8px;
  height: v-bind('ROW_HEIGHT + "px"');
}

.lift-label {
  font-size: 0.8125rem;
  text-align: end;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.lift-n {
  font-size: 0.6875rem;
  opacity: 0.5;
  margin-inline-start: 6px;
  font-variant-numeric: tabular-nums;
}

.lift-plot {
  width: 100%;
  height: 24px;
  overflow: visible;
}

.baseline {
  stroke: rgba(var(--v-theme-on-surface), 0.35);
  stroke-width: 1;
  stroke-dasharray: 2 2;
}

.whisker {
  stroke: rgba(var(--v-theme-on-surface), 0.55);
  stroke-width: 1.5;
  stroke-linecap: round;
}

.lift-value {
  font-size: 0.8125rem;
  font-variant-numeric: tabular-nums;
  opacity: 0.6;
  text-align: end;
}

.lift-value.real {
  opacity: 1;
  font-weight: 600;
}

.faded {
  opacity: 0.45;
}

.lift-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid rgba(var(--v-theme-on-surface), 0.08);
  font-size: 0.75rem;
  opacity: 0.75;
}

.lift-legend span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.swatch {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  display: inline-block;
}

.swatch.up {
  background: var(--lift-up);
}

.swatch.down {
  background: var(--lift-down);
}

.swatch.muted {
  background: var(--lift-muted);
}

.swatch-line {
  width: 14px;
  height: 0;
  border-top: 1.5px solid rgba(var(--v-theme-on-surface), 0.55);
  display: inline-block;
}
</style>
