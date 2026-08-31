<script setup lang="ts">
/**
 * What people are searching for and nothing here has covered.
 *
 * Two source groups compared rather than one analysed: searches on one side,
 * videos on the other. The interesting rows have demand on the left and
 * nothing on the right.
 *
 * Two things make this honest rather than a gap generator.
 *
 * The claim is scoped and repeated: a gap means nothing *this radar has
 * collected* is about the topic, not that nothing exists. And the closest thing
 * found is shown on every row with its score, whether or not it cleared the
 * bar — so a row reading "uncovered, closest 0.60: Breaking News, Quinn Ewers
 * traded" corrects itself in front of you, and a badly-set bar is visible
 * rather than silently manufacturing findings.
 *
 * The first thing the page checks is whether the two sides are even about the
 * same audience. Comparing American searches against Persian videos produces a
 * screen full of gaps that are really one wrong setting, and that is by far the
 * most likely way this page misleads somebody.
 */
import { computed, ref } from 'vue';
import { api, query } from '@/api/client';
import type { GapAnalysis, NicheAnalysis } from '@/api/types';
import { facets, useAsync } from '@/composables/useRadar';
import { useCountryOptions, useLanguageOptions } from '@/composables/useCodes';
import { useFormat } from '@/composables/useFormat';
import SectionHeader from '@/components/SectionHeader.vue';
import StatTile from '@/components/StatTile.vue';

const term = ref('');
/** Only what was actually submitted, so typing does not fire a request. */
const asked = ref('');

const lang = ref<string | null>(null);
const country = ref<string | null>(null);
const hours = ref(168);
const onlyGaps = ref(true);

const languageOptions = useLanguageOptions(computed(() => facets.value.languages));
const countryOptions = useCountryOptions(computed(() => facets.value.countries));
const WINDOWS = [72, 168, 336, 720];

const { data, loading, error } = useAsync<GapAnalysis>(
  () =>
    api.gaps(
      query({ q: asked.value, lang: lang.value, country: country.value, hours: hours.value }),
    ),
  () => [asked.value, lang.value, country.value, hours.value],
);

function search(): void {
  asked.value = term.value.trim();
}

function clearSearch(): void {
  term.value = '';
  asked.value = '';
}

/** One typed subject rather than the trending list. */
const answering = computed(() => (data.value?.asked ?? '') !== '');

const rows = computed(() => {
  const gaps = data.value?.gaps ?? [];
  // The filter is about scanning a list. A search returns one row and hiding
  // it because the answer was "covered" would be hiding the answer.
  return onlyGaps.value && !answering.value ? gaps.filter((g) => g.verdict !== 'covered') : gaps;
});

/**
 * Whether the two sides are about the same audience.
 *
 * The check is deliberately blunt: if the language most of the demand is in is
 * not the language most of the supply is in, every gap on the page is suspect
 * and nothing else it says matters until that is fixed.
 */
const mismatch = computed(() => {
  const d = data.value;
  if (d === undefined || d === null) return null;
  const demand = d.demandLanguages[0];
  const supply = d.supplyLanguages[0];
  if (demand === undefined || supply === undefined) return null;
  if (demand.key === supply.key) return null;
  // The same difference means opposite things depending on why it is there.
  // Watching one country and getting another language back is a setting
  // nobody meant; watching twenty and getting another language back is the
  // reason for watching twenty.
  return { demand, supply, deliberate: d.demandCountries > 3, countries: d.demandCountries };
});

// ── Openings ──────────────────────────────────────────────────────────────
//
// The other half of the same question. Gaps are searches with nothing against
// them; openings are subjects where small accounts already beat what their size
// predicts — which is where an unknown channel can actually land.
const niches = useAsync<NicheAnalysis>(
  () => api.niches(query({ lang: lang.value, hours: Math.max(hours.value, 720) })),
  () => [lang.value, hours.value],
);

const { num } = useFormat();

function verdictColour(verdict: string): string {
  return verdict === 'uncovered' ? 'error' : verdict === 'thin' ? 'warning' : 'success';
}
</script>

<template>
  <div>
    <SectionHeader :title="$t('gaps.title')" :hint="$t('gaps.hint')" icon="mdi-magnify-scan" />

    <v-card class="mb-4">
      <v-card-text class="py-3">
        <div class="d-flex flex-wrap ga-3 align-start">
          <v-text-field
            v-model="term"
            :label="$t('gaps.search')"
            :placeholder="$t('gaps.searchPlaceholder')"
            prepend-inner-icon="mdi-magnify"
            density="compact"
            variant="outlined"
            hide-details
            clearable
            style="min-width: 260px; flex: 1 1 260px"
            @keyup.enter="search"
            @click:clear="clearSearch"
          />
          <v-btn color="primary" size="large" prepend-icon="mdi-magnify-scan" @click="search">
            {{ $t('gaps.go') }}
          </v-btn>
          <v-btn v-if="answering" variant="text" size="large" @click="clearSearch">
            {{ $t('gaps.backToTrending') }}
          </v-btn>
        </div>
        <p class="explain mt-2">
          {{ answering ? $t('gaps.searchingHelp') : $t('gaps.trendingHelp') }}
        </p>
      </v-card-text>
    </v-card>

    <v-card class="mb-4">
      <v-card-text class="d-flex flex-wrap ga-3 align-center py-3">
        <v-autocomplete
          v-model="lang"
          :items="languageOptions"
          :label="$t('filters.language')"
          density="compact"
          variant="outlined"
          hide-details
          clearable
          style="min-width: 180px"
        />
        <v-autocomplete
          v-model="country"
          :items="countryOptions"
          :label="$t('filters.country')"
          density="compact"
          variant="outlined"
          hide-details
          clearable
          style="min-width: 180px"
        />
        <v-select
          v-model="hours"
          :items="WINDOWS.map((h) => ({ value: h, title: $t('formats.window', { days: Math.round(h / 24) }) }))"
          :label="$t('formats.windowLabel')"
          density="compact"
          variant="outlined"
          hide-details
          style="min-width: 160px"
        />
        <v-spacer />
        <v-switch
          v-if="!answering"
          v-model="onlyGaps"
          :label="$t('gaps.onlyGaps')"
          density="compact"
          hide-details
          color="primary"
        />
      </v-card-text>
    </v-card>

    <v-progress-linear v-if="loading" indeterminate color="primary" class="mb-3" />
    <v-alert v-if="error" type="error" variant="tonal">{{ $t('app.error', { message: error }) }}</v-alert>

    <template v-if="data">
      <!-- Before anything else: are these two sides even about each other? -->
      <v-alert
        v-if="mismatch && !answering"
        :type="mismatch.deliberate ? 'info' : 'warning'"
        variant="tonal"
        class="mb-4"
      >
        <div class="font-weight-medium">
          {{ mismatch.deliberate ? $t('gaps.arbitrageTitle') : $t('gaps.mismatchTitle') }}
        </div>
        <div class="mt-1">
          {{ mismatch.deliberate
            ? $t('gaps.arbitrageBody', {
                countries: mismatch.countries,
                demandLang: mismatch.demand.key,
                supplyLang: mismatch.supply.key,
              })
            : $t('gaps.mismatchBody', {
                demandLang: mismatch.demand.key,
                demandN: mismatch.demand.n,
                supplyLang: mismatch.supply.key,
                supplyN: mismatch.supply.n,
              }) }}
        </div>
        <v-btn
          v-if="!mismatch.deliberate"
          size="small"
          variant="tonal"
          class="mt-2"
          to="/settings"
          append-icon="mdi-arrow-right"
        >
          {{ $t('gaps.mismatchFix') }}
        </v-btn>
      </v-alert>

      <v-row dense class="mb-2">
        <v-col v-if="!answering" cols="6" md="3">
          <StatTile
            :label="$t('gaps.statSearched')"
            :value="data.topics"
            :hint="$t('gaps.statSearchedHelp')"
            icon="mdi-magnify"
          />
        </v-col>
        <v-col v-if="!answering" cols="6" md="3">
          <StatTile
            :label="$t('gaps.statUncovered')"
            :value="data.uncovered"
            :hint="$t('gaps.statUncoveredHelp')"
            icon="mdi-help-circle-outline"
          />
        </v-col>
        <v-col cols="6" md="3">
          <StatTile
            :label="$t('gaps.statChecked')"
            :value="data.supply"
            :hint="$t('gaps.statCheckedHelp')"
            icon="mdi-counter"
          />
        </v-col>
        <v-col cols="6" md="3">
          <StatTile
            :label="$t('gaps.statHow')"
            :value="data.matchedByMeaning ? $t('gaps.byMeaning') : $t('gaps.byWords')"
            :hint="data.matchedByMeaning
              ? $t('gaps.byMeaningHelp')
              : data.wordsBecause === 'unreachable'
                ? $t('gaps.byWordsUnreachable')
                : $t('gaps.byWordsHelp')"
            icon="mdi-vector-link"
          />
        </v-col>
      </v-row>

      <v-alert type="info" variant="tonal" density="compact" class="mb-4">
        {{ $t('gaps.scope') }}
      </v-alert>

      <v-alert v-if="rows.length === 0" type="info" variant="tonal">
        {{ $t('gaps.none') }}
      </v-alert>

      <v-card v-for="g in rows" :key="g.id" class="mb-2 gap-row">
        <div class="pa-3">
          <div class="d-flex flex-wrap align-center ga-2">
            <v-chip size="small" :color="verdictColour(g.verdict)" variant="tonal">
              {{ $t(`gaps.verdict.${g.verdict}`) }}
            </v-chip>
            <span class="topic">{{ g.topic }}</span>
            <!-- The number that separates a phenomenon from local news. -->
            <v-chip
              v-if="g.countries > 1"
              size="x-small"
              color="primary"
              variant="tonal"
              prepend-icon="mdi-earth"
            >
              {{ $t('gaps.inCountries', { n: g.countries }) }}
            </v-chip>
            <v-chip v-if="g.lang" size="x-small" variant="text" class="faint">{{ g.lang }}</v-chip>
            <v-spacer />
            <span class="score">{{ $t('metric.score') }} {{ g.score }}</span>
          </div>

          <!-- Always shown, cleared the bar or not. This is what lets a reader
               overrule the verdict instead of trusting it. -->
          <div v-if="g.matches.length" class="matches mt-2">
            <div class="matches-label">
              {{ g.covered > 0
                ? $t('gaps.coveredBy', { n: g.covered })
                : $t('gaps.closestAnyway') }}
            </div>
            <a
              v-for="m in g.matches"
              :key="m.id"
              :href="m.url"
              target="_blank"
              rel="noreferrer noopener"
              class="match"
            >
              <span class="sim" :class="{ over: m.similarity >= data.coveredAt }">
                {{ m.similarity.toFixed(2) }}
              </span>
              <span class="match-title">{{ m.title }}</span>
            </a>
          </div>
          <div v-else class="matches-label mt-2">{{ $t('gaps.nothingAtAll') }}</div>
        </div>
      </v-card>
    </template>

    <!-- ── Openings ─────────────────────────────────────────────────── -->
    <SectionHeader
      :title="$t('niches.title')"
      :hint="$t('niches.hint')"
      icon="mdi-sprout"
      class="mt-8"
    />

    <v-progress-linear v-if="niches.loading.value" indeterminate color="primary" class="mb-3" />

    <template v-if="niches.data.value">
      <!-- Said before the list, because without it the ranking is just
           "which subjects are made as shorts". -->
      <v-alert type="info" variant="tonal" density="compact" class="mb-3">
        <div>{{ $t('niches.scope') }}</div>
        <div class="text-caption mt-1">
          {{ $t('niches.baselines', {
            baselines: niches.data.value.formatBaselines
              .map((b) => `${b.key} ${b.perFollower}`).join(' · '),
          }) }}
        </div>
        <div v-if="niches.data.value.droppedForConcentration > 0" class="text-caption mt-1">
          {{ $t('niches.dropped', {
            n: niches.data.value.droppedForConcentration,
            channels: niches.data.value.minCreators,
          }) }}
        </div>
      </v-alert>

      <div class="table">
        <div class="row header">
          <div>{{ $t('niches.colSubject') }}</div>
          <div class="numeric">{{ $t('niches.colLift') }}</div>
          <div class="numeric">{{ $t('niches.colChannels') }}</div>
          <div class="numeric">{{ $t('niches.colSubs') }}</div>
          <div class="numeric">{{ $t('niches.colViews') }}</div>
          <div>{{ $t('niches.colMade') }}</div>
        </div>
        <div v-for="nch in niches.data.value.niches" :key="nch.subject" class="row">
          <div class="subject">#{{ nch.subject }}</div>
          <div class="numeric strong">{{ nch.lift }}×</div>
          <div class="numeric">{{ nch.creators }}</div>
          <!-- How contested it is. A subject held by small accounts is one an
               unknown account can enter; one held by large accounts is not. -->
          <div class="numeric">{{ num(nch.medianFollowers) }}</div>
          <div class="numeric">{{ num(nch.medianViews) }}</div>
          <div class="faint">{{ nch.formats.map((f) => f.key).join(', ') }}</div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.explain {
  font-size: 0.72rem;
  color: rgb(var(--v-theme-on-surface-variant));
  margin: 0;
  line-height: 1.6;
}
.table {
  display: grid;
  gap: 2px;
  overflow-x: auto;
}
.row {
  display: grid;
  grid-template-columns: minmax(130px, 1.6fr) 64px 76px 90px 90px minmax(90px, 1fr);
  align-items: center;
  gap: 10px;
  padding: 5px 4px;
  border-radius: 4px;
  font-size: 0.8125rem;
  min-width: 600px;
}
.row.header {
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: rgb(var(--v-theme-on-surface-variant));
  border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.1);
  padding-bottom: 6px;
}
.row:not(.header):hover {
  background: rgba(var(--v-theme-on-surface), 0.04);
}
.subject {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: ltr;
  text-align: start;
}
.numeric {
  text-align: end;
  font-variant-numeric: tabular-nums;
}
.numeric.strong {
  font-weight: 650;
  color: rgb(var(--v-theme-success));
}
.topic {
  font-size: 0.95rem;
  font-weight: 650;
}
.score,
.faint {
  font-size: 0.75rem;
  color: rgb(var(--v-theme-on-surface-variant));
  font-variant-numeric: tabular-nums;
}
.matches-label {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: rgb(var(--v-theme-on-surface-variant));
  margin-bottom: 4px;
}
.match {
  display: flex;
  gap: 8px;
  align-items: baseline;
  font-size: 0.78rem;
  color: inherit;
  text-decoration: none;
  padding: 2px 0;
}
.match:hover .match-title {
  text-decoration: underline;
}
.sim {
  font-variant-numeric: tabular-nums;
  font-size: 0.72rem;
  color: rgb(var(--v-theme-on-surface-variant));
  min-width: 34px;
}
.sim.over {
  color: rgb(var(--v-theme-success));
  font-weight: 650;
}
.match-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
