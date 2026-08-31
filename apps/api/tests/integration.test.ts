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
const { reloadConfig } = await import('../src/config.ts');
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

  test('the scoring window is read through an index, not by scanning', () => {
    // Every ten minutes, over rows carrying body and raw. Without the index
    // it was a full scan plus a temporary B-tree to sort — 270 ms for a
    // truncated 4,000 rows, against 103 ms for all 9,022 with it.
    const plan = db()
      .prepare(
        'EXPLAIN QUERY PLAN SELECT * FROM content WHERE last_seen_at >= ? ORDER BY last_seen_at DESC LIMIT ?',
      )
      .all(0, 10) as { detail: string }[];
    const details = plan.map((r) => r.detail).join(' | ');
    assert.ok(!/SCAN content/.test(details), `must not scan the table: ${details}`);
    assert.ok(!/TEMP B-TREE/.test(details), `must not sort in memory: ${details}`);
  });

  test('the scoring ceiling is a ceiling, not a sampling rate', () => {
    // It was 4,000 against 9,022 eligible items, and the ones it dropped kept
    // the score AND the age they last had — which the dashboard then filters
    // on, so items passed a "last 24 hours" filter while being older.
    assert.ok(
      repo.SCORE_LIMIT >= 50_000,
      'the ceiling must sit above anything a retention window can hold',
    );
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

describe('search', () => {
  /*
   * Search was `LOWER(title) LIKE '%term%'`, which cannot use an index and so
   * scanned the whole table - twice per request, since the count and the page
   * share a WHERE clause. On a 17,000-row database that was 278 ms for a
   * search matching nothing and 852 ms to type "elections" one key at a time,
   * with the API, the live stream and the scheduler stopped for all of it.
   *
   * The replacement has to give the same answers, which is why it uses the
   * trigram tokenizer rather than the default one. A word tokenizer is faster
   * and smaller and silently breaks Arabic and Persian, where the article and
   * most prepositions attach to the following word.
   */

  test('a search is answered from the index, not by reading every row', () => {
    const plan = db()
      .prepare(
        `EXPLAIN QUERY PLAN SELECT c.id FROM content c
         WHERE c.rowid IN (SELECT rowid FROM content_fts WHERE content_fts MATCH ?)`,
      )
      .all('"glacier"') as { detail: string }[];
    const details = plan.map((r) => r.detail).join(' | ');
    assert.ok(!/SCAN c/.test(details), `the search still scans content: ${details}`);
  });

  test('a word inside a longer word is still found', () => {
    // The reason for trigram. `الانتخابات` is one token to a word tokenizer,
    // so searching `انتخابات` would stop finding it - which on the real
    // database lost three of twenty-nine Arabic matches. Derived from a real
    // seeded title rather than a literal, so this cannot pass by accident.
    const row = db().prepare('SELECT title FROM content WHERE title IS NOT NULL LIMIT 1').get() as
      | { title: string }
      | undefined;
    assert.ok(row);
    const word = row.title.split(/\s+/).find((w) => w.length >= 6);
    assert.ok(word, 'the fixture needs a word long enough to cut into');
    const middle = word.slice(2, 6).toLowerCase();

    const rows = db()
      .prepare('SELECT rowid FROM content_fts WHERE content_fts MATCH ?')
      .all(`"${middle}"`) as { rowid: number }[];
    assert.ok(rows.length > 0, `"${middle}" is inside "${word}" and must be found`);
  });

  test('what someone types is text, not query syntax', () => {
    // FTS5 throws on a syntax error rather than returning nothing, so an
    // unbalanced quote or a stray operator would turn a search into a 500.
    for (const typed of ['a"b', 'NEAR(', 'x OR y', '-thing', '"']) {
      assert.doesNotThrow(() => {
        db()
          .prepare('SELECT rowid FROM content_fts WHERE content_fts MATCH ?')
          .all(`"${typed.trim().toLowerCase().replace(/"/g, '""')}"`);
      }, `typing ${JSON.stringify(typed)} must not be a syntax error`);
    }
  });

  test('the index has a row for every row of content', () => {
    // External-content FTS5 keeps no copy of the text, so if the triggers ever
    // fall out of step, search answers from an index that no longer describes
    // the table. Counting is the direct check.
    const content = (db().prepare('SELECT COUNT(*) AS n FROM content').get() as { n: number }).n;
    const indexed = (db().prepare('SELECT COUNT(*) AS n FROM content_fts').get() as { n: number }).n;
    assert.equal(indexed, content, 'the index and the table have drifted apart');
  });

  test('a row inserted after the index existed is searchable', () => {
    // The insert trigger, which is the half a rebuild would hide.
    seed(
      video(99, 'Zarquon flavoured antimatter tutorial', 'somechannel'),
      NOW - 3600,
      metricsOf({ views: 10 }),
    );
    const found = db()
      .prepare('SELECT rowid FROM content_fts WHERE content_fts MATCH ?')
      .all('"arquon"') as unknown[];
    assert.equal(found.length, 1, 'a mid-word match on a newly inserted row');
  });
});

describe('retention', () => {
  /*
   * Two things had to be true for the documented "low hundreds of megabytes"
   * to hold, and neither was.
   *
   * `keyword_stats` shared the year-long history setting while storing a row
   * per hashtag per hour bucket — 123,000 rows a day on a real database,
   * roughly 3 GB at a year — for a reader that only ever looks at two buckets.
   *
   * And the sweep is a 24-hour timer that restarts from zero on every launch
   * and every settings save, on a product installed to start at login. A
   * laptop closed each evening never reached 24 hours, so retention never ran
   * at all: the live database was 222 MB with its oldest content four days old.
   */
  const DAY = 86_400;

  test('hashtag counts are swept on their own, much shorter, window', () => {
    // Anchored at NOW, not in the future: the seeded content in this database
    // is hours old, and a sweep run from a hundred days hence would delete it
    // out from under every other test in the file.
    repo.bumpKeyword('recent', NOW - 2 * DAY, { mentions: 5, creators: 2, sources: 1, metric: 10 });
    repo.bumpKeyword('ancient', NOW - 30 * DAY, { mentions: 5, creators: 2, sources: 1, metric: 10 });

    // 30-day content retention, a year of trend history, a fortnight of
    // hashtags: the middle one used to govern all three.
    repo.cleanup(NOW, 30, 365, 14);

    const left = db()
      .prepare('SELECT keyword FROM keyword_stats WHERE keyword IN (?, ?)')
      .all('recent', 'ancient') as { keyword: string }[];
    assert.deepEqual(
      left.map((r) => r.keyword),
      ['recent'],
      'the fortnight-old row must go and the two-day-old one must stay',
    );
  });

  test('the sweep says when it stopped early instead of quietly falling behind', () => {
    // Nothing to delete here, so the interesting half is that it reports the
    // ceiling honestly rather than looking like it finished.
    const result = repo.cleanup(NOW, 30, 365, 14);
    assert.equal(result.truncated, false);
  });

  test('deleting content can seek its breakouts rather than scanning them', () => {
    // `creator_breakouts` indexes content_id only as the second column of a
    // composite unique, which SQLite cannot seek — so the cascade scanned the
    // whole table once per deleted row, on the path that only runs when the
    // database has already grown.
    const plan = db()
      .prepare('EXPLAIN QUERY PLAN DELETE FROM creator_breakouts WHERE content_id = ?')
      .all('x') as { detail: string }[];
    const details = plan.map((r) => r.detail).join(' | ');
    assert.ok(!/SCAN creator_breakouts/.test(details), `the cascade still scans: ${details}`);
  });
});

describe('the API token, when there is one', () => {
  /*
   * Nothing covered this, and all three documented ways to present a token
   * shared one expression that could only ever read two of them.
   *
   * `?token=` mattered most and worked least. The chain used `??`, which falls
   * through on null but not on the empty string, and `.replace()` on a missing
   * Authorization header returns `''` — so the query parameter was unreachable
   * always, not merely when a header was present. It is the only transport
   * that works for `EventSource`, which cannot send headers, and for the
   * export link, which is an anchor the browser follows. Without it, setting
   * `API_TOKEN` left the dashboard unable to authenticate to the server that
   * was refusing it.
   */
  const TOKEN = 'test-token-value';
  let baseUrl = '';
  let server: ReturnType<typeof createApiServer>;
  let previous: string | undefined;

  before(async () => {
    previous = process.env['API_TOKEN'];
    process.env['API_TOKEN'] = TOKEN;
    assert.equal(reloadConfig().ok, true, 'the token has to reach the running configuration');
    server = createApiServer(null);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    server.close();
    if (previous === undefined) delete process.env['API_TOKEN'];
    else process.env['API_TOKEN'] = previous;
    reloadConfig();
  });

  test('no token is refused', async () => {
    const res = await fetch(`${baseUrl}/api/v1/dashboard`);
    assert.equal(res.status, 401);
  });

  test('the wrong token is refused', async () => {
    const res = await fetch(`${baseUrl}/api/v1/dashboard`, {
      headers: { 'x-radar-token': 'not-it' },
    });
    assert.equal(res.status, 401);
  });

  test('all three documented transports are accepted', async () => {
    const ways: [string, RequestInit | string][] = [
      ['X-Radar-Token', { headers: { 'x-radar-token': TOKEN } }],
      ['Authorization: Bearer', { headers: { authorization: `Bearer ${TOKEN}` } }],
      ['?token=', `?token=${TOKEN}`],
    ];
    for (const [name, way] of ways) {
      const res =
        typeof way === 'string'
          ? await fetch(`${baseUrl}/api/v1/dashboard${way}`)
          : await fetch(`${baseUrl}/api/v1/dashboard`, way);
      assert.equal(res.status, 200, `${name} was refused`);
    }
  });

  test('an Authorization header that is not Bearer is not read as a token', async () => {
    // It used to be: the prefix was stripped whether or not it was there, so
    // `Authorization: <token>` authenticated through a branch meant for Bearer.
    const res = await fetch(`${baseUrl}/api/v1/dashboard`, {
      headers: { authorization: TOKEN },
    });
    assert.equal(res.status, 401);
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

  test('the security headers are on the export too, not only on JSON', async () => {
    // The guard test for this probed one JSON route, and the export was the
    // one response in the file built without them. Nothing was reachable
    // through it - the body is the user's own data and the disposition is
    // `attachment` - but "every response carries" is a promise the security
    // doc makes, and an exception nobody meant is how it stops being true.
    const res = await fetch(`${baseUrl}/api/v1/export?format=csv&limit=1`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    const name = res.headers.get('content-disposition') ?? '';
    assert.match(name, /^attachment; filename="viral-radar-/);
  });

  test('a crafted export kind cannot choose the saved filename', async () => {
    const spoof = encodeURIComponent(`a" ; filename*=UTF-8''evil.html ; z="`);
    const res = await fetch(`${baseUrl}/api/v1/export?format=csv&limit=1&kind=${spoof}`);
    assert.equal(res.status, 200, 'it must answer, not throw inside writeHead');
    const disposition = res.headers.get('content-disposition') ?? '';
    assert.ok(!disposition.includes('evil.html'), disposition);
    assert.match(disposition, /\.csv"$/, 'the extension is the format, not the input');
  });

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
