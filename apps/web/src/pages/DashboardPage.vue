<script setup lang="ts">
/**
 * The page that answers the whole product question without being asked
 * anything: what is exploding right now, and what should I make today.
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, query } from '@/api/client';
import type { DashboardData, ReportsData } from '@/api/types';
import { useAsync } from '@/composables/useRadar';
import { useFormat } from '@/composables/useFormat';
import TrendCard from '@/components/TrendCard.vue';
import ClusterCard from '@/components/ClusterCard.vue';
import SectionHeader from '@/components/SectionHeader.vue';
import StatTile from '@/components/StatTile.vue';
import LineChart, { type Series } from '@/components/charts/LineChart.vue';
import { sourceColor } from '@/components/charts/useChart';

const { data, loading, error, reload } = useAsync<DashboardData>(() => api.dashboard());
// The last day of collection, kept separate so the dashboard still renders if
// the heavier report query is slow or fails.
const pulse = useAsync<ReportsData>(() => api.reports(query({ hours: 24 })));
const { num, exact, ago, clock } = useFormat();
const { t } = useI18n();

const pulseSeries = computed<Series[]>(() => {
  const points = pulse.data.value?.timeline ?? [];
  if (points.length === 0) return [];
  const bySource = new Map<string, Map<number, number>>();
  const hours = new Set<number>();
  for (const p of points) {
    hours.add(p.hour);
    const bucket = bySource.get(p.source) ?? new Map<number, number>();
    bucket.set(p.hour, (bucket.get(p.hour) ?? 0) + p.n);
    bySource.set(p.source, bucket);
  }
  const sorted = [...hours].sort((a, b) => a - b);
  return [...bySource.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([source, bucket]) => ({
      key: source,
      label: source,
      color: sourceColor(source),
      points: sorted.map((h) => ({ x: h, y: bucket.get(h) ?? 0 })),
    }));
});

defineExpose({ reload });

/**
 * The answer to "what should I make today": topics carried by several
 * platforms at once, freshest first. Breadth beats raw score here — a story on
 * four platforms is a real event, and a big number on one is an algorithm.
 */
const todaysBrief = computed(() => {
  const clusters = data.value?.crossPlatform ?? [];
  return [...clusters]
    .sort((a, b) => b.platformCount - a.platformCount || b.lastSeenAt - a.lastSeenAt)
    .slice(0, 6);
});

const tiles = computed(() => {
  const d = data.value;
  if (!d) return [];
  return [
    {
      label: t('dashboard.viral'),
      value: exact(d.viral.length),
      tooltip: t('tips.viral'),
      icon: 'mdi-fire',
      color: 'VIRAL',
    },
    {
      label: t('dashboard.breakingOut'),
      value: exact(d.breakingOut.length),
      tooltip: t('tips.breakingOut'),
      icon: 'mdi-rocket-launch',
      color: 'HOT',
    },
    {
      label: t('dashboard.emerging'),
      value: exact(d.emerging.length),
      tooltip: t('tips.emerging'),
      icon: 'mdi-sprout',
      color: 'EMERGING',
    },
    {
      label: t('dashboard.crossPlatform'),
      value: exact(d.crossPlatform.length),
      tooltip: t('tips.crossPlatform'),
      icon: 'mdi-earth',
      color: 'primary',
    },
    {
      label: t('system.contentStored'),
      value: num(d.stats.content),
      tooltip: t('tips.contentStored'),
      icon: 'mdi-database',
    },
    {
      label: t('system.topics'),
      value: num(d.stats.clusters),
      tooltip: t('tips.topics'),
      icon: 'mdi-shape-outline',
    },
  ];
});
</script>

<template>
  <div>
    <v-progress-linear v-if="loading" indeterminate color="primary" class="mb-4" />
    <v-alert v-if="error" type="error" variant="tonal" class="mb-4">
      {{ $t('app.error', { message: error }) }}
      <template #append><v-btn size="small" @click="reload">{{ $t('app.retry') }}</v-btn></template>
    </v-alert>

    <template v-if="data">
      <v-row dense class="mb-2">
        <v-col v-for="tile in tiles" :key="tile.label" cols="6" sm="4" md="2">
          <StatTile v-bind="tile" />
        </v-col>
      </v-row>

      <v-card v-if="pulseSeries.length" class="mb-6">
        <v-card-title class="pulse-title">
          {{ $t('reports.timeline') }}
          <span class="pulse-hint">{{ $t('reports.hours', { n: 24 }) }}</span>
          <v-spacer />
          <v-btn size="x-small" variant="text" to="/reports" append-icon="mdi-arrow-right">
            {{ $t('nav.reports') }}
          </v-btn>
        </v-card-title>
        <v-card-text class="pt-0">
          <LineChart :series="pulseSeries" mode="stacked" :height="170" :x-format="clock" :y-format="exact" />
        </v-card-text>
      </v-card>

      <!-- The brief comes first: it is the reason the tool exists. -->
      <section v-if="todaysBrief.length" class="mb-8 mt-4">
        <SectionHeader
          :title="$t('dashboard.whatToMake')"
          :hint="$t('dashboard.whatToMakeHint')"
          icon="mdi-lightbulb-on-outline"
        />
        <v-row dense>
          <v-col v-for="c in todaysBrief" :key="c.id" cols="12" md="6" lg="4">
            <ClusterCard :cluster="c" />
          </v-col>
        </v-row>
      </section>

      <section class="mb-8">
        <SectionHeader
          :title="$t('dashboard.viral')"
          :hint="$t('dashboard.viralHint')"
          :count="data.viral.length"
          icon="mdi-fire"
        />
        <v-row v-if="data.viral.length" dense>
          <v-col v-for="item in data.viral" :key="item.id" cols="12" md="6" xl="4">
            <TrendCard :item="item" />
          </v-col>
        </v-row>
        <v-alert v-else type="info" variant="tonal" density="comfortable">{{ $t('dashboard.empty') }}</v-alert>
      </section>

      <section class="mb-8">
        <SectionHeader
          :title="$t('dashboard.breakingOut')"
          :hint="$t('dashboard.breakingOutHint')"
          :count="data.breakingOut.length"
          icon="mdi-rocket-launch"
        />
        <v-row v-if="data.breakingOut.length" dense>
          <v-col v-for="item in data.breakingOut" :key="item.id" cols="12" md="6" xl="4">
            <TrendCard :item="item" />
          </v-col>
        </v-row>
        <v-alert v-else type="info" variant="tonal" density="comfortable">
          {{ $t('dashboard.emptyBreakouts') }}
        </v-alert>
      </section>

      <section class="mb-8">
        <SectionHeader
          :title="$t('dashboard.emerging')"
          :hint="$t('dashboard.emergingHint')"
          :count="data.emerging.length"
          icon="mdi-sprout"
        >
          <template #actions>
            <span class="sorted-by">{{ $t('sort.orderedBy', { by: $t('metric.acceleration') }) }}</span>
          </template>
        </SectionHeader>
        <v-row v-if="data.emerging.length" dense>
          <v-col v-for="item in data.emerging" :key="item.id" cols="12" md="6" xl="4">
            <TrendCard :item="item" sorted-by="acceleration" />
          </v-col>
        </v-row>
        <v-alert v-else type="info" variant="tonal" density="comfortable">
          {{ $t('dashboard.emptyAccel') }}
        </v-alert>
      </section>

      <section class="mb-8">
        <SectionHeader
          :title="$t('dashboard.rising')"
          :hint="$t('dashboard.risingHint')"
          :count="data.rising.length"
          icon="mdi-trending-up"
        >
          <template #actions>
            <span class="sorted-by">{{ $t('sort.orderedBy', { by: $t('metric.acceleration') }) }}</span>
          </template>
        </SectionHeader>
        <v-row dense>
          <v-col v-for="item in data.rising" :key="item.id" cols="12" md="6" xl="4">
            <TrendCard :item="item" sorted-by="acceleration" dense />
          </v-col>
        </v-row>
      </section>

      <section v-if="data.hashtags.length" class="mb-8">
        <SectionHeader
          :title="$t('dashboard.hashtags')"
          :hint="$t('dashboard.hashtagsHint')"
          icon="mdi-pound"
        />
        <v-row dense>
          <v-col v-for="h in data.hashtags" :key="h.keyword" cols="6" sm="4" md="3" lg="2">
            <StatTile
              :label="h.keyword"
              :value="$t('dashboard.hashtagMentions', { n: exact(h.mentions) })"
              :hint="$t('dashboard.hashtagPrevious', { n: exact(h.previous), sources: h.source_count })"
              :tooltip="$t('dashboard.hashtagTooltip', {
                tag: h.keyword,
                now: exact(h.mentions),
                before: exact(h.previous),
                sources: h.source_count,
                creators: h.unique_creators,
              })"
              icon="mdi-pound"
              :color="h.growth > 1 ? 'EMERGING' : undefined"
            />
          </v-col>
        </v-row>
      </section>

      <p class="text-caption faint text-center">{{ ago(data.generatedAt) }}</p>
    </template>
  </div>
</template>

<style scoped>
.sorted-by {
  font-size: 0.72rem;
  color: rgb(var(--v-theme-on-surface-variant));
  white-space: nowrap;
}

.pulse-title {
  font-size: 0.9rem;
  font-weight: 650;
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.pulse-hint {
  font-size: 0.72rem;
  font-weight: 400;
  color: rgb(var(--v-theme-on-surface-variant));
}
.faint {
  opacity: 0.6;
}
</style>
