/**
 * Matching items against what the user makes.
 *
 * The risk here is not that the matching is imprecise — it is a similarity, and
 * the interface says so. The risk is that a filter built on it hides things it
 * was never able to judge: an item collected five minutes ago has no vector
 * yet, and treating "not scored" as "not relevant" would quietly bury exactly
 * the new arrivals this whole system exists to surface.
 */
import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DB_FILE = join(tmpdir(), `radar-interest-${process.pid}.db`);
process.env['RADAR_NO_ENV_FILE'] = '1';
process.env['DB_PATH'] = DB_FILE;
process.env['LOG_LEVEL'] = 'error';

const { db, closeDb } = await import('../src/db/db.ts');
const repo = await import('../src/db/repo.ts');
const { normalise, similarity, toBlob, fromBlob } = await import('../src/ai/embed.ts');

const NOW = 1_750_000_000;

function seed(id: string, title: string, score: number): void {
  db().exec(
    `INSERT INTO content (id, source, external_id, url, title, content_type, first_seen_at, last_seen_at)
     VALUES ('${id}', 'youtube', '${id}', 'https://e.com/${id}', '${title}', 'video', ${NOW}, ${NOW})`,
  );
  db().exec(
    `INSERT INTO content_scores (content_id, source, score, confidence, state, primary_metric,
                                 observations, scoring_version, updated_at)
     VALUES ('${id}', 'youtube', ${score}, 0.8, 'RISING', 'views', 4, 1, ${NOW})`,
  );
}

before(() => {
  db();
  seed('a', 'close match', 50);
  seed('b', 'far match', 90);
  seed('c', 'never scored', 70);
});

after(() => {
  closeDb();
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(`${DB_FILE}${suffix}`);
    } catch {
      // A missing side-file is not worth failing a teardown over.
    }
  }
});

describe('storing relevance', () => {
  before(() => {
    repo.saveRelevance(new Map([['a', 0.82], ['b', 0.11]]));
  });

  test('is written to the items that have it', () => {
    const rows = repo.rankedContent({ limit: 10, offset: 0 });
    const byId = new Map(rows.map((r) => [r.id, r.relevance]));
    assert.equal(byId.get('a'), 0.82);
    assert.equal(byId.get('b'), 0.11);
  });

  test('an unscored item is null, never zero', () => {
    // Zero would mean "measured, and irrelevant". Null means "not measured",
    // and the difference decides whether it can be filtered away.
    const rows = repo.rankedContent({ limit: 10, offset: 0 });
    assert.equal(rows.find((r) => r.id === 'c')?.relevance, null);
  });

  test('coverage counts what has been scored', () => {
    const c = repo.relevanceCoverage();
    assert.equal(c.scored, 2);
    assert.equal(c.total, 3);
  });
});

describe('filtering by relevance', () => {
  test('keeps close matches and drops far ones', () => {
    const rows = repo.rankedContent({ limit: 10, offset: 0, minRelevance: 0.5 });
    const ids = rows.map((r) => r.id);
    assert.ok(ids.includes('a'), 'a close match should survive');
    assert.ok(!ids.includes('b'), 'a far match should be filtered out');
  });

  test('never hides an item it could not judge', () => {
    // The important one. 'c' has no score because nothing has embedded it yet;
    // filtering it away would bury new arrivals behind a test they never took.
    const rows = repo.rankedContent({ limit: 10, offset: 0, minRelevance: 0.9 });
    assert.ok(rows.map((r) => r.id).includes('c'), 'an unscored item must not be filtered out');
  });

  test('a zero threshold filters nothing', () => {
    assert.equal(repo.rankedContent({ limit: 10, offset: 0, minRelevance: 0 }).length, 3);
  });
});

describe('ordering by relevance', () => {
  test('puts the closest match first, whatever its score', () => {
    // 'b' scores 90 against 'a' at 50, so score ordering would invert this.
    const rows = repo.rankedContent({ limit: 10, offset: 0, orderBy: 'relevance' });
    assert.equal(rows[0]?.id, 'a');
  });

  test('unscored items sort last rather than first', () => {
    // NULLS LAST, because "unknown" is not "best".
    const rows = repo.rankedContent({ limit: 10, offset: 0, orderBy: 'relevance' });
    assert.equal(rows[rows.length - 1]?.id, 'c');
  });

  test('clearing removes every score', () => {
    repo.clearRelevance();
    assert.equal(repo.relevanceCoverage().scored, 0);
    // And the filter then hides nothing, rather than hiding everything.
    assert.equal(repo.rankedContent({ limit: 10, offset: 0, minRelevance: 0.9 }).length, 3);
  });
});

describe('the similarity itself', () => {
  test('a vector is closest to itself', () => {
    const v = normalise([1, 2, 3, 4]);
    assert.ok(Math.abs(similarity(v, v) - 1) < 1e-6);
  });

  test('survives the round trip used to cache the interest vector', () => {
    const original = normalise([0.3, -0.7, 0.2, 0.9]);
    const restored = fromBlob(toBlob(original));
    assert.ok(Math.abs(similarity(original, restored) - 1) < 1e-6);
  });
});
