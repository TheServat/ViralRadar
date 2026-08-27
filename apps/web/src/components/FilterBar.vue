<script setup lang="ts">
/**
 * The filter bar.
 *
 * Every control here narrows results *after* detection. Nothing in this
 * component can change what the radar looks at — which is why "all sources,
 * all languages, all countries, no topic" is the resting state and not a
 * special case.
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { facets } from '@/composables/useRadar';
import { useCountryOptions, useLanguageOptions } from '@/composables/useCodes';
import { SOURCE_ICON } from '@/composables/useFormat';

export interface FilterValues {
  source: string[];
  lang: string[];
  country: string[];
  type: string[];
  state: string[];
  minScore: number | null;
  q: string;
  sort: string;
}

const model = defineModel<FilterValues>({ required: true });
const props = defineProps<{ showSort?: boolean; showState?: boolean }>();
const { t } = useI18n();

const presentLanguages = computed(() => facets.value.languages);
const presentCountries = computed(() => facets.value.countries);
const languageOptions = useLanguageOptions(presentLanguages);
const countryOptions = useCountryOptions(presentCountries);

const sourceOptions = computed(() =>
  facets.value.sources.map((s) => ({ value: s.key, title: s.key, count: s.n })),
);

const TYPES = ['video', 'short_video', 'image', 'text', 'link', 'topic', 'audio'];
const STATES = ['VIRAL', 'HOT', 'EMERGING', 'RISING', 'PEAK', 'NEW', 'DECLINING'];
const SORTS = ['score', 'acceleration', 'velocity', 'recent', 'creator_anomaly'];

const typeOptions = computed(() => TYPES.map((v) => ({ value: v, title: t(`type.${v}`) })));
const stateOptions = computed(() => STATES.map((v) => ({ value: v, title: t(`state.${v}`) })));
const sortOptions = computed(() => SORTS.map((v) => ({ value: v, title: t(`sort.${v}`) })));

const activeCount = computed(() => {
  const f = model.value;
  return (
    f.source.length +
    f.lang.length +
    f.country.length +
    f.type.length +
    f.state.length +
    (f.minScore ? 1 : 0) +
    (f.q ? 1 : 0)
  );
});

function reset(): void {
  model.value = {
    source: [],
    lang: [],
    country: [],
    type: [],
    state: [],
    minScore: null,
    q: '',
    sort: model.value.sort,
  };
}
</script>

<template>
  <v-card class="mb-4">
    <v-card-text class="py-3">
      <v-row dense align="center">
        <v-col cols="12" sm="6" md="3">
          <v-autocomplete
            v-model="model.source"
            :items="sourceOptions"
            :label="$t('filters.source')"
            multiple
            chips
            closable-chips
            clearable
          >
            <template #item="{ props: itemProps, item }">
              <v-list-item v-bind="itemProps" :prepend-icon="SOURCE_ICON[item.raw.value] ?? 'mdi-web'">
                <template #append>
                  <span class="text-caption faint">{{ item.raw.count }}</span>
                </template>
              </v-list-item>
            </template>
          </v-autocomplete>
        </v-col>

        <v-col cols="12" sm="6" md="3">
          <v-autocomplete
            v-model="model.lang"
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
                  <span v-if="item.raw.count" class="text-caption text-primary">{{ item.raw.count }}</span>
                </template>
              </v-list-item>
            </template>
          </v-autocomplete>
        </v-col>

        <v-col cols="12" sm="6" md="3">
          <v-autocomplete
            v-model="model.country"
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
                  <span v-if="item.raw.count" class="text-caption text-primary">{{ item.raw.count }}</span>
                </template>
              </v-list-item>
            </template>
          </v-autocomplete>
        </v-col>

        <v-col cols="12" sm="6" md="3">
          <v-select
            v-model="model.type"
            :items="typeOptions"
            :label="$t('filters.type')"
            multiple
            chips
            closable-chips
            clearable
          />
        </v-col>

        <v-col v-if="props.showState !== false" cols="12" sm="6" md="3">
          <v-select
            v-model="model.state"
            :items="stateOptions"
            :label="$t('filters.state')"
            multiple
            chips
            closable-chips
            clearable
          />
        </v-col>

        <v-col cols="6" sm="3" md="2">
          <v-text-field
            v-model.number="model.minScore"
            type="number"
            min="0"
            max="100"
            step="5"
            :label="$t('filters.minScore')"
            clearable
          />
        </v-col>

        <v-col v-if="props.showSort !== false" cols="6" sm="3" md="2">
          <v-select v-model="model.sort" :items="sortOptions" :label="$t('filters.sort')" />
        </v-col>

        <v-col cols="12" md="3">
          <v-text-field
            v-model="model.q"
            :label="$t('filters.search')"
            :placeholder="$t('filters.searchHint')"
            prepend-inner-icon="mdi-magnify"
            clearable
          />
        </v-col>

        <v-col cols="12" md="2" class="d-flex align-center ga-2">
          <v-chip v-if="activeCount" size="small" color="primary" variant="tonal">
            {{ $t('filters.active', { n: activeCount }) }}
          </v-chip>
          <v-btn variant="text" size="small" prepend-icon="mdi-backspace-outline" @click="reset">
            {{ $t('filters.reset') }}
          </v-btn>
        </v-col>
      </v-row>
    </v-card-text>
  </v-card>
</template>

<style scoped>
.faint {
  opacity: 0.6;
}
</style>
