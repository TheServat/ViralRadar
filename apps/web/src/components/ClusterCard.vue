<script setup lang="ts">
import { computed } from 'vue';
import type { Cluster } from '@/api/types';
import { SOURCE_ICON, useFormat } from '@/composables/useFormat';
import { useCodeLabel } from '@/composables/useCodes';
import { openClusterId } from '@/composables/useRadar';
import StateChip from './StateChip.vue';
import ScoreDial from './ScoreDial.vue';

const props = defineProps<{ cluster: Cluster; clickable?: boolean }>();
const { num, ago, percent } = useFormat();
const label = useCodeLabel();

const keywords = computed(() => props.cluster.keywords.slice(0, 6));

function open(): void {
  if (props.clickable !== false) openClusterId.value = props.cluster.id;
}
</script>

<template>
  <v-card class="cluster-card" hover @click="open">
    <div class="pa-3">
      <div class="d-flex align-start ga-2">
        <div class="flex-1-1 min-width-0">
          <div class="d-flex flex-wrap align-center ga-1 mb-1">
            <StateChip :state="cluster.state" />
            <v-chip size="x-small" variant="tonal" color="primary" prepend-icon="mdi-earth">
              {{ $t('clusters.platforms', { n: cluster.platformCount }) }}
            </v-chip>
            <v-chip size="x-small" variant="text" class="faint">
              {{ $t('clusters.posts', { n: cluster.itemCount }) }}
            </v-chip>
            <span class="meta faint">{{ ago(cluster.firstSeenAt) }}</span>
          </div>

          <div class="label">{{ cluster.label }}</div>
          <p v-if="cluster.explanation" class="explanation">{{ cluster.explanation }}</p>

          <div class="d-flex flex-wrap ga-1 mt-2">
            <v-chip v-for="k in keywords" :key="k" size="x-small" variant="outlined" class="faint">
              {{ k }}
            </v-chip>
          </div>

          <div class="d-flex flex-wrap ga-1 mt-2">
            <v-chip
              v-for="s in cluster.sources"
              :key="s"
              size="x-small"
              variant="tonal"
              :prepend-icon="SOURCE_ICON[s] ?? 'mdi-web'"
            >
              {{ s }}
            </v-chip>
          </div>

          <div class="d-flex flex-wrap ga-3 mt-2">
            <span class="stat">
              <b>{{ cluster.velocity ?? 0 }}</b> {{ $t('detail.postsPerHour') }}
            </span>
            <span v-if="cluster.totalViews !== null" class="stat">
              <b>{{ num(cluster.totalViews) }}</b> {{ $t('metric.views') }}
            </span>
            <span v-if="cluster.languages.length" class="stat faint">
              {{ cluster.languages.slice(0, 3).map((l) => `${label.language(l.code)} ${l.pct}%`).join(' · ') }}
            </span>
            <span class="stat faint">{{ $t('metric.confidence') }} {{ percent(cluster.confidence) }}</span>
          </div>
        </div>

        <ScoreDial :score="cluster.score" :confidence="cluster.confidence" :state="cluster.state" />
      </div>
    </div>
  </v-card>
</template>

<style scoped>
.cluster-card {
  cursor: pointer;
  transition: border-color 0.15s ease;
}
.cluster-card:hover {
  border-color: rgb(var(--v-theme-primary));
}
.min-width-0 {
  min-width: 0;
}
.label {
  font-size: 0.95rem;
  font-weight: 650;
  line-height: 1.35;
}
.explanation {
  font-size: 0.78rem;
  color: rgb(var(--v-theme-on-surface-variant));
  margin: 4px 0 0;
}
.meta,
.stat {
  font-size: 0.75rem;
  color: rgb(var(--v-theme-on-surface-variant));
  font-variant-numeric: tabular-nums;
}
.stat b {
  color: rgb(var(--v-theme-on-surface));
  font-weight: 600;
}
.faint {
  opacity: 0.75;
}
</style>
