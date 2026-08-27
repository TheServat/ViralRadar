<script setup lang="ts">
import { computed, ref } from 'vue';
import { api, query } from '@/api/client';
import type { Cluster } from '@/api/types';
import { useAsync } from '@/composables/useRadar';
import ClusterCard from '@/components/ClusterCard.vue';
import SectionHeader from '@/components/SectionHeader.vue';

const minSources = ref(2);
const minScore = ref(0);

const q = computed(() => query({ minSources: minSources.value, minScore: minScore.value, limit: 80 }));
const { data, loading, error } = useAsync<{ items: Cluster[] }>(
  () => api.clusters(q.value),
  () => q.value,
);

const items = computed(() => data.value?.items ?? []);
</script>

<template>
  <div>
    <SectionHeader :title="$t('clusters.title')" :hint="$t('clusters.hint')" :count="items.length" icon="mdi-shape-outline" />

    <v-card class="mb-4">
      <v-card-text class="py-3">
        <v-row dense align="center">
          <v-col cols="12" sm="5" md="3">
            <v-select
              v-model="minSources"
              :items="[
                { value: 1, title: '1+' },
                { value: 2, title: '2+' },
                { value: 3, title: '3+' },
                { value: 4, title: '4+' },
              ]"
              :label="$t('clusters.minPlatforms')"
            />
          </v-col>
          <v-col cols="12" sm="5" md="3">
            <v-text-field
              v-model.number="minScore"
              type="number"
              min="0"
              max="100"
              step="5"
              :label="$t('filters.minScore')"
            />
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

    <v-progress-linear v-if="loading" indeterminate color="primary" class="mb-3" />
    <v-alert v-if="error" type="error" variant="tonal">{{ $t('app.error', { message: error }) }}</v-alert>
    <v-alert v-if="!loading && !error && items.length === 0" type="info" variant="tonal">
      {{ $t('clusters.empty') }}
    </v-alert>

    <v-row dense>
      <v-col v-for="c in items" :key="c.id" cols="12" md="6" xl="4">
        <ClusterCard :cluster="c" />
      </v-col>
    </v-row>
  </div>
</template>
