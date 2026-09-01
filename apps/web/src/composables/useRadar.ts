/**
 * Shared application state.
 *
 * One module-level store rather than a state library: the interface has a
 * handful of globals - health, facets, interventions, the open detail dialog -
 * and Vue's own reactivity already covers that without another dependency.
 */
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { api, ApiError, authEpoch, tokenQuery } from '@/api/client';
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

/**
 * The bar whose examples are open, or null.
 *
 * Carries the page's own filters verbatim rather than rebuilding them: the
 * examples must come from the same population the bar was computed from, and a
 * second construction of the query would be the easiest place for that to
 * quietly stop being true.
 */
export interface ExampleRequest {
  readonly dimension: 'format' | 'timing' | 'thumbnail';
  readonly group: string;
  readonly bucket: string;
  /** How the bar is labelled on the page, so the dialog names the same thing. */
  readonly title: string;
  /** What the bar said, repeated in the dialog so the two cannot be confused. */
  readonly lift: number | null;
  readonly proven: boolean;
  /** The page's filters, already serialised. */
  readonly filters: Record<string, string | number | null>;
}

export const openExamples = ref<ExampleRequest | null>(null);

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
  } catch (e) {
    // The toast is the only place this can be reported: the button is in the
    // app bar and has nowhere to put an error of its own.
    notify(e instanceof ApiError ? e.message : String(e));
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
  // The token goes in the URL because EventSource cannot send a header. When
  // no token is configured this is the same string it always was.
  stream = new EventSource(`/api/v1/stream${tokenQuery('')}`);
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
 * How long to wait after a change before asking the server.
 *
 * There was no wait at all, so every keystroke in the search box was a
 * request, and the server is single-threaded: each one blocked the API, the
 * live stream and the scheduler for as long as it took. Typing "elections"
 * cost most of a second of that, and the searches were thrown away as fast as
 * they arrived.
 *
 * Short enough not to feel laggy while typing, long enough that a word becomes
 * one request instead of nine.
 */
const SETTLE_MS = 180;

/**
 * Loads once, reloads when `deps` change, and never leaves a page without an
 * explanation: either data, a spinner, or the reason it failed.
 *
 * Changes are allowed to settle first. The in-flight guard below already stops
 * an older answer overwriting a newer one; this stops the requests being made
 * at all, which is the part the server pays for.
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

  let settling: ReturnType<typeof setTimeout> | undefined;
  watch(
    // The auth epoch alongside the caller's own dependencies: when a token is
    // accepted, everything that failed for want of one reloads in place.
    [deps, () => authEpoch.value],
    () => {
      // The spinner starts immediately even though the request does not, so a
      // fast typist sees the page reacting rather than looking frozen.
      loading.value = true;
      if (settling !== undefined) clearTimeout(settling);
      settling = setTimeout(() => void reload(), SETTLE_MS);
    },
    { deep: true },
  );

  // The settle timer outlives the component that armed it otherwise: leaving a
  // page mid-typing fired its abandoned requests 180ms later, queueing ahead of
  // the new page's first load on a server that answers one at a time.
  onScopeDispose(() => {
    if (settling !== undefined) clearTimeout(settling);
  });

  return { data, loading, error, reload };
}
