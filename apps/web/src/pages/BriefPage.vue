<script setup lang="ts">
/**
 * What to make today.
 *
 * The dashboard section answers this for the default audience; this page is
 * for asking it of a specific one. Every control here narrows which *posts* a
 * topic must contain, so "Persian topics" means topics with Persian posts in
 * them, not topics that happen to be mostly Persian.
 *
 * The platform threshold is the control that matters most. Topics carried by
 * several platforms are the strongest evidence something is really happening -
 * but for a language whose sources rarely share vocabulary there may be very
 * few, and single-platform topics are then the honest place to look.
 */
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, query } from '@/api/client';
import type { Cluster, MissedItem } from '@/api/types';
import { facets, hiddenNow, useAsync } from '@/composables/useRadar';
import { useCountryOptions, useLanguageOptions } from '@/composables/useCodes';
import { SOURCE_ICON } from '@/composables/useFormat';
import ClusterCard from '@/components/ClusterCard.vue';
import SectionHeader from '@/components/SectionHeader.vue';
import TrendCard from '@/components/TrendCard.vue';

const { t } = useI18n();

const languages = ref<string[]>([]);
const countries = ref<string[]>([]);
const sources = ref<string[]>([]);
const minSources = ref(1);
const minScore = ref(0);
const maxAgeHours = ref(48);
const sort = ref<'score' | 'recent' | 'platforms' | 'velocity'>('score');

const presentLanguages = computed(() => facets.value.languages);
const presentCountries = computed(() => facets.value.countries);
const languageOptions = useLanguageOptions(presentLanguages);
const countryOptions = useCountryOptions(presentCountries);
const sourceOptions = computed(() =>
  facets.value.sources.map((s) => ({ value: s.key, title: s.key, count: s.n })),
);

const q = computed(() =>
  query({
    limit: 60,
    minSources: minSources.value,
    minScore: minScore.value,
    maxAgeHours: maxAgeHours.value,
    sort: sort.value,
    // `all` rather than empty: an empty value would fall back to the configured
    // LANGUAGES preference instead of clearing it.
    lang: languages.value.length > 0 ? languages.value.join(',') : 'all',
    country: countries.value.join(','),
    source: sources.value.join(','),
  }),
);

const { data, loading, error } = useAsync<{ items: Cluster[] }>(
  () => api.clusters(q.value),
  () => q.value,
);

const items = computed(() => data.value?.items ?? []);

/**
 * How many topics exist at each platform threshold, so the reason a filter
 * came back empty is visible rather than something to guess at.
 */
const counts = ref<{ one: number; two: number; three: number } | null>(null);

watch(
  [languages, countries, sources, maxAgeHours],
  async () => {
    const base = {
      limit: 200,
      minScore: 0,
      maxAgeHours: maxAgeHours.value,
      lang: languages.value.length > 0 ? languages.value.join(',') : 'all',
      country: countries.value.join(','),
      source: sources.value.join(','),
    };
    try {
      const [one, two, three] = await Promise.all([
        api.clusters(query({ ...base, minSources: 1 })),
        api.clusters(query({ ...base, minSources: 2 })),
        api.clusters(query({ ...base, minSources: 3 })),
      ]);
      counts.value = { one: one.items.length, two: two.items.length, three: three.items.length };
    } catch {
      counts.value = null;
    }
  },
  { immediate: true, deep: true },
);

const platformChoices = computed(() => [
  { value: 1, title: t('brief.platform1'), n: counts.value?.one },
  { value: 2, title: t('brief.platform2'), n: counts.value?.two },
  { value: 3, title: t('brief.platform3'), n: counts.value?.three },
]);

const windows = [
  { value: 12, title: '12h' },
  { value: 24, title: '24h' },
  { value: 48, title: '48h' },
  { value: 168, title: '7d' },
];

const sorts = computed(() => [
  { value: 'score', title: t('sort.score') },
  { value: 'velocity', title: t('brief.sortVelocity') },
  { value: 'platforms', title: t('brief.sortPlatforms') },
  { value: 'recent', title: t('sort.recent') },
]);

function reset(): void {
  languages.value = [];
  countries.value = [];
  sources.value = [];
  minSources.value = 1;
  minScore.value = 0;
  maxAgeHours.value = 48;
}
// ── What you missed ───────────────────────────────────────────────────────
//
// A different question from the rest of this page. These already peaked, so
// they are not a plan — they are evidence about what worked here recently,
// which is exactly what you want after a few days away.
const missedDays = ref(7);
const missedQuery = computed(() =>
  query({
    hours: missedDays.value * 24,
    lang: languages.value.length > 0 ? languages.value.join(',') : 'all',
    country: countries.value.join(','),
    source: sources.value.join(','),
  }),
);
const missed = useAsync<{ items: MissedItem[] }>(
  () => api.missed(missedQuery.value),
  () => missedQuery.value,
);
const missedItems = computed(() =>
  (missed.data.value?.items ?? []).filter((i) => !hiddenNow.value.has(i.id)),
);
</script>


<template>
  <div>
    <SectionHeader
      :title="$t('dashboard.whatToMake')"
      :hint="$t('brief.hint')"
      :count="items.length"
      icon="mdi-lightbulb-on-outline"
    >
      <template #actions>
        <v-btn-toggle v-model="maxAgeHours" density="compact" mandatory variant="outlined" divided>
          <v-btn v-for="w in windows" :key="w.value" :value="w.value" size="small">{{ w.title }}</v-btn>
        </v-btn-toggle>
      </template>
    </SectionHeader>

    <v-card class="mb-4">
      <v-card-text class="py-3">
        <v-row dense align="center">
          <v-col cols="12" sm="6" md="3">
            <v-autocomplete
              v-model="languages"
              :items="languageOptions"
              :label="$t('filters.language')"
              multiple
              chips
              closable-chips
              clearable
              auto-select-first
            >
              <template #item="{ props: itemProps, item }">
                <v-list-item v-bind="itemProps">
                  <template #append>
                    <span v-if="item.count" class="text-caption text-primary">{{ item.count }}</span>
                  </template>
                </v-list-item>
              </template>
            </v-autocomplete>
          </v-col>

          <v-col cols="12" sm="6" md="3">
            <v-autocomplete
              v-model="countries"
              :items="countryOptions"
              :label="$t('filters.country')"
              multiple
              chips
              closable-chips
              clearable
              auto-select-first
            >
              <template #item="{ props: itemProps, item }">
                <v-list-item v-bind="itemProps">
                  <template #append>
                    <span v-if="item.count" class="text-caption text-primary">{{ item.count }}</span>
                  </template>
                </v-list-item>
              </template>
            </v-autocomplete>
          </v-col>

          <v-col cols="12" sm="6" md="3">
            <v-autocomplete
              v-model="sources"
              :items="sourceOptions"
              :label="$t('filters.source')"
              multiple
              chips
              closable-chips
              clearable
            >
              <template #item="{ props: itemProps, item }">
                <v-list-item v-bind="itemProps" :prepend-icon="SOURCE_ICON[item.value] ?? 'mdi-web'" />
              </template>
            </v-autocomplete>
          </v-col>

          <v-col cols="6" sm="3" md="2">
            <v-text-field
              v-model.number="minScore"
              type="number"
              min="0"
              max="100"
              step="5"
              :label="$t('filters.minScore')"
            />
          </v-col>

          <v-col cols="6" sm="3" md="1">
            <v-select v-model="sort" :items="sorts" :label="$t('filters.sort')" />
          </v-col>
        </v-row>

        <div class="d-flex flex-wrap align-center ga-2 mt-3">
          <span class="control-label">{{ $t('brief.platforms') }}</span>
          <v-btn-toggle v-model="minSources" density="compact" mandatory variant="outlined" divided>
            <v-btn v-for="choice in platformChoices" :key="choice.value" :value="choice.value" size="small">
              {{ choice.title }}
              <span v-if="choice.n !== undefined" class="count-badge">{{ choice.n }}</span>
            </v-btn>
          </v-btn-toggle>
          <v-spacer />
          <v-btn variant="text" size="small" prepend-icon="mdi-backspace-outline" @click="reset">
            {{ $t('filters.reset') }}
          </v-btn>
        </div>

        <p class="explain mt-2">{{ $t('brief.platformsHelp') }}</p>
      </v-card-text>
    </v-card>

    <v-progress-linear v-if="loading" indeterminate color="primary" class="mb-3" />
    <v-alert v-if="error" type="error" variant="tonal">{{ $t('app.error', { message: error }) }}</v-alert>

    <v-alert
      v-if="!loading && !error && items.length === 0"
      type="info"
      variant="tonal"
      class="mb-3"
    >
      {{ $t('brief.empty') }}
      <div v-if="counts && minSources > 1 && counts.one > 0" class="mt-2">
        <v-btn size="small" variant="tonal" @click="minSources = 1">
          {{ $t('brief.showSinglePlatform', { n: counts.one }) }}
        </v-btn>
      </div>
    </v-alert>

    <v-row dense>
      <v-col v-for="c in items" :key="c.id" cols="12" md="6" xl="4">
        <ClusterCard :cluster="c" />
      </v-col>
    </v-row>

    <!-- Already over, so kept apart from the plan above rather than mixed in. -->
    <SectionHeader
      :title="$t('missed.title')"
      :hint="$t('missed.hint')"
      :count="missedItems.length"
      icon="mdi-history"
      class="mt-8"
    >
      <template #actions>
        <v-btn-toggle v-model="missedDays" density="compact" mandatory variant="outlined" divided>
          <v-btn v-for="d in [3, 7, 14]" :key="d" :value="d" size="small">
            {{ $t('missed.window', { days: d }) }}
          </v-btn>
        </v-btn-toggle>
      </template>
    </SectionHeader>

    <v-progress-linear v-if="missed.loading.value" indeterminate color="primary" class="mb-3" />
    <p v-else-if="missedItems.length === 0" class="text-body-2 text-medium-emphasis">
      {{ $t('missed.empty') }}
    </p>
    <v-row v-else dense>
      <v-col v-for="item in missedItems" :key="item.id" cols="12" md="6" xl="4">
        <TrendCard :item="item" dense />
      </v-col>
    </v-row>
  </div>
</template>

<style scoped>
.control-label {
  font-size: 0.72rem;
  color: rgb(var(--v-theme-on-surface-variant));
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.count-badge {
  margin-inline-start: 6px;
  font-size: 0.68rem;
  opacity: 0.7;
  font-variant-numeric: tabular-nums;
}
.explain {
  font-size: 0.72rem;
  color: rgb(var(--v-theme-on-surface-variant));
  margin: 0;
  line-height: 1.6;
}
</style>
