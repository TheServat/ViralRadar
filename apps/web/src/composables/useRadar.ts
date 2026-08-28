/**
 * Shared application state.
 *
 * One module-level store rather than a state library: the interface has a
 * handful of globals - health, facets, interventions, the open detail dialog -
 * and Vue's own reactivity already covers that without another dependency.
 */
import { computed, ref, shallowRef, watch } from 'vue';
import { api, ApiError } from '@/api/client';
import type { Facets, HealthData, Intervention } from '@/api/types';

// ── Global state ───────────────────────────────────────────────────────────

export const health = shallowRef<HealthData | null>(null);
export const facets = shallowRef<Facets>({ languages: [], countries: [], sources: [] });
export const interventions = shallowRef<Intervention[]>([]);
export const toast = ref<{ text: string; color: string } | null>(null);
export const busy = ref(false);

/**
 * What the user hid or put back *during this session*.
 *
 * Two sets rather than one, because a single set would have to mean both "is
 * hidden" and "was changed just now", and those differ: an item hidden
 * yesterday is hidden but was not changed, and the hidden list must still show
 * it. Tracking the changes instead keeps each list correct without re-fetching
 * after every click.
 */
export const hiddenNow = ref<Set<string>>(new Set());
export const restoredNow = ref<Set<string>>(new Set());

/** Records a change, keeping the two sets mutually exclusive. */
export function markHidden(id: string, hidden: boolean): void {
  const hid = new Set(hiddenNow.value);
  const back = new Set(restoredNow.value);
  if (hidden) {
    hid.add(id);
    back.delete(id);
  } else {
    back.add(id);
    hid.delete(id);
  }
  hiddenNow.value = hid;
  restoredNow.value = back;
}

/** Content id currently open in the detail dialog, or null. */
export const openContentId = ref<string | null>(null);
export const openClusterId = ref<string | null>(null);

export const stale = computed(() => {
  const last = health.value?.lastDiscovery;
  return last === null || last === undefined || Date.now() / 1000 - last > 3600;
});

export function notify(text: string, color = 'surface-light'): void {
  toast.value = { text, color };
}

export async function refreshHealth(): Promise<void> {
  try {
    health.value = await api.health();
  } catch {
    // The header badge degrades quietly; it must never block a page.
    health.value = null;
  }
}

export async function refreshFacets(): Promise<void> {
  try {
    facets.value = await api.facets();
  } catch {
    facets.value = { languages: [], countries: [], sources: [] };
  }
}

export async function refreshInterventions(): Promise<void> {
  try {
    interventions.value = (await api.interventions()).items;
  } catch {
    interventions.value = [];
  }
}

export async function collectNow(): Promise<void> {
  busy.value = true;
  try {
    await api.collect();
    notify('collect.queued');
  } finally {
    busy.value = false;
  }
}

// ── Live updates ───────────────────────────────────────────────────────────

let stream: EventSource | null = null;

/**
 * Tails the server's durable event log. Reconnection is the browser's job -
 * EventSource retries on its own, and the server sends a retry hint.
 */
export function startStream(onEvent: (type: string) => void): void {
  if (stream !== null) return;
  stream = new EventSource('/api/v1/stream');
  for (const type of [
    'trend.detected',
    'trend.peaked',
    'creator.breakout',
    'manual.intervention.required',
    'source.error',
  ]) {
    stream.addEventListener(type, () => {
      onEvent(type);
      void refreshHealth();
      if (type === 'manual.intervention.required') void refreshInterventions();
    });
  }
}

export function stopStream(): void {
  stream?.close();
  stream = null;
}

// ── Async page helper ──────────────────────────────────────────────────────

export interface AsyncState<T> {
  data: ReturnType<typeof shallowRef<T | null>>;
  loading: ReturnType<typeof ref<boolean>>;
  error: ReturnType<typeof ref<string | null>>;
  reload: () => Promise<void>;
}

/**
 * Loads once, reloads when `deps` change, and never leaves a page without an
 * explanation: either data, a spinner, or the reason it failed.
 */
export function useAsync<T>(loader: () => Promise<T>, deps: () => unknown = () => null): AsyncState<T> {
  const data = shallowRef<T | null>(null);
  const loading = ref(true);
  const error = ref<string | null>(null);
  let token = 0;

  async function reload(): Promise<void> {
    const mine = ++token;
    loading.value = true;
    error.value = null;
    try {
      const result = await loader();
      // A slower earlier request must not overwrite a newer result.
      if (mine === token) data.value = result;
    } catch (e) {
      if (mine === token) error.value = e instanceof ApiError ? e.message : String(e);
    } finally {
      if (mine === token) loading.value = false;
    }
  }

  void reload();
  watch(deps, () => void reload(), { deep: true });

  return { data, loading, error, reload };
}
