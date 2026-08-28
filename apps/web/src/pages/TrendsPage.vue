<script setup lang="ts">
import { computed, ref } from 'vue';
import { api, query } from '@/api/client';
import type { Page, TrendItem } from '@/api/types';
import { hiddenNow, openContentId, restoredNow, useAsync } from '@/composables/useRadar';
import { useFormat } from '@/composables/useFormat';
import { useCodeLabel } from '@/composables/useCodes';
import FilterBar, { type FilterValues } from '@/components/FilterBar.vue';
import TrendCard from '@/components/TrendCard.vue';
import SectionHeader from '@/components/SectionHeader.vue';
import StateChip from '@/components/StateChip.vue';

const showHidden = ref(false);

const filters = ref<FilterValues>({
  source: [],
  lang: [],
  country: [],
  type: [],
  state: [],
  minScore: null,
  q: '',
  sort: 'score',
});

const view = ref<'grid' | 'table'>('grid');
const limit = ref(60);
const { num } = useFormat();
const label = useCodeLabel();

const q = computed(() =>
  query({
    archived: showHidden.value ? 'only' : 'hide',
    source: filters.value.source.join(','),
    // `all` rather than empty: an empty value would fall back to the configured
    // LANGUAGES preference instead of clearing it.
    lang: filters.value.lang.length > 0 ? filters.value.lang.join(',') : 'all',
    country: filters.value.country.join(','),
    type: filters.value.type.join(','),
    state: filters.value.state.join(','),
    minScore: filters.value.minScore ?? undefined,
    q: filters.value.q,
    sort: filters.value.sort,
    limit: limit.value,
  }),
);

const { data, loading, error } = useAsync<Page<TrendItem>>(
  () => api.trends(q.value),
  () => q.value,
);

// Anything hidden this session disappears immediately, without waiting for a
// reload. The server already excludes archived items from the next fetch.
/**
 * The server already applies the archive filter; this only removes rows the
 * user changed since the fetch, so a click takes effect immediately without
 * reloading the list.
 */
const items = computed(() => {
  const rows = data.value?.items ?? [];
  return showHidden.value
    ? rows.filter((i) => !restoredNow.value.has(i.id))
    : rows.filter((i) => !hiddenNow.value.has(i.id));
});

const headers = computed(() => [
  { title: '#', key: 'score', align: 'end' as const, width: 80 },
  { title: '', key: 'state', width: 130, sortable: false },
  { title: '', key: 'title', sortable: false },
  { title: '', key: 'source', width: 130 },
  { title: '', key: 'value', align: 'end' as const, width: 110 },
  { title: '', key: 'velocity', align: 'end' as const, width: 110 },
]);
</script>

<template>
  <div>
    <SectionHeader :title="$t('nav.trends')" :hint="$t('filters.searchHint')" :count="items.length">
      <template #actions>
        <v-btn
          size="small"
          :variant="showHidden ? 'tonal' : 'text'"
          :color="showHidden ? 'primary' : undefined"
          :prepend-icon="showHidden ? 'mdi-eye-outline' : 'mdi-eye-off-outline'"
          class="me-2"
          @click="showHidden = !showHidden"
        >
          {{ showHidden ? $t('archive.onlyHidden') : $t('archive.show') }}
        </v-btn>

        <!-- A link, not a fetch: the browser handles the download and keeps
             the filename the server chose. -->
        <v-menu>
          <template #activator="{ props: menu }">
            <v-btn
              v-bind="menu"
              size="small"
              variant="text"
              prepend-icon="mdi-download-outline"
              class="me-2"
            >
              {{ $t('export.button') }}
            </v-btn>
          </template>
          <v-list density="compact">
            <v-list-item
              :href="api.exportUrl(`${q}&format=csv&limit=1000`)"
              prepend-icon="mdi-file-delimited-outline"
              :title="$t('export.csv')"
              :subtitle="$t('export.csvHint')"
            />
            <v-list-item
              :href="api.exportUrl(`${q}&format=json&limit=1000`)"
              prepend-icon="mdi-code-json"
              :title="$t('export.json')"
              :subtitle="$t('export.jsonHint')"
            />
          </v-list>
        </v-menu>
        <v-btn-toggle v-model="view" density="compact" mandatory variant="outlined" divided>
          <v-btn value="grid" icon="mdi-view-grid-outline" size="small" />
          <v-btn value="table" icon="mdi-table" size="small" />
        </v-btn-toggle>
      </template>
    </SectionHeader>

    <FilterBar v-model="filters" />

    <v-progress-linear v-if="loading" indeterminate color="primary" class="mb-3" />
    <v-alert v-if="error" type="error" variant="tonal">{{ $t('app.error', { message: error }) }}</v-alert>
    <v-alert v-if="!loading && !error && items.length === 0" type="info" variant="tonal">
      {{ $t('dashboard.empty') }}
    </v-alert>

    <v-row v-if="view === 'grid'" dense>
      <v-col v-for="item in items" :key="item.id" cols="12" md="6" xl="4">
        <TrendCard :item="item" :hidden="showHidden" />
      </v-col>
    </v-row>

    <v-card v-else-if="items.length">
      <v-data-table
        :items="items"
        :headers="headers"
        :items-per-page="100"
        density="comfortable"
        hover
        class="trend-table"
      >
        <template #item.score="{ item }">
          <b class="tabular">{{ Math.round(item.score) }}</b>
        </template>
        <template #item.state="{ item }">
          <StateChip :state="item.state" />
        </template>
        <template #item.title="{ item }">
          <div class="row-title" @click="openContentId = item.id">
            {{ item.title }}
            <div class="row-sub">
              <span v-if="item.creator.name">{{ item.creator.name }}</span>
              <span v-if="item.language.code"> · {{ label.language(item.language.code) }}</span>
              <span v-if="item.country.code"> · {{ label.country(item.country.code) }}</span>
            </div>
          </div>
        </template>
        <template #item.source="{ item }">
          <span class="text-caption">{{ item.source }}</span>
        </template>
        <template #item.value="{ item }">
          <span class="tabular">{{ num(item.metrics.primary.value) }}</span>
        </template>
        <template #item.velocity="{ item }">
          <span class="tabular text-accent">{{ num(item.signals.velocity) }}</span>
        </template>
      </v-data-table>
    </v-card>

    <div v-if="data?.nextOffset !== null && items.length > 0" class="text-center mt-4">
      <v-btn variant="tonal" @click="limit += 60">{{ $t('app.showMore') }}</v-btn>
    </div>
  </div>
</template>

<style scoped>
.tabular {
  font-variant-numeric: tabular-nums;
}
.row-title {
  cursor: pointer;
  font-size: 0.85rem;
  line-height: 1.3;
}
.row-sub {
  font-size: 0.7rem;
  color: rgb(var(--v-theme-on-surface-variant));
}
</style>
