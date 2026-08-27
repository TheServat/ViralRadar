<script setup lang="ts">
/**
 * Everything the radar has learned about the window.
 *
 * Ordered as a reading, not a dump: how much arrived and when, then where from,
 * then who it reached, then how well any of it can actually be measured.
 */
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, query } from '@/api/client';
import type { ReportsData } from '@/api/types';
import { openContentId, useAsync } from '@/composables/useRadar';
import { stateColor, useFormat } from '@/composables/useFormat';
import { useCodeLabel } from '@/composables/useCodes';
import SectionHeader from '@/components/SectionHeader.vue';
import StatTile from '@/components/StatTile.vue';
import LineChart, { type Series } from '@/components/charts/LineChart.vue';
import BarChart from '@/components/charts/BarChart.vue';
import DonutChart from '@/components/charts/DonutChart.vue';
import HeatmapChart from '@/components/charts/HeatmapChart.vue';
import ScatterChart from '@/components/charts/ScatterChart.vue';
import { sourceColor } from '@/components/charts/useChart';

const hours = ref(72);
const { num, exact, percent, clock, dateTime } = useFormat();
const label = useCodeLabel();
const { t } = useI18n();

const q = computed(() => query({ hours: hours.value }));
const { data, loading, error } = useAsync<ReportsData>(
  () => api.reports(q.value),
  () => q.value,
);

const windows = [
  { value: 24, title: '24h' },
  { value: 72, title: '72h' },
  { value: 168, title: '7d' },
  { value: 720, title: '30d' },
];

/** Discovery over time, one stacked band per source. */
const timelineSeries = computed<Series[]>(() => {
  const points = data.value?.timeline ?? [];
  if (points.length === 0) return [];
  const bySource = new Map<string, Map<number, number>>();
  const allHours = new Set<number>();
  for (const p of points) {
    allHours.add(p.hour);
    const bucket = bySource.get(p.source) ?? new Map<number, number>();
    bucket.set(p.hour, (bucket.get(p.hour) ?? 0) + p.n);
    bySource.set(p.source, bucket);
  }
  const hoursSorted = [...allHours].sort((a, b) => a - b);
  return [...bySource.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([source, bucket]) => ({
      key: source,
      label: source,
      color: sourceColor(source),
      points: hoursSorted.map((h) => ({ x: h, y: bucket.get(h) ?? 0 })),
    }));
});

/** Score history for the strongest topics. */
const clusterSeries = computed<Series[]>(() =>
  (data.value?.clusterTraces ?? [])
    .filter((trace) => trace.points.length > 1)
    .map((trace) => ({
      key: trace.id,
      label: trace.label.length > 28 ? `${trace.label.slice(0, 27)}…` : trace.label,
      points: trace.points.map((p) => ({ x: p.ts, y: p.score })),
    })),
);

const histogramBars = computed(() =>
  (data.value?.scoreHistogram ?? []).map((b) => ({
    key: String(b.bucket),
    label: `${b.bucket}–${b.bucket + 9}`,
    value: b.n,
    // Coloured by the band a score in that range would fall into.
    color: stateColor(b.bucket >= 78 ? 'VIRAL' : b.bucket >= 62 ? 'HOT' : b.bucket >= 40 ? 'RISING' : 'NEW'),
  })),
);

const stateSlices = computed(() =>
  (data.value?.byState ?? []).map((s) => ({
    key: s.key,
    label: t(`state.${s.key}`),
    value: s.n,
    color: stateColor(s.key),
  })),
);

const sourceSlices = computed(() =>
  (data.value?.bySource ?? []).map((s) => ({
    key: s.key,
    label: s.key,
    value: s.n,
    color: sourceColor(s.key),
  })),
);

const languageBars = computed(() =>
  (data.value?.byLanguage ?? []).map((l) => ({
    key: l.key,
    label: l.key === 'unknown' ? t('app.unknown') : label.language(l.key) || l.key,
    value: l.n,
  })),
);

const countryBars = computed(() =>
  (data.value?.byCountry ?? []).map((c) => ({
    key: c.key,
    label: c.key === 'unknown' ? t('app.unknown') : label.country(c.key) || c.key,
    value: c.n,
  })),
);

const typeSlices = computed(() =>
  (data.value?.byType ?? []).map((c) => ({
    key: c.key,
    label: c.key === 'unknown' ? t('app.unknown') : t(`type.${c.key}`),
    value: c.n,
  })),
);

const domainBars = computed(() =>
  (data.value?.topDomains ?? []).map((d) => ({ key: d.key, label: d.key, value: d.n })),
);

const hashtagBars = computed(() =>
  (data.value?.hashtags ?? [])
    .slice(0, 14)
    .map((h) => ({ key: h.keyword, label: h.keyword, value: h.mentions })),
);

/** Reach against growth: the picture the ranked list cannot show. */
const scatterPoints = computed(() =>
  (data.value?.scatter ?? [])
    .filter((p) => p.value !== null && p.velocity !== null && p.velocity > 0)
    .map((p) => ({
      id: p.id,
      label: p.title,
      x: p.value as number,
      y: p.velocity as number,
      size: p.followers,
      state: p.state,
      source: p.source,
    })),
);

const anomalyPoints = computed(() =>
  (data.value?.scatter ?? [])
    .filter((p) => p.followers !== null && p.followers > 0 && p.value !== null)
    .map((p) => ({
      id: p.id,
      label: p.title,
      x: p.followers as number,
      y: p.value as number,
      size: p.anomaly,
      state: p.state,
      source: p.source,
    })),
);

const qualityHeaders = computed(() => [
  { title: t('reports.columns.source'), key: 'source' },
  { title: t('reports.columns.items'), key: 'items', align: 'end' as const },
  { title: t('reports.columns.scored'), key: 'scored', align: 'end' as const },
  { title: t('reports.columns.withVelocity'), key: 'with_velocity', align: 'end' as const },
  { title: t('reports.columns.observations'), key: 'median_observations', align: 'end' as const },
  { title: t('reports.columns.avgScore'), key: 'avg_score', align: 'end' as const },
  { title: t('reports.columns.maxScore'), key: 'max_score', align: 'end' as const },
]);

const tiles = computed(() => {
  const d = data.value;
  if (!d) return [];
  const totalItems = d.bySource.reduce((a, b) => a + b.n, 0);
  const withVelocity = d.sourceQuality.reduce((a, b) => a + b.with_velocity, 0);
  return [
    {
      label: t('reports.columns.items'),
      value: exact(totalItems),
      tooltip: t('tips.itemsCollected'),
      icon: 'mdi-file-multiple-outline',
    },
    {
      label: t('reports.columns.withVelocity'),
      value: exact(withVelocity),
      hint: percent(totalItems ? withVelocity / totalItems : 0, 0),
      tooltip: t('tips.withVelocity'),
      icon: 'mdi-speedometer',
    },
    {
      label: t('system.snapshots'),
      value: num(d.stats.metrics),
      tooltip: t('tips.snapshots'),
      icon: 'mdi-chart-timeline-variant',
    },
    {
      label: t('system.topics'),
      value: exact(d.stats.clusters),
      tooltip: t('tips.topics'),
      icon: 'mdi-shape-outline',
    },
    {
      label: t('system.creators'),
      value: exact(d.stats.creators),
      tooltip: t('tips.creators'),
      icon: 'mdi-account-multiple',
    },
    {
      label: t('creators.breakouts'),
      value: exact(d.stats.breakouts),
      tooltip: t('tips.breakouts'),
      icon: 'mdi-rocket-launch',
      color: 'VIRAL',
    },
  ];
});
</script>

<template>
  <div>
    <SectionHeader :title="$t('reports.title')" :hint="$t('reports.hint')" icon="mdi-chart-box-outline">
      <template #actions>
        <v-btn-toggle v-model="hours" density="compact" mandatory variant="outlined" divided>
          <v-btn v-for="w in windows" :key="w.value" :value="w.value" size="small">{{ w.title }}</v-btn>
        </v-btn-toggle>
      </template>
    </SectionHeader>

    <v-progress-linear v-if="loading" indeterminate color="primary" class="mb-3" />
    <v-alert v-if="error" type="error" variant="tonal">{{ $t('app.error', { message: error }) }}</v-alert>

    <template v-if="data">
      <v-row dense class="mb-4">
        <v-col v-for="tile in tiles" :key="tile.label" cols="6" sm="4" md="2">
          <StatTile v-bind="tile" />
        </v-col>
      </v-row>

      <v-card class="mb-4">
        <v-card-title class="section-title">
          {{ $t('reports.timeline') }}<span class="hint">{{ $t('reports.timelineHint') }}</span>
        </v-card-title>
        <v-card-text>
          <LineChart
            :series="timelineSeries"
            mode="stacked"
            :height="260"
            :x-format="clock"
            :y-format="exact"
          />
        </v-card-text>
      </v-card>

      <v-row dense class="mb-4">
        <v-col cols="12" lg="7">
          <v-card class="h-100">
            <v-card-title class="section-title">
              {{ $t('reports.reach') }}<span class="hint">{{ $t('reports.reachHint') }}</span>
            </v-card-title>
            <v-card-text>
              <ScatterChart
                :points="scatterPoints"
                :height="300"
                :x-label="$t('reports.axisReach')"
                :y-label="$t('reports.axisGrowth')"
                @select="openContentId = $event"
              />
            </v-card-text>
          </v-card>
        </v-col>
        <v-col cols="12" lg="5">
          <v-card class="h-100">
            <v-card-title class="section-title">
              {{ $t('reports.byState') }}
            </v-card-title>
            <v-card-text>
              <DonutChart :slices="stateSlices" :size="200" :centre-label="$t('reports.columns.items')" />
            </v-card-text>
          </v-card>
        </v-col>
      </v-row>

      <v-row dense class="mb-4">
        <v-col cols="12" lg="7">
          <v-card class="h-100">
            <v-card-title class="section-title">
              {{ $t('reports.anomaly') }}<span class="hint">{{ $t('reports.anomalyHint') }}</span>
            </v-card-title>
            <v-card-text>
              <ScatterChart
                :points="anomalyPoints"
                :height="300"
                :x-label="$t('reports.axisFollowers')"
                :y-label="$t('reports.axisReach')"
                @select="openContentId = $event"
              />
            </v-card-text>
          </v-card>
        </v-col>
        <v-col cols="12" lg="5">
          <v-card class="h-100">
            <v-card-title class="section-title">
              {{ $t('reports.scoreDistribution') }}<span class="hint">{{ $t('reports.scoreDistributionHint') }}</span>
            </v-card-title>
            <v-card-text>
              <BarChart :bars="histogramBars" :height="260" :value-format="exact" />
            </v-card-text>
          </v-card>
        </v-col>
      </v-row>

      <v-row dense class="mb-4">
        <v-col cols="12" md="6" lg="4">
          <v-card class="h-100">
            <v-card-title class="section-title">{{ $t('reports.bySource') }}</v-card-title>
            <v-card-text>
              <DonutChart :slices="sourceSlices" :size="190" :centre-label="$t('filters.source')" />
            </v-card-text>
          </v-card>
        </v-col>
        <v-col cols="12" md="6" lg="4">
          <v-card class="h-100">
            <v-card-title class="section-title">{{ $t('reports.byType') }}</v-card-title>
            <v-card-text>
              <DonutChart :slices="typeSlices" :size="190" :centre-label="$t('filters.type')" />
            </v-card-text>
          </v-card>
        </v-col>
        <v-col cols="12" lg="4">
          <v-card class="h-100">
            <v-card-title class="section-title">
              {{ $t('reports.activity') }}<span class="hint">{{ $t('reports.activityHint') }}</span>
            </v-card-title>
            <v-card-text>
              <HeatmapChart :cells="data.activity" :height="180" />
            </v-card-text>
          </v-card>
        </v-col>
      </v-row>

      <v-row dense class="mb-4">
        <v-col cols="12" md="6">
          <v-card class="h-100">
            <v-card-title class="section-title">{{ $t('reports.byLanguage') }}</v-card-title>
            <v-card-text>
              <BarChart :bars="languageBars" horizontal :height="260" :value-format="exact" :max-bars="9" />
            </v-card-text>
          </v-card>
        </v-col>
        <v-col cols="12" md="6">
          <v-card class="h-100">
            <v-card-title class="section-title">{{ $t('reports.byCountry') }}</v-card-title>
            <v-card-text>
              <BarChart :bars="countryBars" horizontal :height="260" :value-format="exact" :max-bars="9" />
            </v-card-text>
          </v-card>
        </v-col>
      </v-row>

      <v-card v-if="clusterSeries.length" class="mb-4">
        <v-card-title class="section-title">
          {{ $t('reports.topicScores') }}<span class="hint">{{ $t('reports.topicScoresHint') }}</span>
        </v-card-title>
        <v-card-text>
          <LineChart
            :series="clusterSeries"
            mode="line"
            :height="260"
            :zero-based="false"
            :x-format="clock"
            :y-format="(v: number) => Math.round(v).toString()"
            show-dots
          />
        </v-card-text>
      </v-card>

      <v-row dense class="mb-4">
        <v-col cols="12" md="6">
          <v-card class="h-100">
            <v-card-title class="section-title">{{ $t('reports.domains') }}</v-card-title>
            <v-card-text>
              <BarChart :bars="domainBars" horizontal :height="280" :value-format="exact" :max-bars="10" />
            </v-card-text>
          </v-card>
        </v-col>
        <v-col cols="12" md="6">
          <v-card class="h-100">
            <v-card-title class="section-title">
              {{ $t('reports.hashtags') }}<span class="hint">{{ $t('dashboard.hashtagsHint') }}</span>
            </v-card-title>
            <v-card-text>
              <BarChart :bars="hashtagBars" horizontal :height="280" :value-format="exact" :max-bars="10" />
            </v-card-text>
          </v-card>
        </v-col>
      </v-row>

      <v-card>
        <v-card-title class="section-title">
          {{ $t('reports.quality') }}<span class="hint">{{ $t('reports.qualityHint') }}</span>
        </v-card-title>
        <v-data-table
          :items="data.sourceQuality"
          :headers="qualityHeaders"
          :items-per-page="20"
          density="comfortable"
        >
          <template #item.items="{ item }"><span class="tabular">{{ exact(item.items) }}</span></template>
          <template #item.scored="{ item }"><span class="tabular">{{ exact(item.scored) }}</span></template>
          <template #item.with_velocity="{ item }">
            <span class="tabular">{{ exact(item.with_velocity) }}</span>
            <span class="faint ms-1">{{ percent(item.items ? item.with_velocity / item.items : 0, 0) }}</span>
          </template>
          <template #item.median_observations="{ item }">
            <span class="tabular">{{ item.median_observations === null ? '—' : item.median_observations.toFixed(1) }}</span>
          </template>
          <template #item.avg_score="{ item }">
            <span class="tabular">{{ item.avg_score === null ? '—' : Math.round(item.avg_score) }}</span>
          </template>
          <template #item.max_score="{ item }">
            <b class="tabular">{{ item.max_score === null ? '—' : Math.round(item.max_score) }}</b>
          </template>
        </v-data-table>
      </v-card>

      <p class="text-caption faint text-center mt-4">
        {{ $t('reports.window') }}: {{ dateTime(Math.floor(Date.now() / 1000) - hours * 3600) }}
      </p>
    </template>
  </div>
</template>

<style scoped>
.section-title {
  font-size: 0.9rem;
  font-weight: 650;
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.hint {
  font-size: 0.72rem;
  font-weight: 400;
  color: rgb(var(--v-theme-on-surface-variant));
}
.tabular {
  font-variant-numeric: tabular-nums;
}
.faint {
  opacity: 0.6;
}
</style>
