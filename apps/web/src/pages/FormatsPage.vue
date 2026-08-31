<script setup lang="ts">
/**
 * What shape of content wins.
 *
 * The other pages answer "what is spreading". This one answers the question a
 * creator acts on once that is decided: how long the title should be, whether
 * it should ask something, whether to make a short video or an image.
 *
 * The page is built to be read honestly. Every bar carries its sample size and
 * its interval, anything under the minimum sample is greyed rather than hidden,
 * and the headline list only ever draws from differences the data can actually
 * support. It says "these did better", never "this will make yours do better",
 * because the analysis cannot separate correlated causes and pretending
 * otherwise would be the easiest lie in the whole system.
 */
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, query } from '@/api/client';
import type { FormatAnalysis, FormatBucket, ThumbnailAnalysis, TimingAnalysis } from '@/api/types';
import { facets, openExamples, useAsync } from '@/composables/useRadar';
import type { LiftRow } from '@/components/charts/LiftChart.vue';
import { useCountryOptions, useLanguageOptions } from '@/composables/useCodes';
import SectionHeader from '@/components/SectionHeader.vue';
import StatTile from '@/components/StatTile.vue';
import LiftChart from '@/components/charts/LiftChart.vue';

const { t, locale } = useI18n();

const lang = ref<string | null>(null);
const country = ref<string | null>(null);
const source = ref<string | null>(null);
const hours = ref(336);
const minConfidence = ref(0.4);

const presentLanguages = computed(() => facets.value.languages);
const presentCountries = computed(() => facets.value.countries);
const languageOptions = useLanguageOptions(presentLanguages);
const countryOptions = useCountryOptions(presentCountries);
const sourceOptions = computed(() =>
  facets.value.sources.map((s) => ({ value: s.key, title: s.key })),
);

const WINDOWS = [72, 168, 336, 720, 2160];
const CONFIDENCE = [0.2, 0.4, 0.6];

const { data, loading, error } = useAsync<FormatAnalysis>(
  () =>
    api.formats(
      query({
        lang: lang.value,
        country: country.value,
        source: source.value,
        hours: hours.value,
        minConfidence: minConfidence.value,
      }),
    ),
  () => [lang.value, country.value, source.value, hours.value, minConfidence.value],
);

/** Group titles are fixed; bucket labels are translated where they are names. */
const GROUP_ICON: Record<string, string> = {
  contentType: 'mdi-shape-outline',
  titleLength: 'mdi-format-letter-case',
  titleWords: 'mdi-text-short',
  titlePattern: 'mdi-tag-outline',
};

function labelFor(groupKey: string, bucketKey: string): string {
  if (groupKey === 'contentType') return t(`type.${bucketKey}`);
  if (groupKey === 'titlePattern') return t(`formats.feature.${bucketKey}`);
  // Length and word buckets are ranges, which are already language-neutral.
  return bucketKey;
}

function toRows(groupKey: string, buckets: readonly FormatBucket[]): LiftRow[] {
  return buckets.map((b) => ({
    key: b.key,
    label: labelFor(groupKey, b.key),
    n: b.n,
    lift: b.lift,
    margin: b.margin,
    percentile: b.percentile,
    significant: b.significant,
    thin: b.thin,
  }));
}

const groups = computed(() =>
  (data.value?.groups ?? [])
    .filter((g) => g.buckets.length > 0)
    .map((g) => ({ key: g.key, icon: GROUP_ICON[g.key] ?? 'mdi-chart-bar', rows: toRows(g.key, g.buckets) })),
);

/** The findings, phrased as a sentence rather than left as a number. */
const findings = computed(() => {
  const analysis = data.value;
  if (analysis === null || analysis === undefined) return [];
  return analysis.findings.slice(0, 6).map((f) => {
    // The group comes with the finding. Searching the groups for a bucket with
    // this key finds whichever was pushed first, which is wrong wherever two
    // groups share a key.
    const groupKey = f.group;
    return {
      key: `${groupKey}:${f.key}`,
      label: labelFor(groupKey, f.key),
      group: groupKey,
      bucket: f.key,
      lift: f.lift,
      n: f.n,
      up: f.lift > 0,
    };
  });
});

// ── Seeing what a number was made of ──────────────────────────────────────
//
// Every bar here is thousands of items reduced to one figure, and a figure is
// where trust runs out. Clicking one asks the server for the strongest items
// it was computed from, with the same filters and the same bucketing — so the
// examples are evidence for that bar rather than a second, similar list.

/** Whatever a bar or a finding needs to identify itself. */
interface Openable {
  readonly key: string;
  readonly label: string;
  readonly lift: number;
  readonly significant: boolean;
}

/** The filters shared by the format and timing analyses on this page. */
const shared = computed(() => ({
  lang: lang.value,
  country: country.value,
  source: source.value,
  minConfidence: minConfidence.value,
}));

function openFormatExamples(groupKey: string, row: Openable): void {
  openExamples.value = {
    dimension: 'format',
    group: groupKey,
    bucket: row.key,
    title: `${t(`formats.group.${groupKey}`)} · ${row.label}`,
    lift: row.lift,
    proven: row.significant,
    filters: { ...shared.value, hours: hours.value },
  };
}

function openTimingExamples(groupKey: string, row: Openable): void {
  openExamples.value = {
    dimension: 'timing',
    group: groupKey,
    bucket: row.key,
    title: `${t(`formats.group.${groupKey}`)} · ${row.label}`,
    lift: row.lift,
    proven: row.significant,
    // The same widened window the timing request uses, or the examples would
    // be drawn from a different set of items than the bar was.
    filters: {
      ...shared.value,
      hours: Math.max(hours.value, 720),
      settleHours: timing.data.value?.settleHours ?? null,
    },
  };
}

function openThumbExamples(groupKey: string, row: Openable): void {
  openExamples.value = {
    dimension: 'thumbnail',
    group: groupKey,
    bucket: row.key,
    title: `${t(`thumbs.group.${groupKey}`)} · ${row.label}`,
    lift: row.lift,
    proven: row.significant,
    // The thumbnail analysis takes only these two, so this must as well.
    filters: { lang: lang.value, source: source.value },
  };
}

// ── When to post ──────────────────────────────────────────────────────────

const timing = useAsync<TimingAnalysis>(
  () =>
    api.timing(
      query({
        lang: lang.value,
        country: country.value,
        source: source.value,
        hours: Math.max(hours.value, 720),
        minConfidence: minConfidence.value,
      }),
    ),
  () => [lang.value, country.value, source.value, hours.value, minConfidence.value],
);

/**
 * Day names from the platform rather than from the locale files.
 *
 * `Intl` already knows them in every language the interface speaks, and
 * getting them from there means they cannot drift out of step with the rest of
 * the date formatting on the page.
 */
const weekdayNames = computed(() => {
  const format = new Intl.DateTimeFormat(locale.value, { weekday: 'long' });
  // 2024-01-07 was a Sunday, so index 0 lines up with the server's numbering.
  return Array.from({ length: 7 }, (_, i) => format.format(new Date(Date.UTC(2024, 0, 7 + i))));
});

/**
 * Persian and Arabic weeks start on Saturday. Showing Sunday first would be
 * correct only for an English reader, and this page is about someone's own
 * posting week.
 */
const weekOrder = computed(() =>
  ['fa', 'ar'].includes(locale.value) ? [6, 0, 1, 2, 3, 4, 5] : [0, 1, 2, 3, 4, 5, 6],
);

function timingLabel(groupKey: string, bucketKey: string): string {
  if (groupKey === 'weekday') return weekdayNames.value[Number(bucketKey)] ?? bucketKey;
  if (groupKey === 'dayPart') return t(`formats.part.${bucketKey}`);
  // An hour, shown as the clock reads it.
  return `${String(bucketKey).padStart(2, '0')}:00`;
}

const TIMING_ICON: Record<string, string> = {
  dayPart: 'mdi-weather-sunset',
  weekday: 'mdi-calendar-week',
  hour: 'mdi-clock-outline',
};

const timingGroups = computed(() => {
  const analysis = timing.data.value;
  if (analysis === null || analysis === undefined) return [];
  return analysis.groups
    .filter((g) => g.buckets.length > 0)
    .map((g) => {
      const rows = g.buckets.map((b) => ({
        key: b.key,
        label: timingLabel(g.key, b.key),
        n: b.n,
        lift: b.lift,
        margin: b.margin,
        percentile: b.percentile,
        significant: b.significant,
        thin: b.thin,
      }));
      if (g.key === 'weekday') {
        const order = weekOrder.value.map(String);
        rows.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
      }
      return { key: g.key, icon: TIMING_ICON[g.key] ?? 'mdi-clock-outline', rows };
    });
});

const timingFindings = computed(() => {
  const analysis = timing.data.value;
  if (analysis === null || analysis === undefined) return [];
  return analysis.findings.slice(0, 5).map((f) => {
    // Timing is where this mattered most: weekday keys '0'..'6' and hour keys
    // '0'..'23' overlap, so three of them were labelled as the wrong group and
    // opened the wrong examples.
    return {
      key: `${f.group}:${f.key}`,
      label: timingLabel(f.group, f.key),
      group: f.group,
      bucket: f.key,
      lift: f.lift,
      n: f.n,
      up: f.lift > 0,
    };
  });
});

const thinTotal = computed(
  () => (data.value?.groups ?? []).flatMap((g) => g.buckets).filter((b) => b.thin).length,
);

// ── Thumbnails ────────────────────────────────────────────────────────────
//
// The other half of "what works". Titles are measured in characters; images
// are measured in brightness, colour and how busy they are — same statistics,
// same refusal to call noise a finding.
const thumbs = useAsync<ThumbnailAnalysis>(
  () => api.thumbnails(query({ lang: lang.value, source: source.value })),
  () => [lang.value, source.value],
);

const THUMB_ICON: Record<string, string> = {
  brightness: 'mdi-brightness-6',
  contrast: 'mdi-contrast-circle',
  saturation: 'mdi-palette-outline',
  warmth: 'mdi-thermometer',
  people: 'mdi-account-outline',
  busyness: 'mdi-view-grid-outline',
};

const thumbGroups = computed(() => {
  const d = thumbs.data.value;
  if (d === null || d === undefined) return [];
  return d.groups
    .filter((g) => g.buckets.length > 0)
    .map((g) => ({
      key: g.key,
      icon: THUMB_ICON[g.key] ?? 'mdi-image-outline',
      rows: g.buckets.map((b) => ({
        key: b.key,
        label: t(`thumbs.band.${g.key}.${b.key}`),
        n: b.n,
        lift: b.lift,
        margin: b.margin,
        percentile: b.percentile,
        significant: b.significant,
        thin: b.thin,
      })),
    }));
});

</script>

<template>
  <div>
    <SectionHeader
      :title="$t('formats.title')"
      :hint="$t('formats.hint')"
      icon="mdi-format-letter-case"
    />

    <!-- Filters. The confidence floor is here rather than buried, because it
         is the one control that changes what the answer is allowed to be. -->
    <v-card class="mb-4" variant="tonal">
      <v-card-text class="d-flex flex-wrap ga-3 align-start">
        <v-autocomplete
          v-model="lang"
          :items="languageOptions"
          :label="$t('filters.language')"
          density="compact"
          variant="outlined"
          hide-details
          clearable
          style="min-width: 190px"
        />
        <v-autocomplete
          v-model="country"
          :items="countryOptions"
          :label="$t('filters.country')"
          density="compact"
          variant="outlined"
          hide-details
          clearable
          style="min-width: 190px"
        />
        <v-select
          v-model="source"
          :items="sourceOptions"
          :label="$t('filters.source')"
          density="compact"
          variant="outlined"
          hide-details
          clearable
          style="min-width: 170px"
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
        <v-select
          v-model="minConfidence"
          :items="CONFIDENCE.map((c) => ({ value: c, title: String(c) }))"
          :label="$t('formats.confidenceLabel')"
          :hint="$t('formats.confidenceHelp')"
          persistent-hint
          density="compact"
          variant="outlined"
          style="min-width: 190px"
        />
      </v-card-text>
    </v-card>

    <v-progress-linear v-if="loading" indeterminate color="primary" class="mb-3" />
    <v-alert v-if="error" type="error" variant="tonal">{{ $t('app.error', { message: error }) }}</v-alert>

    <template v-if="data">
      <!-- Not enough to say anything, said plainly rather than shown as empty
           charts that look like real zeroes. -->
      <v-alert v-if="data.n < 40" type="info" variant="tonal" class="mb-4">
        {{ $t('formats.tooLittle', { n: data.n }) }}
      </v-alert>

      <template v-else>
        <v-row dense class="mb-2">
          <v-col cols="12" sm="6" md="3">
            <StatTile
              :label="$t('formats.statItems')"
              :value="data.n"
              :hint="$t('formats.statItemsHelp')"
              icon="mdi-counter"
            />
          </v-col>
          <v-col cols="12" sm="6" md="3">
            <StatTile
              :label="$t('formats.statBaseline')"
              :value="data.baseline"
              :hint="$t('formats.statBaselineHelp')"
              icon="mdi-scale-balance"
            />
          </v-col>
          <v-col cols="12" sm="6" md="3">
            <StatTile
              :label="$t('formats.statFindings')"
              :value="data.findings.length"
              :hint="$t('formats.statFindingsHelp')"
              icon="mdi-check-decagram-outline"
            />
          </v-col>
          <v-col cols="12" sm="6" md="3">
            <StatTile
              :label="$t('formats.statThin')"
              :value="thinTotal"
              :hint="$t('formats.statThinHelp', { min: data.minSample })"
              icon="mdi-help-circle-outline"
            />
          </v-col>
        </v-row>

        <!-- The answer, in words. -->
        <v-card class="mb-4">
          <v-card-title class="findings-title">
            <v-icon icon="mdi-lightbulb-on-outline" size="20" class="me-2" />
            {{ $t('formats.findingsTitle') }}
          </v-card-title>
          <v-card-text>
            <p v-if="findings.length === 0" class="text-body-2 text-medium-emphasis mb-0">
              {{ $t('formats.noFindings') }}
            </p>
            <div v-else class="findings">
              <button
                v-for="f in findings"
                :key="f.key"
                type="button"
                class="finding"
                :title="$t('formats.tipOpen')"
                @click="openFormatExamples(f.group, {
                  key: f.bucket,
                  label: f.label,
                  lift: f.lift,
                  significant: true,
                })"
              >
                <v-icon
                  :icon="f.up ? 'mdi-trending-up' : 'mdi-trending-down'"
                  :color="f.up ? 'success' : 'error'"
                  size="20"
                />
                <div>
                  <div class="text-body-2">
                    {{ $t(f.up ? 'formats.findingUp' : 'formats.findingDown', {
                      what: f.label,
                      points: Math.abs(f.lift),
                    }) }}
                  </div>
                  <div class="text-caption text-medium-emphasis">
                    {{ $t('formats.findingBasis', { n: f.n, group: $t(`formats.group.${f.group}`) }) }}
                    · {{ $t('examples.see') }}
                  </div>
                </div>
              </button>
            </div>

            <!-- Said with the findings, not below them. The pooled version of
                 this list reported emoji and hashtag as proven, and both were
                 the content-type mix wearing a title label. -->
            <v-alert
              v-if="data.formatSpread > 0"
              type="info"
              variant="tonal"
              density="compact"
              class="mt-4 mb-0"
            >
              {{ $t('formats.formatAdjusted', {
                points: data.formatSpread,
                formats: data.formats.slice(0, 4).map((f) => $t(`type.${f.key}`)).join('، '),
              }) }}
            </v-alert>

            <v-alert type="warning" variant="tonal" density="compact" class="mt-4 mb-0">
              {{ $t('formats.causationWarning') }}
            </v-alert>
          </v-card-text>
        </v-card>

        <v-row dense class="mb-2">
          <v-col v-for="g in groups" :key="g.key" cols="12" md="6">
            <v-card class="h-100">
              <v-card-title class="group-title">
                <v-icon :icon="g.icon" size="18" class="me-2" />
                {{ $t(`formats.group.${g.key}`) }}
              </v-card-title>
              <v-card-subtitle class="pb-2">{{ $t(`formats.groupHelp.${g.key}`) }}</v-card-subtitle>
              <v-card-text>
                <LiftChart
                  :rows="g.rows"
                  :min-sample="data.minSample"
                  selectable
                  @select="(row) => openFormatExamples(g.key, row)"
                />
              </v-card-text>
            </v-card>
          </v-col>
        </v-row>

        <!-- ── Thumbnails ────────────────────────────────────────────── -->
        <SectionHeader
          :title="$t('thumbs.title')"
          :hint="$t('thumbs.hint')"
          icon="mdi-image-outline"
          class="mt-6"
        />

        <v-progress-linear v-if="thumbs.loading.value" indeterminate color="primary" class="mb-3" />

        <template v-if="thumbs.data.value">
          <v-alert v-if="thumbs.data.value.n < 40" type="info" variant="tonal" class="mb-4">
            {{ $t('thumbs.tooLittle', {
              n: thumbs.data.value.n,
              measured: thumbs.data.value.coverage.measured,
              total: thumbs.data.value.coverage.total,
            }) }}
          </v-alert>

          <template v-else>
            <!-- Said before the charts, not after: the measures are rough and
                 the reader should know that while reading them. -->
            <v-alert type="info" variant="tonal" density="compact" class="mb-3">
              <div>{{ $t('thumbs.crude') }}</div>
              <!-- Said before the charts, like the timing page says its age
                   adjustment: when the correction is bigger than the finding,
                   the reader is looking at the correction. -->
              <div v-if="thumbs.data.value.formatSpread > 0" class="mt-1">
                {{ $t('thumbs.formatAdjusted', {
                  points: thumbs.data.value.formatSpread,
                  formats: thumbs.data.value.formats.map((f) => f.key).join(', '),
                }) }}
              </div>
              <div class="text-caption mt-1">
                {{ $t('thumbs.coverage', {
                  measured: thumbs.data.value.coverage.measured,
                  total: thumbs.data.value.coverage.total,
                }) }}
              </div>
            </v-alert>

            <v-row dense>
              <v-col v-for="g in thumbGroups" :key="g.key" cols="12" md="6">
                <v-card class="h-100">
                  <v-card-title class="group-title">
                    <v-icon :icon="g.icon" size="18" class="me-2" />
                    {{ $t(`thumbs.group.${g.key}`) }}
                  </v-card-title>
                  <v-card-subtitle class="pb-2">{{ $t(`thumbs.groupHelp.${g.key}`) }}</v-card-subtitle>
                  <v-card-text>
                    <LiftChart
                      :rows="g.rows"
                      :min-sample="thumbs.data.value.minSample"
                      selectable
                      @select="(row) => openThumbExamples(g.key, row)"
                    />
                  </v-card-text>
                </v-card>
              </v-col>
            </v-row>
          </template>
        </template>

        <!-- ── When to post ──────────────────────────────────────────── -->
        <SectionHeader
          :title="$t('formats.timingTitle')"
          :hint="$t('formats.timingHint')"
          icon="mdi-clock-outline"
          class="mt-6"
        />

        <v-progress-linear v-if="timing.loading.value" indeterminate color="primary" class="mb-3" />

        <template v-if="timing.data.value">
          <v-alert v-if="timing.data.value.n < 40" type="info" variant="tonal" class="mb-4">
            {{ $t('formats.timingTooLittle', { n: timing.data.value.n }) }}
          </v-alert>

          <template v-else>
            <!-- The zone is stated rather than assumed: a machine set up
                 elsewhere would shift every hour here without saying so. -->
            <v-alert type="info" variant="tonal" density="compact" class="mb-3">
              <div>{{ $t('formats.timingZone', { zone: timing.data.value.timezone }) }}</div>
              <div class="text-caption mt-1">
                {{ $t('formats.ageAdjusted', {
                  points: timing.data.value.ageSpread,
                  source: timing.data.value.sourceSpread,
                }) }}
              </div>
            </v-alert>

            <v-card v-if="timingFindings.length > 0" class="mb-4">
              <v-card-title class="findings-title">
                <v-icon icon="mdi-clock-check-outline" size="20" class="me-2" />
                {{ $t('formats.timingFindings') }}
              </v-card-title>
              <v-card-text>
                <div class="findings">
                  <button
                    v-for="f in timingFindings"
                    :key="f.key"
                    type="button"
                    class="finding"
                    :title="$t('formats.tipOpen')"
                    @click="openTimingExamples(f.group, {
                      key: f.bucket,
                      label: f.label,
                      lift: f.lift,
                      significant: true,
                    })"
                  >
                    <v-icon
                      :icon="f.up ? 'mdi-trending-up' : 'mdi-trending-down'"
                      :color="f.up ? 'success' : 'error'"
                      size="20"
                    />
                    <div>
                      <div class="text-body-2">
                        {{ $t(f.up ? 'formats.timingUp' : 'formats.timingDown', {
                          what: f.label,
                          points: Math.abs(f.lift),
                        }) }}
                      </div>
                      <div class="text-caption text-medium-emphasis">
                        {{ $t('formats.findingBasis', { n: f.n, group: $t(`formats.group.${f.group}`) }) }}
                        · {{ $t('examples.see') }}
                      </div>
                    </div>
                  </button>
                </div>
              </v-card-text>
            </v-card>

            <v-row dense>
              <v-col
                v-for="g in timingGroups"
                :key="g.key"
                cols="12"
                :md="g.key === 'hour' ? 12 : 6"
              >
                <v-card class="h-100">
                  <v-card-title class="group-title">
                    <v-icon :icon="g.icon" size="18" class="me-2" />
                    {{ $t(`formats.group.${g.key}`) }}
                  </v-card-title>
                  <v-card-subtitle class="pb-2">
                    {{ $t(`formats.groupHelp.${g.key}`) }}
                  </v-card-subtitle>
                  <v-card-text>
                    <LiftChart
                      :rows="g.rows"
                      :min-sample="timing.data.value.minSample"
                      :show-rank="false"
                      selectable
                      @select="(row) => openTimingExamples(g.key, row)"
                    />
                  </v-card-text>
                </v-card>
              </v-col>
            </v-row>

            <p class="text-caption text-medium-emphasis mt-3 mb-0">
              {{ $t('formats.settleNote') }}
            </p>
          </template>
        </template>
      </template>
    </template>
  </div>
</template>

<style scoped>
.findings {
  display: grid;
  gap: 12px;
}

.finding {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  /* A button, so it is reachable by keyboard; styled back to plain text. */
  width: 100%;
  background: none;
  border: 0;
  padding: 4px 6px;
  margin: -4px -6px;
  border-radius: 6px;
  color: inherit;
  font: inherit;
  text-align: start;
  cursor: pointer;
}

.finding:hover,
.finding:focus-visible {
  background: rgba(var(--v-theme-on-surface), 0.05);
}

.findings-title,
.group-title {
  font-size: 0.9375rem;
  font-weight: 600;
  display: flex;
  align-items: center;
}
</style>
