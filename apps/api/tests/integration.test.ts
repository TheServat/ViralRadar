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
import type { RefreshTarget } from '../src/db/repo.ts';

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
    discoveryTerm: null,
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

describe('what the query planner is given to work with', () => {
  // Not a performance test — it asserts the two facts a performance problem
  // was traced to, both of which are invisible until something is slow.
  //
  // With no statistics SQLite plans from index shape alone, and for the
  // creator history query it chose the index that satisfied the ORDER BY and
  // then tested author_id on every row of the source. On the live database
  // that was 18.5 ms per creator against 0.05 ms, about fifteen hundred times
  // per pass, inside a write transaction on the thread serving HTTP.

  test('a new database is analysed rather than left to guesses', () => {
    const stats = db().prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_stat1'").get();
    assert.notEqual(stats, undefined, 'ANALYZE must have run by the time the database is usable');
  });

  // The weaker of the two: on a small test database SQLite reaches the right
  // plan without statistics, so this cannot reproduce the live failure. It
  // pins the intent, and would catch the index being dropped.
  test('the creator history query seeks the creator, not the whole source', () => {
    const plan = db()
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT (SELECT m.views FROM content_metrics m
                 WHERE m.content_id = c.id AND m.views IS NOT NULL
                 ORDER BY m.ts DESC LIMIT 1) AS v
         FROM content c WHERE c.source = ? AND c.author_id = ?
         ORDER BY c.first_seen_at DESC LIMIT 200`,
      )
      .all('youtube', 'someone') as { detail: string }[];
    const details = plan.map((r) => r.detail);
    const scan = details.find((d) => /SEARCH c /.test(d)) ?? JSON.stringify(details);
    assert.match(
      scan,
      /author_id=\?/,
      `the plan must narrow by author_id, not filter it out afterwards: ${scan}`,
    );
  });
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

  // ── Cross-site writes ───────────────────────────────────────────────────
  //
  // Binding to 127.0.0.1 keeps other machines out. It does not keep other tabs
  // out: any page the user visits can post to this server, and both guards are
  // open by default. `readJsonBody` ignores Content-Type, so text/plain avoids
  // a preflight and the request arrives with no consent anywhere in it.

  test('a write from another site is refused', async () => {
    const res = await fetch(`${baseUrl}/api/v1/system/collect`, {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.test' },
    });
    assert.equal(res.status, 403);
  });

  test('a write with only a foreign Origin is refused', async () => {
    // The fallback path, for anything that sends no Sec-Fetch-Site.
    const res = await fetch(`${baseUrl}/api/v1/system/collect`, {
      method: 'POST',
      headers: { origin: 'https://evil.test' },
    });
    assert.equal(res.status, 403);
  });

  test('the dashboard own writes still work', async () => {
    const res = await fetch(`${baseUrl}/api/v1/system/collect`, {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    assert.notEqual(res.status, 403);
  });

  test('a request with no browser headers is not a browser, and passes', async () => {
    // curl, the MCP server, a script. These were never the risk, and refusing
    // them would break every non-browser caller for nothing.
    const res = await fetch(`${baseUrl}/api/v1/system/collect`, { method: 'POST' });
    assert.notEqual(res.status, 403);
  });

  test('reads are left alone, so the stream and the export link keep working', async () => {
    const res = await fetch(`${baseUrl}/api/v1/facets`, {
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(res.status, 200);
  });

  test('the dashboard page itself is served', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.ok((res.headers.get('content-type') ?? '').startsWith('text/html'));
  });

  // ── Matching what the user makes ────────────────────────────────────────

  test('with no channel description, the matched list is off rather than everything', async () => {
    // The suite runs with no .env, so nothing has been described. The failure
    // this guards against is the filter silently becoming a no-op, which would
    // present the whole database as "things close to what you make".
    const body = await get<{ forYouEnabled: boolean; forYou: unknown[]; forYouFloor: number }>(
      '/api/v1/dashboard',
    );
    assert.equal(body.forYouEnabled, false);
    assert.deepEqual(body.forYou, []);
    assert.ok(body.forYouFloor > 0, 'the bar should still be reported so the page can name it');
  });

  test('a closeness filter drops what is below the bar', async () => {
    const close = repo.contentIdOf('youtube', 'vid1');
    const far = repo.contentIdOf('youtube', 'vid2');
    repo.saveRelevance(new Map([[close, 0.8], [far, 0.1]]));

    const filtered = await get<{ items: { id: string }[] }>(
      '/api/v1/trends?limit=200&minRelevance=0.5',
    );
    const ids = filtered.items.map((i) => i.id);
    assert.ok(ids.includes(close), 'a close item must survive the filter');
    assert.ok(!ids.includes(far), 'an item well below the bar must not');
  });

  test('an item nothing has measured yet is kept, not silently dropped', async () => {
    // Deliberate: unscored means the embedding job has not reached it. Hiding
    // new items behind a filter they were never measured against would lose
    // exactly the ones worth seeing first.
    const body = await get<{ items: { id: string; relevance: number | null }[] }>(
      '/api/v1/trends?limit=200&minRelevance=0.5',
    );
    const unmeasured = body.items.filter((i) => i.relevance === null);
    assert.ok(
      unmeasured.length > 0,
      'items with no relevance score should pass a relevance filter, not be dropped',
    );
  });
});

describe('the refresh queue', () => {
  /**
   * The queue decides which items get measured again, and measurement is the
   * only thing that produces growth. Ordering it by score was a real defect:
   * it re-measured known winners dozens of times while a quarter of recent
   * content never got a second look, so the small early items the product
   * exists to catch could never leave `NEW`.
   */
  const QUEUE_SOURCE = 'hackernews';

  before(() => {
    const base = NOW - 3600;
    // Three shapes of item: never measured twice, measured twice, and a
    // well-tracked one already carrying plenty of history.
    for (let i = 0; i < 30; i++) {
      const id = seed(
        {
          sourceId: QUEUE_SOURCE,
          externalId: `queue-fresh-${i}`,
          url: `https://news.ycombinator.com/item?id=q${i}`,
          title: `Fresh queue item ${i}`,
          body: null,
          contentType: 'link',
          authorId: 'someone',
          authorName: 'someone',
          publishedAt: base,
          metrics: metricsOf({}),
        },
        base,
        metricsOf({ nativeScore: 5 }),
      );
      // Deliberately left at one measurement.
      void id;
    }

    for (let i = 0; i < 10; i++) {
      const id = seed(
        {
          sourceId: QUEUE_SOURCE,
          externalId: `queue-pair-${i}`,
          url: `https://news.ycombinator.com/item?id=p${i}`,
          title: `Two-measurement item ${i}`,
          body: null,
          contentType: 'link',
          authorId: 'someone',
          authorName: 'someone',
          publishedAt: base,
          metrics: metricsOf({}),
        },
        base,
        metricsOf({ nativeScore: 10 }),
      );
      repo.insertMetricSnapshot(id, base + 600, metricsOf({ nativeScore: 20 }));
    }

    // A popular, heavily tracked item: high score, twelve measurements.
    const tracked = seed(
      {
        sourceId: QUEUE_SOURCE,
        externalId: 'queue-tracked',
        url: 'https://news.ycombinator.com/item?id=tracked',
        title: 'Already well tracked and very popular',
        body: null,
        contentType: 'link',
        authorId: 'someone',
        authorName: 'someone',
        publishedAt: base,
        metrics: metricsOf({}),
      },
      base,
      metricsOf({ nativeScore: 100 }),
    );
    for (let i = 1; i <= 12; i++) {
      repo.insertMetricSnapshot(tracked, base + i * 120, metricsOf({ nativeScore: 100 + i * 50 }));
    }

    analyze(NOW);
  });

  function queue(limit: number): RefreshTarget[] {
    return repo.refreshTargets({
      source: QUEUE_SOURCE,
      now: NOW + 3600,
      windowSec: 12 * 3600,
      minGapSec: 60,
      limit,
    });
  }

  test('items that have never been measured twice come first', () => {
    const picked = queue(20);
    const bootstrap = picked.filter((p) => p.measurements < 2).length;
    assert.ok(
      bootstrap >= 10,
      `expected the backlog to dominate a 20-item budget, got ${bootstrap}`,
    );
  });

  test('a popular item with twelve measurements does not crowd out the backlog', () => {
    const picked = queue(20);
    const tracked = picked.find((p) => p.external_id === 'queue-tracked');
    // It may be selected — tracking still matters — but never at the cost of
    // the whole budget, which is what score-only ordering used to do.
    const bootstrap = picked.filter((p) => p.measurements < 2).length;
    assert.ok(bootstrap > (tracked === undefined ? 0 : 1), 'the backlog must outrank one popular item');
  });

  test('every tier gets a share, so depth is not starved either', () => {
    const picked = queue(40);
    assert.ok(picked.some((p) => p.measurements < 2), 'no bootstrap picks');
    assert.ok(picked.some((p) => p.measurements >= 2), 'no depth picks');
  });

  test('unused quota spills forward rather than being wasted', () => {
    // Far more budget than there are under-measured items: the surplus must go
    // to deeper tiers instead of returning a short list.
    const picked = queue(200);
    const available = repo.refreshCoverage(QUEUE_SOURCE, NOW - 12 * 3600).total;
    assert.ok(picked.length > 40, `only ${picked.length} picked out of ${available} available`);
  });

  test('an item measured moments ago is not measured again', () => {
    const soon = repo.refreshTargets({
      source: QUEUE_SOURCE,
      now: NOW + 3600,
      windowSec: 12 * 3600,
      // Nothing has been idle for a day, so nothing is due.
      minGapSec: 86_400,
      limit: 50,
    });
    assert.equal(soon.length, 0);
  });

  test('coverage reports what the queue still has to do', () => {
    const coverage = repo.refreshCoverage(QUEUE_SOURCE, NOW - 12 * 3600);
    assert.ok(coverage.total >= 40);
    assert.ok(coverage.unmeasured >= 25, `expected the seeded backlog, got ${coverage.unmeasured}`);
    assert.ok(coverage.deep >= 1, 'the twelve-measurement item should count as deep');
  });
});
