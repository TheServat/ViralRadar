<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { SourceInfo } from '@/api/types';
import { notify, refreshHealth, useAsync } from '@/composables/useRadar';
import { SOURCE_ICON, useFormat } from '@/composables/useFormat';
import SectionHeader from '@/components/SectionHeader.vue';

const { data, loading, error, reload } = useAsync<{ items: SourceInfo[] }>(() => api.sources());
const { num, percent, ago } = useFormat();
const { t } = useI18n();
const router = useRouter();
const running = ref<string | null>(null);

const STATUS_COLOR: Record<string, string> = {
  UP: 'success',
  DEGRADED: 'warning',
  RATE_LIMITED: 'warning',
  AUTH_REQUIRED: 'error',
  CAPTCHA_REQUIRED: 'error',
  BLOCKED: 'error',
  ERROR: 'error',
  CONFIGURATION_REQUIRED: 'warning',
  DISABLED: 'on-surface-variant',
};

async function run(id: string): Promise<void> {
  running.value = id;
  try {
    const result = await api.runSource(id);
    notify(
      result.ok
        ? t('sources.ran', { source: result.source, n: result.items })
        : t('sources.failed', { source: result.source, error: result.error ?? '' }),
    );
    await Promise.all([reload(), refreshHealth()]);
  } catch (e) {
    // Without this the button simply stops looking busy and nothing
    // else happens. Vue logs it to the console, which is not where
    // the person who pressed it is looking.
    notify(t('app.error', { message: e instanceof Error ? e.message : String(e) }));
  } finally {
    running.value = null;
  }
}
</script>

<template>
  <div>
    <SectionHeader :title="$t('sources.title')" :hint="$t('sources.hint')" icon="mdi-power-plug-outline" />

    <v-progress-linear v-if="loading" indeterminate color="primary" class="mb-3" />
    <v-alert v-if="error" type="error" variant="tonal">{{ $t('app.error', { message: error }) }}</v-alert>

    <v-row v-if="data" dense>
      <v-col v-for="source in data.items" :key="source.id" cols="12" lg="6">
        <v-card class="h-100">
          <div class="pa-4">
            <div class="d-flex align-center ga-2 mb-2">
              <v-icon :icon="SOURCE_ICON[source.id] ?? 'mdi-web'" size="20" />
              <div class="flex-1-1">
                <div class="name">{{ source.name }}</div>
                <div class="version">{{ source.id }} · v{{ source.version }}</div>
              </div>
              <v-chip
                size="small"
                variant="tonal"
                :color="STATUS_COLOR[source.status] ?? 'on-surface-variant'"
              >
                {{ source.status }}
              </v-chip>
            </div>

            <p class="message">{{ source.message }}</p>

            <div class="d-flex flex-wrap ga-1 my-3">
              <v-chip size="x-small" variant="outlined">
                {{ $t('sources.primary', { metric: source.capabilities.primaryMetric }) }}
              </v-chip>
              <v-chip
                v-for="m in source.capabilities.metrics"
                :key="m"
                size="x-small"
                variant="tonal"
                color="primary"
              >
                {{ m }}
              </v-chip>
              <v-chip v-if="source.capabilities.metrics.length === 0" size="x-small" variant="text" class="faint">
                {{ $t('sources.noMetrics') }}
              </v-chip>
            </div>

            <div class="d-flex flex-wrap ga-1 mb-3">
              <v-chip v-if="source.capabilities.supportsTrending" size="x-small" variant="text" prepend-icon="mdi-fire">
                {{ $t('capability.trending') }}
              </v-chip>
              <v-chip v-if="source.capabilities.supportsSearch" size="x-small" variant="text" prepend-icon="mdi-magnify">
                {{ $t('capability.search') }}
              </v-chip>
              <v-chip v-if="source.capabilities.supportsRefresh" size="x-small" variant="text" prepend-icon="mdi-refresh">
                {{ $t('capability.refresh') }}
              </v-chip>
              <v-chip v-if="source.capabilities.hasAuthor" size="x-small" variant="text" prepend-icon="mdi-account">
                {{ $t('capability.author') }}
              </v-chip>
              <v-chip v-if="source.capabilities.hasCountry" size="x-small" variant="text" prepend-icon="mdi-map-marker">
                {{ $t('capability.country') }}
              </v-chip>
            </div>

            <v-divider class="mb-3" />

            <div v-if="source.health" class="d-flex flex-wrap ga-4 mb-3">
              <span class="stat">
                <b>{{ num(source.health.itemsLastRun) }}</b> {{ $t('sources.lastRun') }}
              </span>
              <span class="stat">{{ $t('sources.total', { n: num(source.health.totalItems) }) }}</span>
              <span class="stat">
                {{ $t('sources.reliability', { value: percent(source.health.reliability, 0) }) }}
              </span>
              <span class="stat faint">{{ ago(source.health.lastOkAt) }}</span>
            </div>
            <div v-else class="stat faint mb-3">{{ $t('sources.neverRun') }}</div>

            <div v-if="source.health?.lastError" class="error-line mb-3">
              {{ source.health.lastError }}
            </div>

            <div class="d-flex ga-2 align-center">
              <v-btn
                v-if="source.configured"
                size="small"
                :loading="running === source.id"
                prepend-icon="mdi-play"
                @click="run(source.id)"
              >
                {{ $t('sources.runNow') }}
              </v-btn>
              <v-btn
                v-else
                size="small"
                color="primary"
                prepend-icon="mdi-cog"
                @click="router.push('/settings')"
              >
                {{ $t('sources.configure') }}
              </v-btn>
              <v-btn
                v-if="source.helpUrl"
                size="small"
                variant="text"
                :href="source.helpUrl"
                target="_blank"
                rel="noreferrer noopener"
                append-icon="mdi-open-in-new"
              >
                {{ $t('settings.getIt') }}
              </v-btn>
            </div>
          </div>
        </v-card>
      </v-col>
    </v-row>
  </div>
</template>

<style scoped>
.name {
  font-size: 0.92rem;
  font-weight: 650;
}
.version {
  font-size: 0.68rem;
  color: rgb(var(--v-theme-on-surface-variant));
  font-family: ui-monospace, monospace;
}
.message {
  font-size: 0.8rem;
  color: rgb(var(--v-theme-on-surface-variant));
  margin: 0;
  line-height: 1.5;
}
.stat {
  font-size: 0.75rem;
  color: rgb(var(--v-theme-on-surface-variant));
}
.stat b {
  color: rgb(var(--v-theme-on-surface));
}
.error-line {
  font-size: 0.72rem;
  font-family: ui-monospace, monospace;
  color: rgb(var(--v-theme-error));
  background: rgba(var(--v-theme-error), 0.08);
  padding: 6px 8px;
  border-radius: 6px;
  word-break: break-word;
}
.faint {
  opacity: 0.7;
}
</style>
