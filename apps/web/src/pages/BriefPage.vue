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
import { api, authEpoch, query } from '@/api/client';
import type { Cluster, MissedItem, TrendItem } from '@/api/types';
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
  // `authEpoch` alongside the filters, for the same reason `useAsync` watches
  // it: on a deployment with API_TOKEN set these both 401 before a token is
  // supplied, and nothing here would ever ask again. The section this feeds is
  // hidden entirely while `matchingOn` is false, so it stayed hidden for the
  // rest of the visit even though the data behind it had arrived.
  [languages, countries, sources, maxAgeHours, authEpoch],
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

// ── For this channel ──────────────────────────────────────────────────────
//
// The rest of this page answers "what is happening". This answers "which of it
// is mine", which is the question that actually decides what gets made.
//
// Filtered by closeness to the channel description and ordered by score, never
// ordered by closeness: the closest items to a description of what you make are
// reliably things nobody is watching, because a hashtag-stuffed clip matches a
// description of the subject better than a real video about it does.
const MATCH_LEVELS = [0.4, 0.5, 0.6];
const minMatch = ref(0.5);

const forYouQuery = computed(() =>
  query({
    limit: 24,
    minRelevance: minMatch.value,
    sort: 'score',
    maxAgeHours: maxAgeHours.value,
    lang: languages.value.length > 0 ? languages.value.join(',') : 'all',
    country: countries.value.join(','),
    source: sources.value.join(','),
  }),
);

const forYou = useAsync<{ items: TrendItem[] }>(
  () => api.trends(forYouQuery.value),
  () => forYouQuery.value,
);

const forYouItems = computed(() =>
  (forYou.data.value?.items ?? []).filter((i) => !hiddenNow.value.has(i.id)),
);

/** Whether there is anything to match against at all. */
const matchingOn = ref(true);

/**
 * How many items clear each bar.
 *
 * The same idea as the platform buttons above: an empty result should explain
 * itself. "Nothing at 60%, eleven at 40%" tells you to lower the bar; an empty
 * list with no numbers just looks broken.
 */
const matchCounts = ref<Record<string, number> | null>(null);

/**
 * How much of the corpus has actually been compared against the description.
 *
 * Matching is an embedding job that runs on its own schedule, so an item can
 * be too new to have been scored - and those are deliberately kept rather than
 * dropped, because "not measured yet" is not "does not match". That design is
 * right and documented; what was wrong was saying nothing about it. The
 * caption promised "at least a {match}% match", and on the live database two
 * of the twelve cards shown had never been measured against anything.
 *
 * The API already returns this. It was fetched and thrown away.
 */
const matchCoverage = ref<{ scored: number; total: number } | null>(null);

watch(
  // `authEpoch` alongside the filters, for the same reason `useAsync` watches
  // it: on a deployment with API_TOKEN set these both 401 before a token is
  // supplied, and nothing here would ever ask again. The section this feeds is
  // hidden entirely while `matchingOn` is false, so it stayed hidden for the
  // rest of the visit even though the data behind it had arrived.
  [languages, countries, sources, maxAgeHours, authEpoch],
  async () => {
    try {
      const status = await api.interests();
      matchingOn.value = status.enabled;
      matchCoverage.value = status.coverage;
      if (!status.enabled) {
        matchCounts.value = null;
        return;
      }
    } catch {
      matchingOn.value = false;
      matchCoverage.value = null;
      return;
    }
    // One row each: the answer wanted is `total`, which counts the filter
    // rather than the page, so there is no reason to transfer the items.
    const base = {
      limit: 1,
      sort: 'score',
      maxAgeHours: maxAgeHours.value,
      lang: languages.value.length > 0 ? languages.value.join(',') : 'all',
      country: countries.value.join(','),
      source: sources.value.join(','),
    };
    try {
      const results = await Promise.all(
        MATCH_LEVELS.map((level) => api.trends(query({ ...base, minRelevance: level }))),
      );
      matchCounts.value = Object.fromEntries(
        MATCH_LEVELS.map((level, i) => [String(level), results[i]?.total ?? 0]),
      );
    } catch {
      matchCounts.value = null;
    }
  },
  { immediate: true, deep: true },
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

    <!-- The only section on this page that is about this channel rather than
         about the internet, so it is kept whole rather than mixed into the
         topics above. -->
    <template v-if="matchingOn">
      <SectionHeader
        :title="$t('brief.forYou')"
        :hint="$t('brief.forYouHint')"
        :count="forYouItems.length"
        icon="mdi-account-star-outline"
        class="mt-8"
      >
        <template #actions>
          <v-btn-toggle v-model="minMatch" density="compact" mandatory variant="outlined" divided>
            <v-btn v-for="level in MATCH_LEVELS" :key="level" :value="level" size="small">
              {{ Math.round(level * 100) }}%
              <span v-if="matchCounts" class="count-badge">{{ matchCounts[String(level)] ?? 0 }}</span>
            </v-btn>
          </v-btn-toggle>
        </template>
      </SectionHeader>

      <p class="explain mb-3">
        {{ $t('brief.forYouOrder') }}
        <!-- Said next to the list, the way the thumbnail page says how many
             images it managed to measure. An item too new to have been scored
             is kept rather than dropped, which is right - and silently
             including it under a caption that promises a match floor is not. -->
        <span v-if="matchCoverage && matchCoverage.scored < matchCoverage.total" class="faint">
          {{ $t('brief.forYouCoverage', {
            scored: matchCoverage.scored,
            total: matchCoverage.total,
          }) }}
        </span>
      </p>

      <v-progress-linear v-if="forYou.loading.value" indeterminate color="primary" class="mb-3" />
      <v-alert v-else-if="forYouItems.length === 0" type="info" variant="tonal" class="mb-3">
        {{ $t('brief.forYouEmpty', { match: Math.round(minMatch * 100) }) }}
        <div v-if="matchCounts && (matchCounts['0.4'] ?? 0) > 0 && minMatch > 0.4" class="mt-2">
          <v-btn size="small" variant="tonal" @click="minMatch = 0.4">
            {{ $t('brief.forYouLower', { n: matchCounts['0.4'] }) }}
          </v-btn>
        </div>
      </v-alert>
      <v-row v-else dense>
        <v-col v-for="item in forYouItems" :key="item.id" cols="12" md="6" xl="4">
          <TrendCard :item="item" show-match />
        </v-col>
      </v-row>
    </template>

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
