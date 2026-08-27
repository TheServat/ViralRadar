<script setup lang="ts">
/** A topic and the posts carrying it, across every platform that has it. */
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { ClusterDetail } from '@/api/types';
import { SOURCE_ICON, stateColor, useFormat } from '@/composables/useFormat';
import { useCodeLabel } from '@/composables/useCodes';
import { openClusterId, openContentId } from '@/composables/useRadar';
import StateChip from './StateChip.vue';
import LineChart, { type Series } from './charts/LineChart.vue';

const detail = ref<ClusterDetail | null>(null);
const loading = ref(false);
const { num, ago, percent, clock } = useFormat();
const { t } = useI18n();
const label = useCodeLabel();

const open = computed({
  get: () => openClusterId.value !== null,
  set: (value: boolean) => {
    if (!value) openClusterId.value = null;
  },
});

watch(openClusterId, async (id) => {
  if (id === null) {
    detail.value = null;
    return;
  }
  loading.value = true;
  try {
    detail.value = await api.cluster(id);
  } finally {
    loading.value = false;
  }
});

/** Score and membership together: a topic can hold its score while growing. */
const copied = ref(false);
const OPEN_LIMIT = 10;
const openableCount = computed(() => Math.min(detail.value?.items.length ?? 0, OPEN_LIMIT));

/**
 * Opens the top posts of a topic in tabs.
 *
 * Capped, and only ever from a real click: browsers block bursts of windows
 * that were not asked for, and opening forty tabs would not be a favour anyway.
 */
function openAll(): void {
  for (const item of (detail.value?.items ?? []).slice(0, OPEN_LIMIT)) {
    window.open(item.url, '_blank', 'noopener,noreferrer');
  }
}

async function copyLinks(): Promise<void> {
  const links = (detail.value?.items ?? []).map((i) => i.url).join(String.fromCharCode(10));
  try {
    await navigator.clipboard.writeText(links);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 2000);
  } catch {
    // Clipboard access can be refused; the per-row links still work.
  }
}

const scoreSeries = computed<Series[]>(() => {
  const history = detail.value?.history ?? [];
  if (history.length < 2) return [];
  return [
    {
      key: 'score',
      label: t('metric.score'),
      color: stateColor(detail.value?.state ?? 'NEW'),
      points: history.map((h) => ({ x: h.ts, y: h.score })),
    },
    {
      key: 'items',
      label: t('detail.postsInTopic'),
      points: history.map((h) => ({ x: h.ts, y: h.item_count })),
    },
  ];
});
</script>

<template>
  <v-dialog v-model="open" max-width="920" scrollable>
    <v-card v-if="loading" class="pa-8 text-center">
      <v-progress-circular indeterminate color="primary" />
    </v-card>

    <v-card v-else-if="detail">
      <v-toolbar density="comfortable" color="surface">
        <v-toolbar-title class="text-body-1 font-weight-medium ms-4">
          {{ $t('detail.topic') }}
        </v-toolbar-title>
        <v-btn icon="mdi-close" variant="text" @click="open = false" />
      </v-toolbar>

      <v-card-text>
        <h2 class="headline">{{ detail.label }}</h2>
        <p v-if="detail.explanation" class="text-body-2 mt-1 faint">{{ detail.explanation }}</p>

        <div class="d-flex flex-wrap ga-2 my-3">
          <StateChip :state="detail.state" size="small" />
          <v-chip size="small" color="primary" variant="tonal">
            {{ $t('clusters.platforms', { n: detail.platformCount }) }}
          </v-chip>
          <v-chip size="small" variant="tonal">{{ $t('clusters.posts', { n: detail.itemCount }) }}</v-chip>
          <v-chip size="small" variant="outlined">
            {{ $t('metric.score') }} {{ Math.round(detail.score) }}
          </v-chip>
          <v-chip size="small" variant="outlined">
            {{ $t('metric.confidence') }} {{ percent(detail.confidence) }}
          </v-chip>
        </div>

        <div class="d-flex flex-wrap ga-1 mb-4">
          <v-chip v-for="k in detail.keywords" :key="k" size="x-small" variant="outlined">{{ k }}</v-chip>
        </div>

        <v-row dense class="mb-3">
          <v-col cols="6" sm="3">
            <v-card><div class="pa-3">
              <div class="tile-label">{{ $t('detail.platforms') }}</div>
              <div class="tile-value">{{ detail.platformCount }}</div>
              <div class="tile-hint">{{ detail.sources.join(', ') }}</div>
            </div></v-card>
          </v-col>
          <v-col cols="6" sm="3">
            <v-card><div class="pa-3">
              <div class="tile-label">{{ $t('detail.postsPerHour') }}</div>
              <div class="tile-value">{{ detail.velocity ?? 0 }}</div>
              <div class="tile-hint">{{ $t('metric.acceleration') }} {{ detail.acceleration ?? 0 }}</div>
            </div></v-card>
          </v-col>
          <v-col cols="6" sm="3">
            <v-card><div class="pa-3">
              <div class="tile-label">{{ $t('detail.totalViews') }}</div>
              <div class="tile-value">{{ num(detail.totalViews) }}</div>
            </div></v-card>
          </v-col>
          <v-col cols="6" sm="3">
            <v-card><div class="pa-3">
              <div class="tile-label">{{ $t('detail.propagation') }}</div>
              <div class="tile-value small">{{ ago(detail.firstSeenAt) }}</div>
              <div v-if="detail.languages.length" class="tile-hint">
                {{ detail.languages.slice(0, 2).map((l) => `${label.language(l.code)} ${l.pct}%`).join(' · ') }}
              </div>
            </div></v-card>
          </v-col>
        </v-row>

        <template v-if="scoreSeries.length > 0">
          <h3 class="sub">{{ $t('detail.scoreOverTime') }}</h3>
          <LineChart :series="scoreSeries" mode="line" :height="200" :zero-based="false" show-dots :x-format="clock" />
          <div class="d-flex flex-wrap ga-1 mt-2">
            <v-chip
              v-for="h in detail.history.slice(-12)"
              :key="h.ts"
              size="x-small"
              variant="text"
              class="faint"
            >
              {{ clock(h.ts) }} · {{ Math.round(h.score) }}
            </v-chip>
          </div>
        </template>

        <div class="d-flex align-baseline flex-wrap ga-2 mt-5 mb-2">
          <h3 class="sub mb-0">{{ $t('detail.postsInTopic') }}</h3>
          <v-spacer />
          <v-btn size="x-small" variant="text" prepend-icon="mdi-content-save" @click="copyLinks">
            {{ copied ? $t('app.done') : $t('detail.copyLinks') }}
          </v-btn>
          <v-btn size="x-small" variant="tonal" prepend-icon="mdi-open-in-new" @click="openAll">
            {{ $t('detail.openAll', { n: openableCount }) }}
          </v-btn>
        </div>
        <v-list class="pa-0 bg-transparent">
          <v-list-item
            v-for="item in detail.items"
            :key="item.id"
            class="member px-3 mb-2"
            border
            rounded="lg"
            @click="openContentId = item.id"
          >
            <template #prepend>
              <StateChip :state="item.state" />
              <v-icon :icon="SOURCE_ICON[item.source] ?? 'mdi-web'" size="16" class="mx-2" />
            </template>
            <v-list-item-title class="text-body-2">{{ item.title }}</v-list-item-title>
            <template #append>
              <span class="score me-2">{{ Math.round(item.score) }}</span>
              <v-btn
                :href="item.url"
                target="_blank"
                rel="noreferrer noopener"
                icon="mdi-open-in-new"
                size="x-small"
                variant="text"
                @click.stop
              />
            </template>
          </v-list-item>
        </v-list>
      </v-card-text>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.headline {
  font-size: 1.15rem;
  font-weight: 650;
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
  font-size: 0.9rem;
}
.tile-hint {
  font-size: 0.66rem;
  color: rgb(var(--v-theme-on-surface-variant));
  opacity: 0.85;
}
.member {
  cursor: pointer;
}
.score {
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.faint {
  opacity: 0.7;
}
</style>
