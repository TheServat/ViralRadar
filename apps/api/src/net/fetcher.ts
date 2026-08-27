/**
 * The one way this application talks to the internet.
 *
 * Every request goes through a per-host token bucket, a circuit breaker, a
 * timeout and an SSRF check. Source plugins never call `fetch` themselves,
 * which is what makes "be polite to every platform" enforceable in one place
 * instead of hoping six adapters each remembered to.
 *
 * A 429 is obeyed, never routed around. There is no IP rotation here by design.
 */
import { config } from '../config.ts';
import { createLogger } from '../logger.ts';
import { err, isRadarError, RadarError } from '../errors.ts';
import { assertSafeUrl, type UrlGuardOptions } from './ssrf.ts';

const log = createLogger('net');

export const USER_AGENT = 'viral-radar/1.0 (+personal research instance)';

// ── Per-host politeness ────────────────────────────────────────────────────

interface HostState {
  /** Earliest epoch ms at which the next request may start. */
  nextAllowedAt: number;
  consecutiveFailures: number;
  /** Epoch ms until which the breaker stays open. */
  openUntil: number;
  /** Set when the host itself asked us to wait. */
  cooldownUntil: number;
}

const hosts = new Map<string, HostState>();

function hostState(host: string): HostState {
  let s = hosts.get(host);
  if (s === undefined) {
    s = { nextAllowedAt: 0, consecutiveFailures: 0, openUntil: 0, cooldownUntil: 0 };
    hosts.set(host, s);
  }
  return s;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Serialises requests to one host at the configured rate. */
async function acquireSlot(host: string, rps: number): Promise<void> {
  const state = hostState(host);
  const now = Date.now();

  if (state.openUntil > now) {
    throw err.unavailable(
      `Circuit breaker open for ${host} for another ${Math.ceil((state.openUntil - now) / 1000)}s`,
      { host },
    );
  }
  if (state.cooldownUntil > now) {
    throw err.rateLimit(
      `${host} asked for a cooldown; ${Math.ceil((state.cooldownUntil - now) / 1000)}s remaining`,
      Math.ceil((state.cooldownUntil - now) / 1000),
    );
  }

  const minGapMs = 1000 / Math.max(rps, 0.05);
  const startAt = Math.max(now, state.nextAllowedAt);
  state.nextAllowedAt = startAt + minGapMs;
  const wait = startAt - now;
  if (wait > 0) await sleep(wait);
}

function recordSuccess(host: string): void {
  const s = hostState(host);
  s.consecutiveFailures = 0;
  s.openUntil = 0;
}

function recordFailure(host: string): void {
  const s = hostState(host);
  s.consecutiveFailures++;
  if (s.consecutiveFailures >= 5) {
    // Back off hard rather than keep knocking on a door that is not opening.
    const minutes = Math.min(2 ** (s.consecutiveFailures - 5), 30);
    s.openUntil = Date.now() + minutes * 60_000;
    log.warn('circuit breaker opened', { host, minutes, failures: s.consecutiveFailures });
  }
}

function applyCooldown(host: string, seconds: number): void {
  hostState(host).cooldownUntil = Date.now() + seconds * 1000;
}

/** Exposed for the health endpoint. */
export function networkState(): { host: string; failures: number; openFor: number; cooldownFor: number }[] {
  const now = Date.now();
  return [...hosts.entries()].map(([host, s]) => ({
    host,
    failures: s.consecutiveFailures,
    openFor: Math.max(0, Math.ceil((s.openUntil - now) / 1000)),
    cooldownFor: Math.max(0, Math.ceil((s.cooldownUntil - now) / 1000)),
  }));
}

// ── Challenge detection ────────────────────────────────────────────────────

const CHALLENGE_MARKERS: readonly RegExp[] = [
  /just a moment\.\.\./i,
  /cf-browser-verification/i,
  /challenge-platform/i,
  /captcha-delivery/i,
  /<title>\s*attention required/i,
  /please verify you are a human/i,
  /enable javascript and cookies to continue/i,
];

/**
 * A challenge page is a hard stop, not a puzzle to solve. The caller turns this
 * into a manual-intervention record so a human can decide what to do.
 */
export function detectChallenge(body: string): boolean {
  const head = body.slice(0, 4000);
  return CHALLENGE_MARKERS.some((re) => re.test(head));
}

// ── Request ────────────────────────────────────────────────────────────────

export interface FetchOptions {
  readonly method?: 'GET' | 'POST';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs?: number;
  readonly retries?: number;
  /** Requests per second for this host; defaults to the global setting. */
  readonly rps?: number;
  readonly guard?: UrlGuardOptions;
  /** Label used in logs and errors, usually the source id. */
  readonly context?: string;
}

export interface FetchResult {
  readonly status: number;
  readonly url: string;
  readonly body: string;
  readonly headers: Headers;
}

function retryAfterSeconds(headers: Headers): number | null {
  const raw = headers.get('retry-after');
  if (raw === null) return null;
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber)) return Math.max(0, asNumber);
  const asDate = Date.parse(raw);
  if (Number.isFinite(asDate)) return Math.max(0, Math.round((asDate - Date.now()) / 1000));
  return null;
}

async function once(url: URL, opts: FetchOptions): Promise<FetchResult> {
  const timeout = opts.timeoutMs ?? config.net.timeoutMs;
  const response = await fetch(url, {
    method: opts.method ?? 'GET',
    headers: {
      'User-Agent': USER_AGENT,
      Accept: '*/*',
      'Accept-Language': 'en;q=0.9,*;q=0.5',
      ...opts.headers,
    },
    ...(opts.body === undefined ? {} : { body: opts.body }),
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout),
  });

  const body = await response.text();
  return { status: response.status, url: response.url, body, headers: response.headers };
}

/**
 * Fetch with retries, backoff and jitter. Errors that a retry cannot fix -
 * auth, configuration, challenges, explicit rate limits - are thrown
 * immediately rather than hammered at.
 */
export async function request(rawUrl: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const url = await assertSafeUrl(rawUrl, opts.guard);
  const host = url.hostname;
  const maxAttempts = (opts.retries ?? config.net.maxRetries) + 1;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await acquireSlot(host, opts.rps ?? config.net.hostRps);

    try {
      const res = await once(url, opts);

      if (res.status === 429) {
        const wait = retryAfterSeconds(res.headers) ?? 60;
        applyCooldown(host, wait);
        recordFailure(host);
        throw err.rateLimit(`${host} returned 429; honouring a ${wait}s cooldown`, wait);
      }
      if (res.status === 401 || res.status === 403) {
        recordFailure(host);
        if (detectChallenge(res.body)) {
          throw err.captcha(`${host} served a human-verification challenge`, {
            host,
            url: url.toString(),
            context: opts.context,
          });
        }
        throw err.authRequired(`${host} returned ${res.status}`, {
          host,
          url: url.toString(),
          context: opts.context,
          body: res.body.slice(0, 400),
        });
      }
      if (res.status >= 500) {
        recordFailure(host);
        throw err.network(`${host} returned ${res.status}`);
      }
      if (res.status >= 400) {
        recordFailure(host);
        throw new RadarError('SOURCE_UNAVAILABLE', `${host} returned ${res.status}`, {
          retryable: false,
          details: { status: res.status, body: res.body.slice(0, 300) },
        });
      }
      if (detectChallenge(res.body)) {
        recordFailure(host);
        throw err.captcha(`${host} served a human-verification challenge`, {
          host,
          url: url.toString(),
          context: opts.context,
        });
      }

      recordSuccess(host);
      return res;
    } catch (e) {
      lastError = e;
      const retryable = isRadarError(e) ? e.retryable : true;
      if (!retryable || attempt === maxAttempts) break;

      // Exponential backoff with full jitter: several sources refreshing at the
      // same time must not retry in lockstep.
      const backoff = Math.min(1000 * 2 ** (attempt - 1), 20_000);
      const wait = Math.random() * backoff;
      log.debug('retrying', { host, attempt, waitMs: Math.round(wait), context: opts.context });
      await sleep(wait);
    }
  }

  if (isRadarError(lastError)) throw lastError;
  throw err.network(`Request to ${host} failed`, lastError);
}

export async function getJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const res = await request(url, { ...opts, headers: { Accept: 'application/json', ...opts.headers } });
  try {
    return JSON.parse(res.body) as T;
  } catch (e) {
    throw err.parsing(`Response from ${new URL(res.url).hostname} was not valid JSON`, e);
  }
}

export async function getText(url: string, opts: FetchOptions = {}): Promise<string> {
  return (await request(url, opts)).body;
}

/** Runs `tasks` with a bounded number in flight - a bulkhead, not a stampede. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = { status: 'fulfilled', value: await fn(items[index] as T, index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}
