<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, query } from '@/api/client';
import type { HealthData, Intervention, RadarEvent } from '@/api/types';
import { interventions, notify, refreshHealth, refreshInterventions, useAsync } from '@/composables/useRadar';
import { useFormat } from '@/composables/useFormat';
import SectionHeader from '@/components/SectionHeader.vue';
import StatTile from '@/components/StatTile.vue';

const { num, ago, dateTime } = useFormat();
const { t } = useI18n();

const health = useAsync<HealthData>(() => api.health());
const events = useAsync<{ items: RadarEvent[] }>(() => api.events(query({ limit: 80 })));

const tiles = computed(() => {
  const h = health.data.value;
  if (!h) return [];
  return [
    { label: t('system.contentStored'), value: num(h.db.content), tooltip: t('tips.contentStored'), icon: 'mdi-database' },
    { label: t('system.snapshots'), value: num(h.db.metrics), tooltip: t('tips.snapshots'), icon: 'mdi-chart-timeline-variant' },
    { label: t('system.topics'), value: num(h.db.clusters), tooltip: t('tips.topics'), icon: 'mdi-shape-outline' },
    { label: t('system.creators'), value: num(h.db.creators), tooltip: t('tips.creators'), icon: 'mdi-account-multiple' },
    { label: t('system.lastCollection'), value: ago(h.lastDiscovery), tooltip: t('tips.lastCollection'), icon: 'mdi-download' },
    { label: t('system.lastAnalysis'), value: ago(h.lastAnalysis), tooltip: t('tips.lastAnalysis'), icon: 'mdi-calculator-variant' },
  ];
});

async function resolve(item: Intervention): Promise<void> {
  await api.resolveIntervention(item.id);
  await refreshInterventions();
}

async function analyzeNow(): Promise<void> {
  await api.analyze();
  notify(t('system.analyzeNow'));
  await Promise.all([refreshHealth(), health.reload()]);
}

const EVENT_COLOR: Record<string, string> = {
  'trend.detected': 'VIRAL',
  'trend.peaked': 'PEAK',
  'creator.breakout': 'HOT',
  'source.error': 'error',
  'manual.intervention.required': 'warning',
  'content.discovered': 'on-surface-variant',
  'settings.updated': 'primary',
};
</script>

<template>
  <div>
    <SectionHeader
      :title="$t('system.title')"
      :hint="health.data.value ? $t('system.scoringVersion', { version: health.data.value.scoringVersion }) : ''"
      icon="mdi-heart-pulse"
    >
      <template #actions>
        <v-btn size="small" prepend-icon="mdi-calculator-variant" @click="analyzeNow">
          {{ $t('system.analyzeNow') }}
        </v-btn>
      </template>
    </SectionHeader>

    <v-row dense class="mb-5">
      <v-col v-for="tile in tiles" :key="tile.label" cols="6" sm="4" md="2">
        <StatTile v-bind="tile" />
      </v-col>
    </v-row>

    <section class="mb-6">
      <SectionHeader
        :title="$t('system.intervention')"
        :hint="$t('system.interventionHint')"
        :count="interventions.length"
        icon="mdi-hand-back-right-outline"
      />
      <v-alert v-if="interventions.length === 0" type="success" variant="tonal" density="comfortable">
        {{ $t('system.nothingNeeded') }}
      </v-alert>
      <v-card v-for="item in interventions" :key="item.id" class="mb-2">
        <div class="pa-3 d-flex flex-wrap align-center ga-3">
          <v-chip size="small" color="warning" variant="tonal">{{ item.type }}</v-chip>
          <b class="text-body-2">{{ item.source }}</b>
          <span class="flex-1-1 text-caption">{{ item.message }}</span>
          <v-btn
            v-if="item.url"
            size="small"
            variant="text"
            :href="item.url"
            target="_blank"
            rel="noreferrer noopener"
            append-icon="mdi-open-in-new"
          >
            {{ $t('app.open') }}
          </v-btn>
          <v-btn size="small" @click="resolve(item)">{{ $t('app.done') }}</v-btn>
        </div>
      </v-card>
    </section>

    <section class="mb-6">
      <SectionHeader :title="$t('system.jobs')" icon="mdi-timer-outline" />
      <v-card v-if="health.data.value">
        <v-table density="comfortable">
          <thead>
            <tr>
              <th>{{ $t('system.job') }}</th>
              <th>{{ $t('system.interval') }}</th>
              <th>{{ $t('system.lastRunAt') }}</th>
              <th class="text-end">{{ $t('system.duration') }}</th>
              <th class="text-end">{{ $t('system.runs') }}</th>
              <th>{{ $t('system.status') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="job in health.data.value.jobs" :key="job.name">
              <td class="mono">{{ job.name }}</td>
              <td class="faint">{{ $t('system.everyMinutes', { n: Math.round(job.everyMs / 60000) }) }}</td>
              <td class="faint">{{ job.lastRunAt ? ago(job.lastRunAt) : '—' }}</td>
              <td class="text-end faint">{{ job.lastDurationMs ?? '—' }}ms</td>
              <td class="text-end faint">{{ job.runs }}</td>
              <td>
                <v-chip v-if="job.queued" size="x-small" color="primary" variant="tonal">{{ $t('system.queued') }}</v-chip>
                <span v-else-if="job.lastError" class="text-error text-caption">{{ job.lastError }}</span>
                <span v-else class="text-success text-caption">{{ $t('system.ok') }}</span>
              </td>
            </tr>
          </tbody>
        </v-table>
      </v-card>
    </section>

    <section v-if="health.data.value?.network.length" class="mb-6">
      <SectionHeader :title="$t('system.network')" icon="mdi-lan" />
      <v-card>
        <v-table density="comfortable">
          <thead>
            <tr>
              <th>{{ $t('system.host') }}</th>
              <th class="text-end">{{ $t('system.failures') }}</th>
              <th class="text-end">{{ $t('system.breaker') }}</th>
              <th class="text-end">{{ $t('system.cooldown') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="h in health.data.value.network" :key="h.host">
              <td class="mono">{{ h.host }}</td>
              <td class="text-end" :class="h.failures > 0 ? 'text-warning' : 'faint'">{{ h.failures }}</td>
              <td class="text-end" :class="h.openFor > 0 ? 'text-error' : 'faint'">
                {{ h.openFor > 0 ? $t('system.seconds', { n: h.openFor }) : '—' }}
              </td>
              <td class="text-end" :class="h.cooldownFor > 0 ? 'text-warning' : 'faint'">
                {{ h.cooldownFor > 0 ? $t('system.seconds', { n: h.cooldownFor }) : '—' }}
              </td>
            </tr>
          </tbody>
        </v-table>
      </v-card>
    </section>

    <section>
      <SectionHeader :title="$t('system.events')" icon="mdi-format-list-bulleted" />
      <v-card v-if="events.data.value">
        <v-table density="compact">
          <thead>
            <tr>
              <th>{{ $t('system.when') }}</th>
              <th>{{ $t('system.event') }}</th>
              <th>{{ $t('filters.source') }}</th>
              <th>{{ $t('system.detail') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(e, i) in events.data.value.items" :key="i">
              <td class="faint mono" :title="dateTime(e.ts)">{{ ago(e.ts) }}</td>
              <td>
                <v-chip size="x-small" variant="tonal" :color="EVENT_COLOR[e.type] ?? 'on-surface-variant'">
                  {{ e.type }}
                </v-chip>
              </td>
              <td class="faint">{{ e.source ?? '' }}</td>
              <td class="mono faint payload">{{ JSON.stringify(e.payload ?? {}) }}</td>
            </tr>
          </tbody>
        </v-table>
      </v-card>
    </section>
  </div>
</template>

<style scoped>
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.72rem;
}
.faint {
  color: rgb(var(--v-theme-on-surface-variant));
}
.payload {
  max-width: 40ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
