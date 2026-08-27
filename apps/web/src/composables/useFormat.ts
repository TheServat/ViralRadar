/**
 * Formatting, locale-aware.
 *
 * Persian gets Persian digits and Persian relative time for free through
 * `Intl`, which is the whole reason numbers are never concatenated by hand
 * anywhere in the interface.
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { STATE_COLORS, type TrendState } from '@/plugins/vuetify';

export const SOURCE_ICON: Record<string, string> = {
  youtube: 'mdi-youtube',
  reddit: 'mdi-reddit',
  hackernews: 'mdi-console',
  googletrends: 'mdi-google',
  googlenews: 'mdi-newspaper-variant-outline',
  wikipedia: 'mdi-book-open-page-variant',
  rss: 'mdi-rss',
  telegram: 'mdi-send',
  mastodon: 'mdi-mastodon',
  bluesky: 'mdi-cloud-outline',
  github: 'mdi-github',
  charts: 'mdi-chart-bar',
  tiktok: 'mdi-music-note',
  x: 'mdi-alpha-x-box',
  instagram: 'mdi-instagram',
};

export const TYPE_ICON: Record<string, string> = {
  video: 'mdi-movie-open',
  short_video: 'mdi-cellphone',
  image: 'mdi-image',
  text: 'mdi-text',
  link: 'mdi-link-variant',
  topic: 'mdi-magnify',
  audio: 'mdi-headphones',
  unknown: 'mdi-help-circle-outline',
};

export const STATE_ICON: Record<string, string> = {
  VIRAL: 'mdi-fire',
  HOT: 'mdi-thermometer-high',
  EMERGING: 'mdi-sprout',
  RISING: 'mdi-trending-up',
  PEAK: 'mdi-triangle-outline',
  NEW: 'mdi-new-box',
  DECLINING: 'mdi-trending-down',
  DEAD: 'mdi-circle-outline',
};

export function stateColor(state: string): string {
  return STATE_COLORS[state as TrendState] ?? STATE_COLORS.DEAD;
}

export function useFormat() {
  const { locale, t } = useI18n();

  const compact = computed(
    () => new Intl.NumberFormat(locale.value, { notation: 'compact', maximumFractionDigits: 1 }),
  );
  const plain = computed(() => new Intl.NumberFormat(locale.value));

  function num(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) return t('app.none');
    return compact.value.format(value);
  }

  function exact(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) return t('app.none');
    return plain.value.format(value);
  }

  function percent(value: number | null | undefined, digits = 1): string {
    if (value === null || value === undefined || !Number.isFinite(value)) return t('app.none');
    return new Intl.NumberFormat(locale.value, {
      style: 'percent',
      maximumFractionDigits: digits,
    }).format(value);
  }

  /** "3 minutes ago", relative to now, in the active locale. */
  function ago(epochSeconds: number | null | undefined): string {
    if (!epochSeconds) return t('app.none');
    const diff = Math.max(0, Math.floor(Date.now() / 1000) - epochSeconds);
    if (diff < 10) return t('time.now');
    if (diff < 60) return t('time.secondsAgo', { n: plain.value.format(diff) });
    if (diff < 3600) return t('time.minutesAgo', { n: plain.value.format(Math.floor(diff / 60)) });
    if (diff < 86400) return t('time.hoursAgo', { n: plain.value.format(Math.floor(diff / 3600)) });
    return t('time.daysAgo', { n: plain.value.format(Math.floor(diff / 86400)) });
  }

  function age(hours: number | null | undefined): string {
    if (hours === null || hours === undefined) return t('app.none');
    if (hours < 1) return t('time.minutesOld', { n: plain.value.format(Math.round(hours * 60)) });
    if (hours < 48) return t('time.hoursOld', { n: hours.toFixed(1) });
    return t('time.daysOld', { n: plain.value.format(Math.round(hours / 24)) });
  }

  function clock(epochSeconds: number): string {
    return new Intl.DateTimeFormat(locale.value, { hour: '2-digit', minute: '2-digit' }).format(
      new Date(epochSeconds * 1000),
    );
  }

  function dateTime(epochSeconds: number): string {
    return new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(epochSeconds * 1000),
    );
  }

  return { num, exact, percent, ago, age, clock, dateTime };
}
