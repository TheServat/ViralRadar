<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, query } from '@/api/client';
import type { CreatorReport, TrendItem } from '@/api/types';
import { useAsync } from '@/composables/useRadar';
import { SOURCE_ICON, useFormat } from '@/composables/useFormat';
import TrendCard from '@/components/TrendCard.vue';
import SectionHeader from '@/components/SectionHeader.vue';

const hours = ref(168);
const sort = ref<'best' | 'breakouts' | 'items'>('best');
const { num, exact } = useFormat();
const { t } = useI18n();

const breakoutQuery = computed(() => query({ limit: 30, hours: hours.value }));
const creatorQuery = computed(() => query({ limit: 100, hours: hours.value, sort: sort.value }));

const breakouts = useAsync<{ items: TrendItem[] }>(
  () => api.breakouts(breakoutQuery.value),
  () => breakoutQuery.value,
);
const creators = useAsync<{ items: CreatorReport[] }>(
  () => api.creators(creatorQuery.value),
  () => creatorQuery.value,
);

const windows = computed(() => [
  { value: 24, title: '24h' },
  { value: 72, title: '72h' },
  { value: 168, title: '7d' },
  { value: 720, title: '30d' },
]);

const sorts = computed(() => [
  { value: 'best', title: 'sortBest' },
  { value: 'breakouts', title: 'sortBreakouts' },
  { value: 'items', title: 'sortItems' },
]);

const headers = computed(() => [
  { title: t('creators.name'), key: 'name', sortable: false },
  { title: t('creators.source'), key: 'source', width: 120 },
  { title: t('creators.followers'), key: 'followers', align: 'end' as const, width: 120 },
  { title: t('creators.normal'), key: 'median_metric', align: 'end' as const, width: 130 },
  { title: t('creators.items'), key: 'items', align: 'end' as const, width: 90 },
  { title: t('creators.best'), key: 'best_score', align: 'end' as const, width: 110 },
  { title: t('creators.breakoutCount'), key: 'breakouts', align: 'end' as const, width: 110 },
]);
</script>

<template>
  <div>
    <SectionHeader :title="$t('creators.title')" icon="mdi-account-star">
      <template #actions>
        <v-btn-toggle v-model="hours" density="compact" mandatory variant="outlined" divided>
          <v-btn v-for="w in windows" :key="w.value" :value="w.value" size="small">{{ w.title }}</v-btn>
        </v-btn-toggle>
      </template>
    </SectionHeader>

    <section class="mb-8">
      <SectionHeader
        :title="$t('creators.breakouts')"
        :hint="$t('creators.breakoutsHint')"
        :count="breakouts.data.value?.items.length ?? 0"
        icon="mdi-rocket-launch"
      />
      <v-progress-linear v-if="breakouts.loading.value" indeterminate color="primary" class="mb-3" />
      <v-row v-if="breakouts.data.value?.items.length" dense>
        <v-col v-for="item in breakouts.data.value.items" :key="item.id" cols="12" md="6" xl="4">
          <TrendCard :item="item" />
        </v-col>
      </v-row>
      <v-alert v-else-if="!breakouts.loading.value" type="info" variant="tonal">
        {{ $t('creators.emptyBreakouts') }}
      </v-alert>
    </section>

    <section>
      <SectionHeader
        :title="$t('creators.leaderboard')"
        :hint="$t('creators.leaderboardHint')"
        :count="creators.data.value?.items.length ?? 0"
        icon="mdi-podium"
      >
        <template #actions>
          <v-btn-toggle v-model="sort" density="compact" mandatory variant="outlined" divided>
            <v-btn v-for="s in sorts" :key="s.value" :value="s.value" size="small">
              {{ $t(`creators.${s.title}`) }}
            </v-btn>
          </v-btn-toggle>
        </template>
      </SectionHeader>

      <v-progress-linear v-if="creators.loading.value" indeterminate color="primary" class="mb-3" />
      <v-card v-if="creators.data.value?.items.length">
        <v-data-table
          :items="creators.data.value.items"
          :headers="headers"
          :items-per-page="50"
          density="comfortable"
          hover
        >
          <template #item.name="{ item }">
            <a v-if="item.url" :href="item.url" target="_blank" rel="noreferrer noopener" class="creator-name">
              {{ item.name ?? item.external_id }}
            </a>
            <span v-else class="creator-name">{{ item.name ?? item.external_id }}</span>
          </template>
          <template #item.source="{ item }">
            <v-chip size="x-small" variant="text" :prepend-icon="SOURCE_ICON[item.source] ?? 'mdi-web'">
              {{ item.source }}
            </v-chip>
          </template>
          <template #item.followers="{ item }">
            <span class="tabular">{{ num(item.followers) }}</span>
          </template>
          <template #item.median_metric="{ item }">
            <span class="tabular">{{ num(item.median_metric) }}</span>
            <div class="sub">{{ $t('detail.postsObserved', { n: item.sample_count }) }}</div>
          </template>
          <template #item.items="{ item }">
            <span class="tabular">{{ exact(item.items) }}</span>
          </template>
          <template #item.best_score="{ item }">
            <b class="tabular">{{ item.best_score === null ? '—' : Math.round(item.best_score) }}</b>
            <div class="sub">{{ item.avg_score === null ? '' : Math.round(item.avg_score) }}</div>
          </template>
          <template #item.breakouts="{ item }">
            <v-chip v-if="item.breakouts > 0" size="x-small" color="VIRAL" variant="tonal">
              {{ item.breakouts }}
            </v-chip>
            <span v-else class="faint">—</span>
          </template>
        </v-data-table>
      </v-card>
      <v-alert v-else-if="!creators.loading.value" type="info" variant="tonal">
        {{ $t('creators.empty') }}
      </v-alert>
    </section>
  </div>
</template>

<style scoped>
.tabular {
  font-variant-numeric: tabular-nums;
}
.creator-name {
  font-size: 0.85rem;
  font-weight: 600;
  color: inherit;
  text-decoration: none;
}
.creator-name:hover {
  color: rgb(var(--v-theme-primary));
}
.sub {
  font-size: 0.68rem;
  color: rgb(var(--v-theme-on-surface-variant));
}
.faint {
  opacity: 0.5;
}
</style>
