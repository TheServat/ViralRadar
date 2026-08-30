<script setup lang="ts">
/**
 * Which tags to put on a post about a given subject.
 *
 * Type a word. It finds the posts about it and reports how each of their
 * *other* tags performed against the rest of that set — so the answer is never
 * "the most popular tag", which is always `#shorts`, but "among posts about
 * this, which tags travel with the ones that did well".
 *
 * The column that decides whether a row means anything is **channels**, not
 * posts. One account posting fifty videos with the same nine tags produces
 * nine rows that pass every sample-size test and are really one sample. Those
 * are marked and pushed below rather than hidden, because seeing why a
 * spectacular number is not a finding is more useful than never seeing it.
 */
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, query } from '@/api/client';
import type { TagAnalysis, TagResult } from '@/api/types';
import { facets, useAsync } from '@/composables/useRadar';
import { useCountryOptions, useLanguageOptions } from '@/composables/useCodes';
import { useFormat } from '@/composables/useFormat';
import SectionHeader from '@/components/SectionHeader.vue';
import StatTile from '@/components/StatTile.vue';

const { t } = useI18n();
const { num } = useFormat();

const term = ref('');
/** Only what has actually been searched, so typing does not fire a request. */
const seed = ref('');
const lang = ref<string | null>(null);
const country = ref<string | null>(null);
const source = ref<string | null>(null);
const hours = ref(720);

const languageOptions = useLanguageOptions(computed(() => facets.value.languages));
const countryOptions = useCountryOptions(computed(() => facets.value.countries));
const sourceOptions = computed(() => facets.value.sources.map((s) => ({ value: s.key, title: s.key })));
const WINDOWS = [168, 336, 720, 2160];

const { data, loading, error } = useAsync<TagAnalysis | null>(
  () =>
    seed.value === ''
      ? Promise.resolve(null)
      : api.relatedTags(
          query({
            q: seed.value,
            lang: lang.value,
            country: country.value,
            source: source.value,
            hours: hours.value,
          }),
        ),
  () => [seed.value, lang.value, country.value, source.value, hours.value],
);

function search(): void {
  seed.value = term.value.trim().replace(/^#/, '');
}

// Re-running on filter changes only makes sense once something was searched.
watch([lang, country, source, hours], () => {
  if (term.value.trim() !== '') search();
});

/** Proven, then the rest — the order the server already put them in. */
const rows = computed(() => data.value?.tags ?? []);
const proven = computed(() => rows.value.filter((r) => r.significant));
const rest = computed(() => rows.value.filter((r) => !r.significant));

/**
 * Enough posts to say anything at all.
 *
 * Nothing and not-enough are different answers and get different words. "Only
 * 0 posts mention this" is not a sentence, and more importantly it hides the
 * useful part: nothing found usually means the word is not in what has been
 * collected, which is a fact about the sources and filters rather than about
 * the word.
 */
const tooLittle = computed(() => data.value != null && data.value.n < 40);
const nothing = computed(() => data.value != null && data.value.n === 0);

/** Real tags to try instead — matching first, popular ones as orientation. */
const suggestions = computed(() => {
  const s = data.value?.suggestions;
  if (s === undefined) return { list: [], kind: 'none' as const };
  if (s.matching.length > 0) return { list: s.matching, kind: 'matching' as const };
  return { list: s.popular, kind: 'popular' as const };
});

function searchFor(tag: string): void {
  term.value = tag;
  seed.value = tag;
}

function verdict(row: TagResult): { text: string; colour: string } {
  if (row.significant) return { text: t('tags.proven'), colour: row.lift >= 0 ? 'success' : 'error' };
  if (row.concentrated) return { text: t('tags.concentrated'), colour: 'warning' };
  if (row.thin) return { text: t('tags.thin'), colour: '' };
  return { text: t('tags.chance'), colour: '' };
}

/** The bar width, as a share of the widest lift on screen. */
const widest = computed(() =>
  Math.max(10, ...rows.value.map((r) => Math.abs(r.lift))),
);
function barWidth(row: TagResult): string {
  return `${Math.min(100, (Math.abs(row.lift) / widest.value) * 100)}%`;
}

async function copyTags(): Promise<void> {
  const text = proven.value
    .filter((r) => r.lift > 0)
    .map((r) => `#${r.key}`)
    .join(' ');
  try {
    await navigator.clipboard.writeText(text);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 2000);
  } catch {
    // Clipboard access can be refused; the tags are on screen either way.
  }
}
const copied = ref(false);
</script>

<template>
  <div>
    <SectionHeader :title="$t('tags.title')" :hint="$t('tags.hint')" icon="mdi-pound" />

    <v-card class="mb-4">
      <v-card-text class="py-3">
        <div class="d-flex flex-wrap ga-3 align-start">
          <v-text-field
            v-model="term"
            :label="$t('tags.search')"
            :placeholder="$t('tags.searchPlaceholder')"
            prepend-inner-icon="mdi-pound"
            density="compact"
            variant="outlined"
            hide-details
            clearable
            style="min-width: 240px; flex: 1 1 240px"
            @keyup.enter="search"
          />
          <v-btn color="primary" size="large" prepend-icon="mdi-magnify" @click="search">
            {{ $t('tags.go') }}
          </v-btn>
        </div>

        <div class="d-flex flex-wrap ga-3 align-start mt-3">
          <v-autocomplete
            v-model="lang"
            :items="languageOptions"
            :label="$t('filters.language')"
            density="compact"
            variant="outlined"
            hide-details
            clearable
            style="min-width: 170px"
          />
          <v-autocomplete
            v-model="country"
            :items="countryOptions"
            :label="$t('filters.country')"
            density="compact"
            variant="outlined"
            hide-details
            clearable
            style="min-width: 170px"
          />
          <v-select
            v-model="source"
            :items="sourceOptions"
            :label="$t('filters.source')"
            density="compact"
            variant="outlined"
            hide-details
            clearable
            style="min-width: 150px"
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
        </div>
      </v-card-text>
    </v-card>

    <v-progress-linear v-if="loading" indeterminate color="primary" class="mb-3" />
    <v-alert v-if="error" type="error" variant="tonal">{{ $t('app.error', { message: error }) }}</v-alert>

    <v-alert v-if="seed === '' && !loading" type="info" variant="tonal">
      {{ $t('tags.empty') }}
    </v-alert>

    <template v-if="data && seed !== ''">
      <v-alert v-if="tooLittle" type="info" variant="tonal" class="mb-4">
        <div>
          {{ nothing
            ? $t('tags.nothingFound', { seed: data.seed, min: data.minTextSearch })
            : $t('tags.tooLittle', { n: data.n }) }}
        </div>

        <!-- A dead end with a next step in it. Which list this is says what
             kind of miss it was, so the wording changes with it. -->
        <template v-if="suggestions.list.length > 0">
          <div class="text-caption mt-3 mb-2">
            {{ suggestions.kind === 'matching' ? $t('tags.didYouMean') : $t('tags.insteadTry') }}
          </div>
          <div class="d-flex flex-wrap ga-2">
            <v-chip
              v-for="s in suggestions.list"
              :key="s.tag"
              size="small"
              variant="tonal"
              link
              @click="searchFor(s.tag)"
            >
              #{{ s.tag }}
              <span class="chip-n">{{ s.posts }}</span>
            </v-chip>
          </div>
        </template>
      </v-alert>

      <template v-else>
        <v-row dense class="mb-2">
          <v-col cols="6" md="3">
            <StatTile
              :label="$t('tags.statPosts')"
              :value="data.n"
              :hint="$t('tags.statPostsHelp', { seed: data.seed })"
              icon="mdi-counter"
            />
          </v-col>
          <v-col cols="6" md="3">
            <StatTile
              :label="$t('tags.statBaseline')"
              :value="data.baseline"
              :hint="$t('tags.statBaselineHelp')"
              icon="mdi-scale-balance"
            />
          </v-col>
          <v-col cols="6" md="3">
            <StatTile
              :label="$t('tags.statFindings')"
              :value="data.findings"
              :hint="$t('tags.statFindingsHelp', { creators: data.minCreators, posts: data.minSample })"
              icon="mdi-check-decagram-outline"
            />
          </v-col>
          <v-col cols="6" md="3">
            <StatTile
              :label="$t('tags.statTags')"
              :value="data.totalTags"
              :hint="$t('tags.statTagsHelp', { shown: rows.length, min: data.minPosts })"
              icon="mdi-pound"
            />
          </v-col>
        </v-row>

        <!-- The answer, as something you can paste. -->
        <v-card v-if="proven.some((r) => r.lift > 0)" class="mb-4">
          <v-card-title class="head">
            <v-icon icon="mdi-check-decagram-outline" size="20" class="me-2" />
            {{ $t('tags.useThese') }}
            <v-spacer />
            <v-btn size="x-small" variant="tonal" prepend-icon="mdi-content-save" @click="copyTags">
              {{ copied ? $t('app.done') : $t('tags.copy') }}
            </v-btn>
          </v-card-title>
          <v-card-text>
            <div class="d-flex flex-wrap ga-2">
              <v-chip
                v-for="r in proven.filter((x) => x.lift > 0)"
                :key="r.key"
                color="success"
                variant="tonal"
                prepend-icon="mdi-trending-up"
              >
                #{{ r.key }}
                <span class="chip-n">+{{ r.lift }}</span>
              </v-chip>
            </div>
            <div v-if="proven.some((r) => r.lift < 0)" class="mt-4">
              <div class="sub mb-2">{{ $t('tags.avoidThese') }}</div>
              <div class="d-flex flex-wrap ga-2">
                <v-chip
                  v-for="r in proven.filter((x) => x.lift < 0)"
                  :key="r.key"
                  color="error"
                  variant="tonal"
                  prepend-icon="mdi-trending-down"
                >
                  #{{ r.key }}
                  <span class="chip-n">{{ r.lift }}</span>
                </v-chip>
              </div>
            </div>
            <v-alert type="warning" variant="tonal" density="compact" class="mt-4 mb-0">
              {{ $t('tags.causationWarning') }}
            </v-alert>
          </v-card-text>
        </v-card>

        <!-- Every row, with the numbers that decide whether to believe it. -->
        <v-card>
          <v-card-title class="head">{{ $t('tags.allTags') }}</v-card-title>
          <v-card-subtitle class="pb-2">{{ $t('tags.allTagsHelp') }}</v-card-subtitle>
          <v-card-text class="pt-0">
            <div class="table">
              <div class="row header">
                <div>{{ $t('tags.colTag') }}</div>
                <div class="numeric">{{ $t('tags.colLift') }}</div>
                <div class="bar-col" />
                <div class="numeric">{{ $t('tags.colPosts') }}</div>
                <div class="numeric">{{ $t('tags.colChannels') }}</div>
                <div class="numeric">{{ $t('tags.colViews') }}</div>
                <div>{{ $t('tags.colVerdict') }}</div>
              </div>

              <div
                v-for="r in [...proven, ...rest]"
                :key="r.key"
                class="row"
                :class="{ muted: !r.significant }"
              >
                <div class="tag">#{{ r.key }}</div>
                <div class="numeric strong" :class="r.lift >= 0 ? 'up' : 'down'">
                  {{ r.lift > 0 ? '+' : '' }}{{ r.lift }}
                </div>
                <div class="bar-col">
                  <span
                    class="bar"
                    :class="r.lift >= 0 ? 'up' : 'down'"
                    :style="{ width: barWidth(r) }"
                  />
                </div>
                <div class="numeric">{{ r.n }}</div>
                <!-- The column that decides it: one account is not a sample. -->
                <div class="numeric" :class="{ warn: r.concentrated }">{{ r.creators }}</div>
                <div class="numeric">{{ r.medianViews === null ? '—' : num(r.medianViews) }}</div>
                <div>
                  <v-chip size="x-small" variant="tonal" :color="verdict(r).colour || undefined">
                    {{ verdict(r).text }}
                  </v-chip>
                </div>
              </div>
            </div>
          </v-card-text>
        </v-card>
      </template>
    </template>
  </div>
</template>

<style scoped>
.head {
  font-size: 0.9375rem;
  font-weight: 600;
  display: flex;
  align-items: center;
}
.sub {
  font-size: 0.8rem;
  font-weight: 600;
  color: rgb(var(--v-theme-on-surface-variant));
}
.chip-n {
  margin-inline-start: 6px;
  font-variant-numeric: tabular-nums;
  opacity: 0.8;
  font-size: 0.72rem;
}

.table {
  display: grid;
  gap: 2px;
  overflow-x: auto;
}
.row {
  display: grid;
  grid-template-columns: minmax(120px, 1.4fr) 56px minmax(60px, 1fr) 64px 76px 84px 110px;
  align-items: center;
  gap: 10px;
  padding: 5px 4px;
  border-radius: 4px;
  font-size: 0.8125rem;
  min-width: 620px;
}
.row.header {
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: rgb(var(--v-theme-on-surface-variant));
  border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.1);
  padding-bottom: 6px;
  margin-bottom: 2px;
}
.row.muted {
  opacity: 0.62;
}
.row:not(.header):hover {
  background: rgba(var(--v-theme-on-surface), 0.04);
}
.tag {
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
}
.numeric.warn {
  color: rgb(var(--v-theme-warning));
  font-weight: 650;
}
.up {
  color: #46d39a;
}
.down {
  color: #ff6b7a;
}
.bar-col {
  display: flex;
  align-items: center;
}
.bar {
  height: 6px;
  border-radius: 3px;
  display: block;
}
.bar.up {
  background: #46d39a;
}
.bar.down {
  background: #ff6b7a;
}
</style>
