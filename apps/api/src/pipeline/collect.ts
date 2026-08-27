/**
 * The acquisition pipeline.
 *
 *   discover -> normalise -> deduplicate -> store -> snapshot metrics
 *
 * Every source runs independently and every source is allowed to fail. A plugin
 * that throws is recorded as unhealthy, its error is classified, and the run
 * continues with the others - one broken platform must never stop the radar.
 */

import { createLogger } from '../logger.ts';
import { isRadarError, needsHuman, type ErrorKind } from '../errors.ts';
import { activePlugins, createContext, pluginById, statusOf, type InterventionRequest } from '../sources/registry.ts';
import type { SourcePlugin } from '../sources/types.ts';
import { detectLanguage, contentTokens, extractEntities, simhash } from '../core/text.ts';
import { EMPTY_METRICS, nowSec, type RawContent, type SourceStatus } from '../core/types.ts';
import * as repo from '../db/repo.ts';

const log = createLogger('collect');

// ── Enrichment ─────────────────────────────────────────────────────────────

/**
 * Languages spoken essentially in one country. Used only as a weak fallback, at
 * low confidence and clearly labelled - a French-language post is not evidence
 * of France, so French is deliberately absent from this map.
 */
const LANGUAGE_COUNTRY: Readonly<Record<string, string>> = {
  fa: 'IR',
  ja: 'JP',
  ko: 'KR',
  th: 'TH',
  he: 'IL',
  el: 'GR',
  tr: 'TR',
  pl: 'PL',
  id: 'ID',
  vi: 'VN',
  hi: 'IN',
};

interface Enriched {
  readonly lang: string | null;
  readonly langConfidence: number | null;
  readonly country: string | null;
  readonly countryConfidence: number | null;
  readonly countrySource: string | null;
  readonly keywords: string[];
  readonly hashtags: string[];
  readonly simhash: string;
}

export function enrich(item: RawContent): Enriched {
  const text = `${item.title}\n${item.body ?? ''}`;
  const language = detectLanguage(text);
  const entities = extractEntities(text);

  const tokens = contentTokens(text);
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  const keywords = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([term]) => term);

  const hashtags = [...new Set([...(item.hashtags ?? []), ...entities.hashtags])].slice(0, 15);

  // Country: prefer what the source actually told us; fall back to language
  // only as a low-confidence hint, and always record which it was.
  let country: string | null = item.country?.value ?? null;
  let countryConfidence: number | null = item.country?.confidence ?? null;
  let countrySource: string | null = item.country?.source ?? null;

  if (country === null && language.code !== null) {
    const guess = LANGUAGE_COUNTRY[language.code];
    if (guess !== undefined) {
      country = guess;
      countryConfidence = Math.min(0.35, language.confidence);
      countrySource = 'language';
    }
  }

  return {
    lang: language.code,
    langConfidence: language.code === null ? null : language.confidence,
    country,
    countryConfidence,
    countrySource,
    keywords,
    hashtags,
    simhash: simhash(text),
  };
}

// ── Persistence of one item ────────────────────────────────────────────────

function store(item: RawContent, now: number): { id: string; isNew: boolean } {
  const id = repo.contentIdOf(item.sourceId, item.externalId);
  const enriched = enrich(item);

  const isNew = repo.upsertContent({
    id,
    source: item.sourceId,
    externalId: item.externalId,
    url: item.url,
    canonicalUrl: null,
    title: item.title.slice(0, 500),
    body: item.body?.slice(0, 4000) ?? null,
    contentType: item.contentType,
    authorId: item.authorId ?? null,
    authorName: item.authorName ?? null,
    thumbnailUrl: item.thumbnailUrl ?? null,
    lang: enriched.lang,
    langConfidence: enriched.langConfidence,
    country: enriched.country,
    countryConfidence: enriched.countryConfidence,
    countrySource: enriched.countrySource,
    publishedAt: item.publishedAt,
    publishedAtSource: item.publishedAtSource ?? null,
    seenAt: now,
    region: item.region ?? null,
    keywords: enriched.keywords,
    hashtags: enriched.hashtags,
    simhash: enriched.simhash,
    raw: item.raw ?? null,
  });

  repo.insertMetricSnapshot(id, now, item.metrics);

  if (item.authorId !== null && item.authorId !== undefined) {
    repo.upsertCreator({
      source: item.sourceId,
      externalId: item.authorId,
      name: item.authorName ?? null,
      url: item.authorUrl ?? null,
      followers: item.authorFollowers ?? null,
      now,
    });
  }

  if (isNew) repo.appendEvent('content.discovered', item.sourceId, id, { title: item.title.slice(0, 120) });
  return { id, isNew };
}

// ── Error classification ───────────────────────────────────────────────────

function statusFor(kind: ErrorKind): SourceStatus {
  switch (kind) {
    case 'RATE_LIMIT':
      return 'RATE_LIMITED';
    case 'AUTH_REQUIRED':
      return 'AUTH_REQUIRED';
    case 'CAPTCHA_REQUIRED':
      return 'CAPTCHA_REQUIRED';
    case 'CONFIGURATION_REQUIRED':
      return 'CONFIGURATION_REQUIRED';
    case 'SOURCE_UNAVAILABLE':
      return 'DEGRADED';
    default:
      return 'ERROR';
  }
}

function interventionType(kind: ErrorKind): 'CAPTCHA' | 'LOGIN' | 'CONFIGURATION' {
  if (kind === 'CAPTCHA_REQUIRED') return 'CAPTCHA';
  if (kind === 'AUTH_REQUIRED') return 'LOGIN';
  return 'CONFIGURATION';
}

function onIntervention(request: InterventionRequest, now: number): void {
  repo.openIntervention({
    source: request.source,
    type: request.type,
    message: request.message,
    url: request.url,
    now,
  });
  repo.appendEvent('manual.intervention.required', request.source, null, { type: request.type });
}

// ── Discovery ──────────────────────────────────────────────────────────────

export interface SourceRunResult {
  readonly source: string;
  readonly ok: boolean;
  readonly items: number;
  readonly newItems: number;
  readonly error: string | null;
  readonly durationMs: number;
}

async function runDiscovery(plugin: SourcePlugin, now: number): Promise<SourceRunResult> {
  const started = Date.now();
  const ctx = createContext(plugin.id, (r) => onIntervention(r, now), () => now);

  try {
    const items = await plugin.discover(ctx);
    let newItems = 0;
    for (const item of items) {
      try {
        if (store(item, now).isNew) newItems++;
      } catch (e) {
        // One malformed item must not discard the whole batch.
        log.warn('item rejected', { source: plugin.id, external: item.externalId, error: (e as Error).message });
      }
    }

    repo.recordRun({
      source: plugin.id,
      status: 'UP',
      items: items.length,
      ok: true,
      error: null,
      errorKind: null,
      now,
    });
    log.info('discovered', { source: plugin.id, items: items.length, new: newItems, ms: Date.now() - started });
    return { source: plugin.id, ok: true, items: items.length, newItems, error: null, durationMs: Date.now() - started };
  } catch (e) {
    const kind: ErrorKind = isRadarError(e) ? e.kind : 'INTERNAL';
    const message = (e as Error).message;

    repo.recordRun({
      source: plugin.id,
      status: statusFor(kind),
      items: 0,
      ok: false,
      error: message.slice(0, 500),
      errorKind: kind,
      now,
    });
    repo.appendEvent('source.error', plugin.id, null, { kind, message: message.slice(0, 200) });

    if (needsHuman(kind)) {
      onIntervention(
        {
          source: plugin.id,
          type: interventionType(kind),
          message: message.slice(0, 500),
          url: (isRadarError(e) ? (e.details['helpUrl'] as string | undefined) : undefined) ?? null,
        },
        now,
      );
    }

    log.warn('discovery failed', { source: plugin.id, kind, error: message });
    return { source: plugin.id, ok: false, items: 0, newItems: 0, error: message, durationMs: Date.now() - started };
  }
}

/** Runs discovery for every enabled, valid source. */
export async function collectAll(now = nowSec()): Promise<SourceRunResult[]> {
  const plugins = activePlugins();
  if (plugins.length === 0) {
    log.warn('no active sources - check SOURCES_ENABLED and required credentials');
  }
  // Sequential on purpose: several sources at once would multiply the load on
  // a home connection for no benefit at this scale.
  const results: SourceRunResult[] = [];
  for (const plugin of plugins) results.push(await runDiscovery(plugin, now));
  return results;
}

// ── Metric refresh ─────────────────────────────────────────────────────────

export const REFRESH_TIERS = {
  HOT: { windowSec: 12 * 3600, minGapSec: 4 * 60, limit: 120 },
  NORMAL: { windowSec: 48 * 3600, minGapSec: 55 * 60, limit: 200 },
} as const;

export type RefreshTier = keyof typeof REFRESH_TIERS;

/**
 * Re-reads metrics for items already known, which is what turns a single
 * observation into a time series. Without this pass there is no velocity, no
 * acceleration, and nothing to detect.
 */
export async function refreshMetrics(tier: RefreshTier, now = nowSec()): Promise<SourceRunResult[]> {
  const settings = REFRESH_TIERS[tier];
  const results: SourceRunResult[] = [];

  for (const plugin of activePlugins()) {
    if (plugin.refresh === undefined || !plugin.capabilities.supportsRefresh) continue;

    const targets = repo.refreshTargets({
      source: plugin.id,
      now,
      windowSec: settings.windowSec,
      minGapSec: settings.minGapSec,
      limit: settings.limit,
    });
    if (targets.length === 0) continue;

    const started = Date.now();
    const ctx = createContext(plugin.id, (r) => onIntervention(r, now), () => now);
    try {
      const updates = await plugin.refresh(
        ctx,
        targets.map((t) => ({ externalId: t.external_id, url: t.url })),
      );
      let applied = 0;
      for (const update of updates) {
        const id = repo.contentIdOf(plugin.id, update.externalId);
        if (repo.getContent(id) === undefined) continue;
        repo.insertMetricSnapshot(id, now, update.metrics);
        applied++;
      }
      log.info('refreshed', { source: plugin.id, tier, requested: targets.length, applied, ms: Date.now() - started });
      results.push({
        source: plugin.id,
        ok: true,
        items: applied,
        newItems: 0,
        error: null,
        durationMs: Date.now() - started,
      });
    } catch (e) {
      const kind: ErrorKind = isRadarError(e) ? e.kind : 'INTERNAL';
      log.warn('refresh failed', { source: plugin.id, tier, kind, error: (e as Error).message });
      repo.appendEvent('source.error', plugin.id, null, { phase: 'refresh', kind });
      results.push({
        source: plugin.id,
        ok: false,
        items: 0,
        newItems: 0,
        error: (e as Error).message,
        durationMs: Date.now() - started,
      });
    }
  }
  return results;
}

/**
 * Re-runs enrichment over everything already stored.
 *
 * Language detection, keyword extraction and near-duplicate hashing all improve
 * over time, and stored rows would otherwise keep whatever the detector said on
 * the day they arrived. A country the *source* stated is never touched - only a
 * value this system inferred is allowed to change.
 */
export function reclassifyAll(): { examined: number; languageChanged: number } {
  const rows = repo.allContent();
  let languageChanged = 0;

  for (const row of rows) {
    const enriched = enrich({
      sourceId: row.source,
      externalId: row.external_id,
      url: row.url,
      title: row.title,
      body: row.body,
      contentType: 'unknown',
      publishedAt: row.published_at,
      metrics: EMPTY_METRICS,
    });

    const sourceStatedCountry = row.country_source !== null && row.country_source !== 'language';
    if (row.lang !== enriched.lang) languageChanged++;

    repo.updateEnrichment({
      id: row.id,
      lang: enriched.lang,
      langConfidence: enriched.langConfidence,
      country: sourceStatedCountry ? row.country : enriched.country,
      countryConfidence: sourceStatedCountry ? row.country_confidence : enriched.countryConfidence,
      countrySource: sourceStatedCountry ? row.country_source : enriched.countrySource,
      keywords: enriched.keywords,
      hashtags: enriched.hashtags,
      simhash: enriched.simhash,
    });
  }

  log.info('reclassified', { examined: rows.length, languageChanged });
  return { examined: rows.length, languageChanged };
}

/** Runs one source by id, ignoring whether it is in SOURCES_ENABLED. */
export async function collectOne(sourceId: string, now = nowSec()): Promise<SourceRunResult> {
  const plugin = pluginById(sourceId);
  if (plugin === undefined) {
    return { source: sourceId, ok: false, items: 0, newItems: 0, error: 'unknown source', durationMs: 0 };
  }
  const validation = statusOf(plugin);
  if (!validation.ok && validation.status !== 'DEGRADED') {
    return { source: sourceId, ok: false, items: 0, newItems: 0, error: validation.message, durationMs: 0 };
  }
  return runDiscovery(plugin, now);
}
