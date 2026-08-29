<script setup lang="ts">
/**
 * The items behind one bar.
 *
 * "Titles of 31-50 characters rank six points higher" is a claim, and a claim
 * is only usable once you can look at what it was made from. This is that: the
 * strongest few items in the bucket, as cards you can open, judge and copy.
 *
 * It deliberately repeats what the bar said above the list. Someone who clicks
 * three bars in a row should never have to remember which one this was, and a
 * list of examples with no claim attached is just a list of posts.
 */
import { computed, ref, watch } from 'vue';
import { api, query } from '@/api/client';
import type { ExampleSet } from '@/api/types';
import { openExamples } from '@/composables/useRadar';
import TrendCard from './TrendCard.vue';

const data = ref<ExampleSet | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

const open = computed({
  get: () => openExamples.value !== null,
  set: (value: boolean) => {
    if (!value) openExamples.value = null;
  },
});

const request = computed(() => openExamples.value);

watch(openExamples, async (next) => {
  if (next === null) {
    data.value = null;
    error.value = null;
    return;
  }
  loading.value = true;
  error.value = null;
  data.value = null;
  try {
    data.value = await api.examples(
      query({
        ...next.filters,
        dimension: next.dimension,
        group: next.group,
        bucket: next.bucket,
        limit: 8,
      }),
    );
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <v-dialog v-model="open" max-width="820" scrollable>
    <v-card v-if="request">
      <v-toolbar density="comfortable" color="surface">
        <v-toolbar-title class="text-body-1 font-weight-medium ms-4">
          {{ $t('examples.title', { what: request.title }) }}
        </v-toolbar-title>
        <v-btn icon="mdi-close" variant="text" @click="open = false" />
      </v-toolbar>

      <v-card-text>
        <!-- The claim this list is evidence for, restated so the two are read
             together rather than the examples being taken as a ranking. -->
        <div class="d-flex flex-wrap align-center ga-2 mb-1">
          <v-chip
            v-if="request.lift !== null"
            size="small"
            variant="tonal"
            :color="request.proven ? (request.lift >= 0 ? 'success' : 'error') : undefined"
            :prepend-icon="request.lift >= 0 ? 'mdi-trending-up' : 'mdi-trending-down'"
          >
            {{ request.lift > 0 ? '+' : '' }}{{ request.lift }} {{ $t('examples.points') }}
          </v-chip>
          <v-chip v-if="data" size="small" variant="text" class="faint">
            {{ $t('examples.of', { shown: data.items.length, total: data.n }) }}
          </v-chip>
        </div>

        <p class="hint mb-4">
          {{ request.proven ? $t('examples.hintProven') : $t('examples.hintUnproven') }}
        </p>

        <v-progress-linear v-if="loading" indeterminate color="primary" class="mb-3" />
        <v-alert v-if="error" type="error" variant="tonal" density="compact">{{ error }}</v-alert>

        <template v-if="data">
          <p v-if="data.items.length === 0" class="text-body-2 text-medium-emphasis">
            {{ $t('examples.empty') }}
          </p>
          <div v-else class="d-grid ga-2">
            <TrendCard v-for="item in data.items" :key="item.id" :item="item" dense />
          </div>
        </template>
      </v-card-text>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.d-grid {
  display: grid;
}
.hint {
  font-size: 0.78rem;
  color: rgb(var(--v-theme-on-surface-variant));
  line-height: 1.6;
  margin: 0;
}
.faint {
  opacity: 0.75;
}
</style>
