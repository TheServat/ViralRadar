/**
 * End-to-end through the real database, the real analysis pass and the real
 * HTTP server. Only the *sources* are synthetic: this seeds the same rows a
 * plugin would have written, then checks that the rest of the system turns them
 * into a ranked, filterable, cross-platform answer.
 */
import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

const DB_FILE = join(tmpdir(), `radar-test-${process.pid}.db`);
// Hermetic on purpose: the suite ignores the developer's .env, so a personal
// setting like LANGUAGES=fa cannot decide whether these tests pass.
process.env['RADAR_NO_ENV_FILE'] = '1';
process.env['DB_PATH'] = DB_FILE;
process.env['LOG_LEVEL'] = 'error';

const { db, closeDb } = await import('../src/db/db.ts');
const repo = await import('../src/db/repo.ts');
const { analyze } = await import('../src/pipeline/analyze.ts');
const { enrich } = await import('../src/pipeline/collect.ts');
const { createApiServer } = await import('../src/api/server.ts');
const { metricsOf } = await import('../src/sources/types.ts');
import type { Metrics, RawContent } from '../src/core/types.ts';

const NOW = Math.floor(Date.now() / 1000);

/** Writes one item the way the collector would, at a given moment. */
function seed(item: RawContent, at: number, metrics: Metrics): string {
  const id = repo.contentIdOf(item.sourceId, item.externalId);
  const e = enrich(item);
  repo.upsertContent({
    id,
    source: item.sourceId,
    externalId: item.externalId,
    url: item.url,
    canonicalUrl: null,
    title: item.title,
    body: item.body ?? null,
    contentType: item.contentType,
    authorId: item.authorId ?? null,
    authorName: item.authorName ?? null,
    thumbnailUrl: null,
    lang: e.lang,
    langConfidence: e.langConfidence,
    country: e.country,
    countryConfidence: e.countryConfidence,
    countrySource: e.countrySource,
    publishedAt: item.publishedAt,
    publishedAtSource: 'api',
    seenAt: at,
    region: null,
    keywords: e.keywords,
    hashtags: e.hashtags,
    simhash: e.simhash,
    raw: null,
  });
  if (item.authorId !== null && item.authorId !== undefined) {
    repo.upsertCreator({
      source: item.sourceId,
      externalId: item.authorId,
      name: item.authorName ?? null,
      url: null,
      followers: item.authorFollowers ?? null,
      now: at,
    });
  }
  repo.insertMetricSnapshot(id, at, metrics);
  return id;
}

function video(n: number, title: string, author: string): RawContent {
  return {
    sourceId: 'youtube',
    externalId: `vid${n}`,
    url: `https://www.youtube.com/watch?v=vid${n}`,
    title,
    body: null,
    contentType: 'video',
    authorId: author,
    authorName: author,
    publishedAt: NOW - 5 * 3600,
    metrics: metricsOf({}),
  };
}

before(() => {
  db();

  // A small channel with a boring history, so a breakout has something to be
  // measured against.
  for (let i = 0; i < 8; i++) {
    const id = seed(video(100 + i, `Everyday clip number ${i} about model trains`, 'smallchannel'), NOW - 6 * 3600, metricsOf({ views: 3_000 + i * 50, likes: 90, comments: 12 }));
    repo.insertMetricSnapshot(id, NOW - 3 * 3600, metricsOf({ views: 3_100 + i * 50, likes: 92, comments: 12 }));
  }

  // The breakout itself: 2K -> 8K -> 35K -> 180K -> 900K over four hours.
  const breakoutId = seed(video(1, 'Cat interrupts live weather forecast on national television', 'smallchannel'), NOW - 4 * 3600, metricsOf({ views: 2_000, likes: 80, comments: 10 }));
  for (const [hoursAgo, views] of [[3, 8_000], [2, 35_000], [1, 180_000], [0, 900_000]] as const) {
    repo.insertMetricSnapshot(breakoutId, NOW - hoursAgo * 3600, metricsOf({ views, likes: Math.round(views * 0.05), comments: Math.round(views * 0.008) }));
  }

  // The same story on two other platforms, so it should cluster.
  const redditId = seed(
    {
      sourceId: 'reddit',
      externalId: 'r1',
      url: 'https://www.reddit.com/r/funny/comments/r1',
      title: 'A cat interrupted a live weather forecast on national television',
      body: null,
      contentType: 'video',
      authorId: 'someuser',
      authorName: 'someuser',
      publishedAt: NOW - 3 * 3600,
      metrics: metricsOf({}),
    },
    NOW - 3 * 3600,
    metricsOf({ nativeScore: 400, comments: 60 }),
  );
  repo.insertMetricSnapshot(redditId, NOW - 3600, metricsOf({ nativeScore: 9_800, comments: 900 }));
  repo.insertMetricSnapshot(redditId, NOW, metricsOf({ nativeScore: 42_000, comments: 3_100 }));

  seed(
    {
      sourceId: 'rss',
      externalId: 'n1',
      url: 'https://news.example.com/cat-weather',
      title: 'Cat interrupts live weather forecast, delighting national television viewers',
      body: null,
      contentType: 'link',
      authorId: 'news.example.com',
      authorName: 'Example News',
      publishedAt: NOW - 2 * 3600,
      metrics: metricsOf({}),
    },
    NOW - 2 * 3600,
    metricsOf({}),
  );

  // Something entirely unrelated, which must not join anything.
  const other = seed(video(2, 'Quarterly report on regional freight rail investment', 'bigchannel'), NOW - 5 * 3600, metricsOf({ views: 9_000, likes: 100, comments: 20 }));
  repo.insertMetricSnapshot(other, NOW, metricsOf({ views: 9_200, likes: 101, comments: 20 }));

  analyze(NOW);
});

after(() => {
  closeDb();
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(`${DB_FILE}${suffix}`);
    } catch {
      // The file may not exist; nothing to clean up.
    }
  }
});

describe('analysis over stored data', () => {
  test('the accelerating video is scored and is not merely "NEW"', () => {
    const id = repo.contentIdOf('youtube', 'vid1');
    const score = repo.getScore(id);
    assert.ok(score !== undefined, 'the breakout video should have a score');
    assert.ok(score.score > 60, `score was ${score.score}`);
    assert.ok((score.velocity ?? 0) > 0);
    assert.ok(['VIRAL', 'HOT', 'EMERGING', 'RISING'].includes(score.state), `state was ${score.state}`);
  });

  test('the creator breakout is detected against the channel own history', () => {
    const breakouts = repo.listBreakouts(10, NOW - 86_400);
    assert.ok(breakouts.length >= 1, 'expected at least one creator breakout');
    assert.equal(breakouts[0]?.external_id, 'vid1');
  });

  test('the boring clip from the same channel is not a breakout', () => {
    const breakouts = repo.listBreakouts(10, NOW - 86_400).map((b) => b.external_id);
    assert.ok(!breakouts.includes('vid100'));
  });

  test('the same story on three platforms forms one cross-source cluster', () => {
    const clusters = repo.listClusters({ limit: 20, minSources: 2 });
    assert.ok(clusters.length >= 1, 'expected a cross-source cluster');
    const top = clusters[0];
    assert.ok(top !== undefined);
    assert.ok(top.source_count >= 3, `only ${top.source_count} sources`);
    const members = repo.clusterMembers(top.id).map((m) => m.external_id);
    assert.ok(members.includes('vid1') && members.includes('r1') && members.includes('n1'));
    assert.ok(!members.includes('vid2'), 'the freight rail story must not be in there');
  });

  test('a source with no view counter still contributes, at a lower score', () => {
    const rss = repo.getScore(repo.contentIdOf('rss', 'n1'));
    const youtube = repo.getScore(repo.contentIdOf('youtube', 'vid1'));
    assert.ok(rss !== undefined && youtube !== undefined);
    assert.ok(rss.score < youtube.score, 'a metric-less headline must not outrank a real view counter');
  });

  test('baselines were rebuilt per source', () => {
    const values = repo.getBaseline('youtube', 'value', 'all');
    assert.ok(values !== null && values.sampleCount > 0);
  });

  test('language was detected and stored with a confidence', () => {
    const row = repo.getContent(repo.contentIdOf('youtube', 'vid1'));
    assert.equal(row?.lang, 'en');
    assert.ok((row?.lang_confidence ?? 0) > 0);
  });

  test('country stays NULL when nothing actually said so', () => {
    const row = repo.getContent(repo.contentIdOf('reddit', 'r1'));
    assert.equal(row?.country, null);
  });
});

describe('http api', () => {
  let baseUrl = '';
  let server: ReturnType<typeof createApiServer>;

  before(async () => {
    server = createApiServer(null);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    server.close();
  });

  async function get<T>(path: string): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`);
    assert.equal(res.status, 200, `${path} returned ${res.status}`);
    return (await res.json()) as T;
  }

  test('the dashboard answers with no parameters at all', async () => {
    const body = await get<{ viral: unknown[]; rising: unknown[]; crossPlatform: unknown[]; stats: { content: number } }>(
      '/api/v1/dashboard',
    );
    assert.ok(Array.isArray(body.viral));
    assert.ok(Array.isArray(body.crossPlatform));
    assert.ok(body.stats.content > 0);
  });

  test('trends are ranked and paginated', async () => {
    const body = await get<{ items: { score: number; id: string }[]; nextOffset: number | null }>(
      '/api/v1/trends?limit=5',
    );
    assert.ok(body.items.length > 0 && body.items.length <= 5);
    for (let i = 1; i < body.items.length; i++) {
      assert.ok((body.items[i - 1] as { score: number }).score >= (body.items[i] as { score: number }).score);
    }
  });

  test('filters narrow results without being required', async () => {
    const all = await get<{ items: unknown[] }>('/api/v1/trends?limit=100');
    const youtubeOnly = await get<{ items: { source: string }[] }>('/api/v1/trends?limit=100&source=youtube');
    assert.ok(youtubeOnly.items.length > 0);
    assert.ok(youtubeOnly.items.every((i) => i.source === 'youtube'));
    assert.ok(youtubeOnly.items.length < all.items.length);
  });

  test('an unknown filter value returns an empty list, not an error', async () => {
    const body = await get<{ items: unknown[] }>('/api/v1/trends?source=nosuchsource');
    assert.deepEqual(body.items, []);
  });

  test('content detail exposes the series the score was computed from', async () => {
    const id = repo.contentIdOf('youtube', 'vid1');
    const body = await get<{ history: { views: number | null }[]; signals: { observations: number } | null }>(
      `/api/v1/content/${encodeURIComponent(id)}`,
    );
    assert.ok(body.history.length >= 5);
    assert.ok((body.signals?.observations ?? 0) >= 5);
  });

  test('a missing item is a 404, not a 500', async () => {
    const res = await fetch(`${baseUrl}/api/v1/content/does-not-exist`);
    assert.equal(res.status, 404);
  });

  test('sources report capabilities and configuration state', async () => {
    const body = await get<{ items: { id: string; capabilities: unknown; configured: boolean }[] }>('/api/v1/sources');
    const ids = body.items.map((i) => i.id);
    for (const expected of ['youtube', 'reddit', 'googletrends', 'hackernews', 'rss', 'telegram', 'tiktok']) {
      assert.ok(ids.includes(expected), `${expected} missing from /sources`);
    }
    assert.equal(body.items.find((i) => i.id === 'tiktok')?.configured, false);
  });

  test('health reports jobs, sources and database counts', async () => {
    const body = await get<{ status: string; db: { content: number }; scoringVersion: number }>('/api/v1/system/health');
    assert.equal(body.status, 'ok');
    assert.ok(body.db.content > 0);
    assert.equal(body.scoringVersion, 1);
  });

  test('security headers are present on every response', async () => {
    const res = await fetch(`${baseUrl}/api/v1/system/health`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.ok((res.headers.get('content-security-policy') ?? '').includes("default-src 'self'"));
    assert.equal(res.headers.get('access-control-allow-origin'), null, 'CORS must not be open');
  });

  test('a path traversal attempt cannot escape the web root', async () => {
    const res = await fetch(`${baseUrl}/../../package.json`);
    assert.notEqual(res.status, 200);
  });

  test('the dashboard page itself is served', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.ok((res.headers.get('content-type') ?? '').startsWith('text/html'));
  });
});
