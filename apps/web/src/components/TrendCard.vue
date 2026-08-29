<script setup lang="ts">
import { computed } from 'vue';
import type { TrendItem } from '@/api/types';
import { SOURCE_ICON, TYPE_ICON, useFormat } from '@/composables/useFormat';
import { useCodeLabel } from '@/composables/useCodes';
import { markHidden, notify, openContentId } from '@/composables/useRadar';
import { api } from '@/api/client';
import { useI18n } from 'vue-i18n';
import StateChip from './StateChip.vue';
import ScoreDial from './ScoreDial.vue';
import Thumb from './Thumb.vue';

const props = defineProps<{
  item: TrendItem;
  dense?: boolean;
  /**
   * This card is being shown *because* it is hidden, so its action is to put
   * it back. Passed by the page rather than read from the item: the only list
   * that shows hidden items is the one that asked for them.
   */
  hidden?: boolean;
  /**
   * What the surrounding list is ordered by.
   *
   * A list sorted by acceleration while every card shows a score reads as
   * unsorted — the scores genuinely do go up and down. Showing the ordering
   * value makes the sequence legible instead of looking broken.
   */
  sortedBy?: 'score' | 'acceleration' | 'velocity' | 'recent' | 'creator_anomaly' | 'relevance';
}>();

/** The ordering value, when it is something other than the score on the dial. */
const orderValue = computed(() => {
  const s = props.item.signals;
  if (props.sortedBy === 'acceleration' && s.acceleration !== null) {
    return { label: 'metric.acceleration', value: num(Math.round(s.acceleration)) };
  }
  if (props.sortedBy === 'relevance' && props.item.relevance !== null) {
    // Shown as a percentage because "0.80" invites being read as a score out
    // of one; it is a closeness, and a percentage reads that way.
    return { label: 'metric.relevance', value: `${Math.round(props.item.relevance * 100)}%` };
  }
  if (props.sortedBy === 'velocity' && s.velocity !== null) {
    return {
      label: 'metric.perHour',
      value: `${num(Math.round(s.velocity))} ${props.item.metrics.primary.name}`,
    };
  }
  return null;
});
const { num, age } = useFormat();
const label = useCodeLabel();
const { t } = useI18n();

/**
 * Marks this item as dealt with.
 *
 * Optimistic: the card disappears from the list immediately, because waiting
 * for a round trip to hide something the user has decided about feels broken.
 * The set is shared, so every list showing this item hides it at once.
 */
/**
 * Hides this item, or puts it back when the list is showing hidden ones.
 *
 * Optimistic either way: the card leaves the list immediately, because waiting
 * for a round trip to act on a decision the user has already made feels broken.
 * On failure the change is reversed, so the interface never claims something
 * the server did not do.
 */
async function toggleHidden(): Promise<void> {
  const puttingBack = props.hidden === true;
  markHidden(props.item.id, !puttingBack);

  try {
    if (puttingBack) await api.unarchive(props.item.id);
    else await api.archive(props.item.id, 'used');
    notify(t(puttingBack ? 'archive.restored' : 'archive.hidden'));
  } catch {
    markHidden(props.item.id, puttingBack);
    notify(t('archive.failed'));
  }
}

/** Only the metrics this platform actually returned. Nothing is invented. */
const stats = computed(() => {
  const m = props.item.metrics;
  const out: { value: string; unit: string }[] = [];
  if (m.views !== null) out.push({ value: num(m.views), unit: 'metric.views' });
  if (m.views === null && m.nativeScore !== null) out.push({ value: num(m.nativeScore), unit: 'metric.points' });
  if (m.likes !== null) out.push({ value: num(m.likes), unit: 'metric.likes' });
  if (m.comments !== null) out.push({ value: num(m.comments), unit: 'metric.comments' });
  if (m.shares !== null) out.push({ value: num(m.shares), unit: 'metric.shares' });
  return out;
});

const velocity = computed(() =>
  props.item.signals.velocity === null || props.item.signals.velocity <= 0
    ? null
    : num(props.item.signals.velocity),
);

/** What this platform's primary metric is called, so "/h" is never ambiguous. */
const velocityUnit = computed(() =>
  props.item.metrics.primary.name === 'views' ? 'metric.views' : 'metric.points',
);

const anomaly = computed(() => {
  const a = props.item.signals.creatorAnomaly;
  return a !== null && a >= 3 ? a : null;
});

const accelerating = computed(
  () => props.item.signals.acceleration !== null && props.item.signals.acceleration > 0,
);
</script>

<template>
  <v-card
    class="trend-card"
    :class="{ dense }"
    hover
    @click="openContentId = item.id"
  >
    <div class="d-flex ga-3 pa-3">
      <div
        class="thumb flex-0-0"
        :style="{ width: dense ? '64px' : '88px', height: dense ? '48px' : '64px' }"
      >
        <Thumb :src="item.thumbnail" :alt="item.title">
          <template #fallback>
            <v-icon :icon="TYPE_ICON[item.contentType] ?? 'mdi-help-circle-outline'" />
          </template>
        </Thumb>
      </div>

      <div class="flex-1-1 min-width-0">
        <div class="title-line">{{ item.title }}</div>

        <div class="d-flex flex-wrap align-center ga-1 mt-1">
          <StateChip :state="item.state" />
          <v-chip size="x-small" variant="text" :prepend-icon="SOURCE_ICON[item.source] ?? 'mdi-web'">
            {{ item.source }}
          </v-chip>
          <!-- The creator's own page, when the source gave us one. -->
          <a
            v-if="item.creator.name && item.creator.url"
            :href="item.creator.url"
            target="_blank"
            rel="noreferrer noopener"
            class="meta creator-link text-truncate"
            @click.stop
          >
            {{ item.creator.name }}
            <template v-if="item.creator.followers !== null">
              · {{ num(item.creator.followers) }} {{ $t('metric.followers') }}
            </template>
          </a>
          <span v-else-if="item.creator.name" class="meta text-truncate">
            {{ item.creator.name }}
            <template v-if="item.creator.followers !== null">
              · {{ num(item.creator.followers) }} {{ $t('metric.followers') }}
            </template>
          </span>
          <v-tooltip :text="$t('detail.firstSeen', { when: age(item.ageHours) })">
            <template #activator="{ props: tip }">
              <span v-bind="tip" class="meta faint">
                <v-icon size="11" icon="mdi-clock-fast" /> {{ age(item.ageHours) }}
              </span>
            </template>
          </v-tooltip>
          <v-chip v-if="item.language.code" size="x-small" variant="text" class="faint">
            {{ label.language(item.language.code) }}
          </v-chip>
          <v-chip v-if="item.country.code" size="x-small" variant="text" class="faint">
            {{ label.country(item.country.code) }}
          </v-chip>
        </div>

        <div class="d-flex flex-wrap align-center ga-3 mt-2">
          <span v-for="s in stats" :key="s.unit" class="stat">
            <b>{{ s.value }}</b> {{ $t(s.unit) }}
          </span>
          <v-tooltip :text="$t('metric.velocityHint', { metric: $t(velocityUnit) })">
            <template #activator="{ props: tip }">
              <span v-if="velocity" v-bind="tip" class="stat accent-text">
                <v-icon size="12" icon="mdi-speedometer" />
                <b>{{ velocity }}</b> {{ $t(velocityUnit) }}{{ $t('metric.perHour') }}
              </span>
            </template>
          </v-tooltip>
          <span v-if="stats.length === 0 && !velocity" class="stat faint">
            {{ $t('metric.noMetrics') }}
          </span>
        </div>

        <div v-if="anomaly || accelerating || orderValue" class="d-flex flex-wrap ga-1 mt-2">
          <!-- First, because it is why this card sits where it does. -->
          <v-chip
            v-if="orderValue"
            size="x-small"
            color="primary"
            variant="tonal"
            prepend-icon="mdi-sort-variant"
          >
            {{ $t(orderValue.label) }} {{ orderValue.value }}
          </v-chip>
          <v-chip v-if="anomaly" size="x-small" color="VIRAL" variant="tonal" prepend-icon="mdi-rocket-launch">
            {{ Math.round(anomaly) }}{{ $t('metric.times') }} {{ $t('metric.creatorAnomaly') }}
          </v-chip>
          <v-chip
            v-if="accelerating && sortedBy !== 'acceleration'"
            size="x-small"
            color="EMERGING"
            variant="tonal"
            prepend-icon="mdi-chevron-double-up"
          >
            {{ $t('metric.acceleration') }}
          </v-chip>
        </div>
      </div>

      <div class="d-flex flex-column align-center ga-1">
        <ScoreDial :score="item.score" :confidence="item.confidence" :state="item.state" />
        <!-- Marks it dealt with. Not a delete: it keeps being measured and keeps
             feeding baselines, it just stops competing for attention. -->
        <v-tooltip :text="$t(hidden ? 'archive.restore' : 'archive.hide')">
          <template #activator="{ props: tip }">
            <v-btn
              v-bind="tip"
              :icon="hidden ? 'mdi-undo-variant' : 'mdi-check-circle-outline'"
              size="x-small"
              variant="text"
              class="open-btn"
              @click.stop="toggleHidden"
            />
          </template>
        </v-tooltip>
        <v-tooltip :text="$t('detail.openOriginal')">
          <template #activator="{ props: tip }">
            <v-btn
              v-bind="tip"
              :href="item.url"
              target="_blank"
              rel="noreferrer noopener"
              icon="mdi-open-in-new"
              size="x-small"
              variant="text"
              class="open-btn"
              @click.stop
            />
          </template>
        </v-tooltip>
      </div>
    </div>
  </v-card>
</template>

<style scoped>
.creator-link {
  color: rgb(var(--v-theme-on-surface-variant));
  text-decoration: none;
}
.creator-link:hover {
  color: rgb(var(--v-theme-primary));
  text-decoration: underline;
}
.open-btn {
  opacity: 0.45;
  transition: opacity 0.15s ease;
}
.trend-card:hover .open-btn {
  opacity: 1;
}
.trend-card {
  cursor: pointer;
  transition: border-color 0.15s ease, transform 0.15s ease;
}
.trend-card:hover {
  transform: translateY(-1px);
  border-color: rgb(var(--v-theme-primary));
}
.min-width-0 {
  min-width: 0;
}
.title-line {
  font-size: 0.9rem;
  font-weight: 600;
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.dense .title-line {
  font-size: 0.84rem;
  -webkit-line-clamp: 1;
  line-clamp: 1;
}
.thumb {
  border-radius: 8px;
  overflow: hidden;
}
.meta {
  font-size: 0.72rem;
  color: rgb(var(--v-theme-on-surface-variant));
  max-width: 22ch;
}
.stat {
  font-size: 0.75rem;
  color: rgb(var(--v-theme-on-surface-variant));
  font-variant-numeric: tabular-nums;
}
.stat b {
  color: rgb(var(--v-theme-on-surface));
  font-weight: 600;
}
.accent-text b {
  color: rgb(var(--v-theme-accent));
}
.faint {
  opacity: 0.7;
}
</style>
