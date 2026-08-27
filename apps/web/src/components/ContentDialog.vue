<script setup lang="ts">
/**
 * Everything known about one item, including the raw series its score was
 * computed from. A score you cannot inspect is a score you cannot trust.
 */
import { computed, watch, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { ContentDetail } from '@/api/types';
import { SOURCE_ICON, TYPE_ICON, stateColor, useFormat } from '@/composables/useFormat';
import { useCodeLabel } from '@/composables/useCodes';
import { openContentId, openClusterId } from '@/composables/useRadar';
import StateChip from './StateChip.vue';
import LineChart, { type Series } from './charts/LineChart.vue';
import ClusterCard from './ClusterCard.vue';

const detail = ref<ContentDetail | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const { num, exact, percent, ago, dateTime, clock } = useFormat();
const { t } = useI18n();
const label = useCodeLabel();

const open = computed({
  get: () => openContentId.value !== null,
  set: (value: boolean) => {
    if (!value) openContentId.value = null;
  },
});

watch(openContentId, async (id) => {
  if (id === null) {
    detail.value = null;
    return;
  }
  loading.value = true;
  error.value = null;
  try {
    detail.value = await api.content(id);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
});

/**
 * Every metric the platform actually returned, each as its own line.
 *
 * Showing likes and comments beside views is what makes an engagement number
 * checkable rather than something to take on faith.
 */
const series = computed<Series[]>(() => {
  const history = detail.value?.history ?? [];
  if (history.length === 0) return [];
  const candidates = [
    { key: 'views', label: t('metric.views') },
    { key: 'nativeScore', label: t('metric.points') },
    { key: 'likes', label: t('metric.likes') },
    { key: 'comments', label: t('metric.comments') },
    { key: 'shares', label: t('metric.shares') },
  ] as const;
  return candidates
    .filter((c) => history.some((h) => h[c.key] !== null))
    .map((c) => ({
      key: c.key,
      label: c.label,
      points: history
        .filter((h) => h[c.key] !== null)
        .map((h) => ({ x: h.ts, y: h[c.key] as number })),
    }));
});

const signals = computed(() => {
  const s = detail.value?.signals;
  if (!s) return [];
  return [
    {
      key: 'velocity',
      label: 'metric.velocity',
      value: num(s.velocity),
      hint: { metric: s.primaryMetric },
      hintKey: 'metric.velocityHint',
      icon: 'mdi-speedometer',
    },
    {
      key: 'acceleration',
      label: 'metric.acceleration',
      value: num(s.acceleration),
      hintKey: 'metric.accelerationHint',
      icon: 'mdi-chevron-double-up',
    },
    {
      key: 'engagement',
      label: 'metric.engagement',
      value: percent(s.engagementRate, 2),
      hintKey: 'metric.engagementHint',
      icon: 'mdi-comment-multiple-outline',
    },
    {
      key: 'anomaly',
      label: 'metric.creatorAnomaly',
      value: s.creatorAnomaly === null ? '—' : `${s.creatorAnomaly.toFixed(1)}×`,
      hintKey: detail.value?.creator?.medianMetric ? 'metric.creatorAnomalyHint' : 'metric.noBaseline',
      hint: { value: num(detail.value?.creator?.medianMetric ?? null) },
      icon: 'mdi-rocket-launch-outline',
    },
    {
      key: 'percentile',
      label: 'metric.platformRank',
      value: percent(s.sourcePercentile),
      hintKey: 'metric.platformRankHint',
      icon: 'mdi-chart-bell-curve',
    },
    {
      key: 'freshness',
      label: 'metric.freshness',
      value: percent(s.freshness),
      hintKey: 'metric.freshnessHint',
      icon: 'mdi-clock-fast',
    },
    {
      key: 'cross',
      label: 'metric.crossSource',
      value: percent(s.crossSource),
      hintKey: 'metric.crossSourceHint',
      icon: 'mdi-earth',
    },
  ];
});
</script>

<template>
  <v-dialog v-model="open" max-width="920" scrollable>
    <v-card v-if="loading" class="pa-8 text-center">
      <v-progress-circular indeterminate color="primary" />
    </v-card>

    <v-card v-else-if="error" class="pa-6">
      <p class="text-error">{{ $t('app.error', { message: error }) }}</p>
    </v-card>

    <v-card v-else-if="detail">
      <v-toolbar density="comfortable" color="surface">
        <v-icon :icon="SOURCE_ICON[detail.source] ?? 'mdi-web'" class="ms-4" />
        <v-toolbar-title class="text-body-1 font-weight-medium">{{ detail.source }}</v-toolbar-title>
        <v-btn icon="mdi-close" variant="text" @click="open = false" />
      </v-toolbar>

      <v-card-text>
        <h2 class="headline">{{ detail.title }}</h2>

        <div class="d-flex flex-wrap ga-2 my-3 align-center">
          <StateChip :state="detail.state" size="small" />
          <v-chip size="small" variant="tonal" :prepend-icon="TYPE_ICON[detail.contentType]">
            {{ $t(`type.${detail.contentType}`) }}
          </v-chip>
          <v-chip v-if="detail.language.code" size="small" variant="outlined">
            {{ label.language(detail.language.code) }} · {{ percent(detail.language.confidence, 0) }}
          </v-chip>
          <v-chip v-if="detail.country.code" size="small" variant="outlined">
            {{ label.country(detail.country.code) }}
            <span class="faint ms-1">{{ detail.country.source }}</span>
          </v-chip>
          <v-spacer />
          <v-btn
            :href="detail.url"
            target="_blank"
            rel="noreferrer noopener"
            color="primary"
            append-icon="mdi-open-in-new"
          >
            {{ $t('detail.openOriginal') }}
          </v-btn>
        </div>

        <v-row dense class="mb-2">
          <v-col cols="6" sm="3">
            <v-card variant="tonal" :color="stateColor(detail.state)">
              <div class="pa-3">
                <div class="tile-label">{{ $t('metric.score') }}</div>
                <div class="tile-value">{{ Math.round(detail.score ?? 0) }}</div>
                <div class="tile-hint">
                  {{ $t('metric.confidence') }} {{ percent(detail.confidence) }}
                </div>
              </div>
            </v-card>
          </v-col>
          <v-col v-for="s in signals.slice(0, 3)" :key="s.key" cols="6" sm="3">
            <v-card>
              <div class="pa-3">
                <div class="tile-label"><v-icon :icon="s.icon" size="12" /> {{ $t(s.label) }}</div>
                <div class="tile-value">{{ s.value }}</div>
                <div class="tile-hint">{{ $t(s.hintKey, s.hint ?? {}) }}</div>
              </div>
            </v-card>
          </v-col>
        </v-row>

        <v-row dense class="mb-4">
          <v-col v-for="s in signals.slice(3)" :key="s.key" cols="6" sm="3">
            <v-card>
              <div class="pa-3">
                <div class="tile-label"><v-icon :icon="s.icon" size="12" /> {{ $t(s.label) }}</div>
                <div class="tile-value">{{ s.value }}</div>
                <div class="tile-hint">{{ $t(s.hintKey, s.hint ?? {}) }}</div>
              </div>
            </v-card>
          </v-col>
        </v-row>

        <h3 class="sub">{{ $t('detail.growthHistory') }}</h3>
        <LineChart
          :series="series"
          mode="area"
          :height="220"
          :zero-based="false"
          show-dots
          :x-format="clock"
        />

        <template v-if="detail.creator">
          <h3 class="sub mt-5">{{ $t('detail.creatorBaseline') }}</h3>
          <v-row dense>
            <v-col cols="6" sm="3">
              <v-card><div class="pa-3">
                <div class="tile-label">{{ $t('creators.name') }}</div>
                <div class="tile-value small">{{ detail.creator.name ?? detail.creator.externalId }}</div>
              </div></v-card>
            </v-col>
            <v-col cols="6" sm="3">
              <v-card><div class="pa-3">
                <div class="tile-label">{{ $t('metric.followers') }}</div>
                <div class="tile-value">{{ num(detail.creator.followers) }}</div>
              </div></v-card>
            </v-col>
            <v-col cols="6" sm="3">
              <v-card><div class="pa-3">
                <div class="tile-label">{{ $t('detail.median') }}</div>
                <div class="tile-value">{{ num(detail.creator.medianMetric) }}</div>
                <div class="tile-hint">{{ $t('detail.postsObserved', { n: detail.creator.sampleCount }) }}</div>
              </div></v-card>
            </v-col>
            <v-col cols="6" sm="3">
              <v-card><div class="pa-3">
                <div class="tile-label">{{ $t('detail.p90') }}</div>
                <div class="tile-value">{{ num(detail.creator.p90Metric) }}</div>
              </div></v-card>
            </v-col>
          </v-row>
        </template>

        <h3 class="sub mt-5">{{ $t('detail.topic') }}</h3>
        <ClusterCard
          v-if="detail.cluster"
          :cluster="detail.cluster"
          @click="openClusterId = detail.cluster?.id ?? null"
        />
        <p v-else class="text-caption faint">{{ $t('detail.noTopic') }}</p>

        <div v-if="detail.hashtags.length" class="d-flex flex-wrap ga-1 mt-4">
          <v-chip v-for="h in detail.hashtags" :key="h" size="x-small" variant="outlined">#{{ h }}</v-chip>
        </div>

        <p class="text-caption faint mt-4">
          {{ $t('detail.firstSeen', { when: ago(detail.firstSeenAt) }) }} ·
          <template v-if="detail.publishedAt">
            {{ $t('detail.published', { when: dateTime(detail.publishedAt) }) }}
            <span v-if="detail.publishedAtSource">({{ detail.publishedAtSource }})</span>
          </template>
          <template v-else>{{ $t('detail.unknownPublish') }}</template>
          <template v-if="detail.signals">
            · {{ $t('detail.scoringVersion', { version: detail.signals.scoringVersion }) }} ·
            {{ exact(detail.signals.observations) }} {{ $t('metric.observations') }}
          </template>
        </p>
      </v-card-text>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.headline {
  font-size: 1.15rem;
  font-weight: 650;
  line-height: 1.35;
}
.sub {
  font-size: 0.85rem;
  font-weight: 650;
  margin-bottom: 8px;
}
.tile-label {
  font-size: 0.62rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: rgb(var(--v-theme-on-surface-variant));
}
.tile-value {
  font-size: 1.1rem;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}
.tile-value.small {
  font-size: 0.85rem;
}
.tile-hint {
  font-size: 0.66rem;
  color: rgb(var(--v-theme-on-surface-variant));
  opacity: 0.85;
}
.faint {
  opacity: 0.7;
}
</style>
