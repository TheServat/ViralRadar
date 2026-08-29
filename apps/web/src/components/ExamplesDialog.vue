<script setup lang="ts">
/**
 * The items behind one bar.
 *
 * "Titles of 31-50 characters rank six points higher" is a claim, and a claim
 * is only usable once you can look at what it was made from. This is that: the
 * strongest few items in the bucket, as things you can read, open and judge.
 *
 * Two views, because the two questions are not the same shape. For titles and
 * timing the subject is text, so the list of cards is right. For thumbnails the
 * subject *is* the picture — an answer about images that shows them at 64
 * pixels wide has not answered anything — so those open as a gallery, large
 * enough to judge, with a full-size view one click further. Nobody should have
 * to open YouTube to see what the bar was talking about.
 *
 * It deliberately repeats what the bar said above the list. Someone who clicks
 * three bars in a row should never have to remember which one this was, and a
 * list of examples with no claim attached is just a list of posts.
 */
import { computed, ref, watch } from 'vue';
import { api, query } from '@/api/client';
import type { ExampleSet, TrendItem } from '@/api/types';
import { openContentId, openExamples } from '@/composables/useRadar';
import { SOURCE_ICON, TYPE_ICON, useFormat } from '@/composables/useFormat';
import TrendCard from './TrendCard.vue';

const data = ref<ExampleSet | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
/** The image being viewed full size, or null. */
const zoomed = ref<TrendItem | null>(null);
const view = ref<'gallery' | 'list'>('list');

const { num } = useFormat();

const open = computed({
  get: () => openExamples.value !== null,
  set: (value: boolean) => {
    if (!value) openExamples.value = null;
  },
});

const request = computed(() => openExamples.value);

/**
 * Which measurement put these images in this band.
 *
 * The group names are the interface's — `people` is measured from skin
 * coverage — so the mapping back to the column lives here rather than being
 * assumed to be the same word.
 */
const MEASURE_OF: Record<string, string> = {
  brightness: 'brightness',
  contrast: 'contrast',
  saturation: 'saturation',
  warmth: 'warmth',
  people: 'skin',
  busyness: 'density',
};

/** The measured value for one item, as a percentage of the measure's range. */
function measureOf(item: TrendItem): string | null {
  const group = request.value?.group ?? '';
  const column = MEASURE_OF[group];
  if (column === undefined) return null;
  const value = data.value?.measures?.[item.id]?.[column];
  return value === null || value === undefined ? null : value.toFixed(2);
}

/**
 * A larger copy of the same image, where the platform is known to keep one.
 *
 * The URL on the card is the small thumbnail the platform lists; filling a
 * dialog with it is visibly soft, which rather defeats a view whose job is
 * letting you judge the picture. YouTube keeps several sizes under a
 * predictable name, so the largest is worth asking for.
 *
 * Only ever an attempt: the large copy is not generated for every video, so
 * the element falls back to the URL we already know resolves.
 */
function largeVersion(item: TrendItem): string | null {
  if (item.thumbnail === null) return null;
  const yt = /^(https:\/\/i\.ytimg\.com\/vi\/[A-Za-z0-9_-]+\/)[a-z0-9]+\.jpg/i.exec(item.thumbnail);
  return yt === null ? null : `${yt[1] ?? ''}maxresdefault.jpg`;
}

/** What the full-size view is currently showing, after any fallback. */
const zoomSrc = ref('');

watch(zoomed, (item) => {
  zoomSrc.value = item === null ? '' : (largeVersion(item) ?? item.thumbnail ?? '');
});

/** The larger copy did not exist. Drop to the one we know is there. */
function zoomFallback(): void {
  const stored = zoomed.value?.thumbnail ?? '';
  if (zoomSrc.value !== stored) zoomSrc.value = stored;
}

watch(openExamples, async (next) => {
  zoomed.value = null;
  if (next === null) {
    data.value = null;
    error.value = null;
    return;
  }
  // Thumbnails open as pictures, everything else as cards. Both remain a
  // click apart, because a thumbnail is still attached to a title worth
  // reading and a title still has a thumbnail worth seeing.
  view.value = next.dimension === 'thumbnail' ? 'gallery' : 'list';
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
        limit: next.dimension === 'thumbnail' ? 12 : 8,
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
  <v-dialog v-model="open" max-width="980" scrollable>
    <v-card v-if="request">
      <v-toolbar density="comfortable" color="surface">
        <v-toolbar-title class="text-body-1 font-weight-medium ms-4">
          {{ $t('examples.title', { what: request.title }) }}
        </v-toolbar-title>
        <!-- Available on every dimension: a title example still has an image,
             and an image example still has a title. -->
        <v-btn-toggle v-model="view" density="compact" mandatory variant="outlined" divided class="me-2">
          <v-tooltip :text="$t('examples.viewGallery')" location="bottom">
            <template #activator="{ props: tip }">
              <v-btn v-bind="tip" value="gallery" size="small" icon="mdi-view-grid-outline" />
            </template>
          </v-tooltip>
          <v-tooltip :text="$t('examples.viewList')" location="bottom">
            <template #activator="{ props: tip }">
              <v-btn v-bind="tip" value="list" size="small" icon="mdi-view-list-outline" />
            </template>
          </v-tooltip>
        </v-btn-toggle>
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

          <!-- Pictures, at a size you can actually judge. -->
          <div v-else-if="view === 'gallery'" class="gallery">
            <div v-for="item in data.items" :key="item.id" class="shot">
              <button
                type="button"
                class="shot-image"
                :title="$t('examples.zoom')"
                @click="zoomed = item"
              >
                <v-img
                  v-if="item.thumbnail"
                  :src="item.thumbnail"
                  :aspect-ratio="16 / 9"
                  cover
                  referrerpolicy="no-referrer"
                >
                  <template #error>
                    <div class="shot-fallback">
                      <v-icon :icon="TYPE_ICON[item.contentType] ?? 'mdi-image-off-outline'" />
                      <span>{{ $t('examples.noImage') }}</span>
                    </div>
                  </template>
                  <template #placeholder>
                    <div class="shot-fallback">
                      <v-progress-circular indeterminate size="20" width="2" />
                    </div>
                  </template>
                </v-img>
                <div v-else class="shot-fallback ratio">
                  <v-icon :icon="TYPE_ICON[item.contentType] ?? 'mdi-image-off-outline'" />
                  <span>{{ $t('examples.noImage') }}</span>
                </div>
                <span class="shot-score">{{ Math.round(item.score) }}</span>
              </button>

              <div class="shot-body">
                <div class="shot-title">{{ item.title }}</div>
                <div class="shot-meta">
                  <v-icon :icon="SOURCE_ICON[item.source] ?? 'mdi-web'" size="12" />
                  <span v-if="item.creator.name" class="text-truncate">{{ item.creator.name }}</span>
                  <span v-if="item.metrics.views !== null">
                    · {{ num(item.metrics.views) }} {{ $t('metric.views') }}
                  </span>
                </div>
                <div class="shot-actions">
                  <!-- What the band was decided on, so the grouping is
                       checkable rather than something to take on trust. -->
                  <v-chip v-if="measureOf(item)" size="x-small" variant="tonal" class="me-auto">
                    {{ $t(`thumbs.group.${request.group}`) }} {{ measureOf(item) }}
                  </v-chip>
                  <v-btn
                    size="x-small"
                    variant="text"
                    icon="mdi-information-outline"
                    :title="$t('examples.details')"
                    @click="openContentId = item.id"
                  />
                  <v-btn
                    size="x-small"
                    variant="text"
                    icon="mdi-open-in-new"
                    :href="item.url"
                    target="_blank"
                    rel="noreferrer noopener"
                    :title="$t('detail.openOriginal')"
                  />
                </div>
              </div>
            </div>
          </div>

          <div v-else class="d-grid ga-2">
            <TrendCard v-for="item in data.items" :key="item.id" :item="item" dense />
          </div>
        </template>
      </v-card-text>
    </v-card>
  </v-dialog>

  <!-- Full size. Stacked over the gallery rather than replacing it, so closing
       it returns you to where you were looking. -->
  <v-dialog :model-value="zoomed !== null" max-width="1100" @update:model-value="zoomed = null">
    <v-card v-if="zoomed" class="zoom-card">
      <!-- A plain img rather than v-img: the fallback has to swap the source,
           which needs the element's own error event. -->
      <img
        :src="zoomSrc"
        :alt="zoomed.title"
        class="zoom-image"
        referrerpolicy="no-referrer"
        @error="zoomFallback"
      >
      <div class="zoom-bar">
        <div class="min-width-0">
          <div class="text-body-2 text-truncate">{{ zoomed.title }}</div>
          <div class="shot-meta">
            <v-icon :icon="SOURCE_ICON[zoomed.source] ?? 'mdi-web'" size="12" />
            <span v-if="zoomed.creator.name" class="text-truncate">{{ zoomed.creator.name }}</span>
          </div>
        </div>
        <v-spacer />
        <v-btn
          size="small"
          variant="text"
          prepend-icon="mdi-open-in-new"
          :href="zoomed.url"
          target="_blank"
          rel="noreferrer noopener"
        >
          {{ $t('detail.openOriginal') }}
        </v-btn>
        <v-btn size="small" variant="text" icon="mdi-close" @click="zoomed = null" />
      </div>
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

.gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
}

.shot {
  border: 1px solid rgba(var(--v-theme-on-surface), 0.12);
  border-radius: 10px;
  overflow: hidden;
  background: rgb(var(--v-theme-surface-light));
}

.shot-image {
  display: block;
  position: relative;
  width: 100%;
  padding: 0;
  border: 0;
  background: none;
  cursor: zoom-in;
}

.shot-score {
  position: absolute;
  inset-block-start: 6px;
  inset-inline-end: 6px;
  padding: 1px 6px;
  border-radius: 6px;
  font-size: 0.7rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: #fff;
  background: rgba(0, 0, 0, 0.62);
}

.shot-fallback {
  display: grid;
  place-items: center;
  gap: 4px;
  height: 100%;
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.7rem;
}

.shot-fallback.ratio {
  aspect-ratio: 16 / 9;
}

.shot-body {
  padding: 8px 10px 6px;
}

.shot-title {
  font-size: 0.8rem;
  font-weight: 600;
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.shot-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
  font-size: 0.7rem;
  color: rgb(var(--v-theme-on-surface-variant));
  min-width: 0;
}

.shot-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-top: 6px;
}

.zoom-card {
  background: rgb(var(--v-theme-surface));
}

.zoom-image {
  display: block;
  width: 100%;
  max-height: 80vh;
  object-fit: contain;
  background: #000;
}

.zoom-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
}

.min-width-0 {
  min-width: 0;
}
</style>
