/**
 * Creator baselines built from backfilled history.
 *
 * "This got forty times what this account usually gets" is the most useful
 * verdict the system produces, and it was unavailable for 90% of creators
 * because open discovery finds one video from a channel and never returns.
 *
 * What these tests protect is the selection and the plumbing: that effort goes
 * to the creators where a breakout would matter, that a channel is not asked
 * about twice in a week, and — most importantly — that backfilled posts reach
 * the baseline without ever reaching the trend feed.
 */
import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DB_FILE = join(tmpdir(), `radar-backfill-${process.pid}.db`);
process.env['RADAR_NO_ENV_FILE'] = '1';
process.env['DB_PATH'] = DB_FILE;
process.env['LOG_LEVEL'] = 'error';

const { db, closeDb } = await import('../src/db/db.ts');
const repo = await import('../src/db/repo.ts');

const NOW = 1_750_000_000;
const WEEK = 7 * 24 * 3600;

/** One creator with `items` measured posts, whose best item scored `best`. */
function seedCreator(authorId: string, items: number, best: number): void {
  for (let i = 0; i < items; i++) {
    const id = `youtube:${authorId}:${i}`;
    db().exec(
      `INSERT INTO content (id, source, external_id, url, title, content_type, author_id,
                            first_seen_at, last_seen_at)
       VALUES ('${id}', 'youtube', '${authorId}_${i}', 'https://e.com/${i}', 'v${i}',
               'video', '${authorId}', ${NOW - 3600}, ${NOW})`,
    );
    db().exec(
      `INSERT INTO content_metrics (content_id, ts, views) VALUES ('${id}', ${NOW}, ${1000 + i})`,
    );
    db().exec(
      `INSERT INTO content_scores (content_id, source, score, confidence, state, primary_metric,
                                   observations, scoring_version, updated_at)
       VALUES ('${id}', 'youtube', ${i === 0 ? best : 1}, 0.8, 'RISING', 'views', 3, 1, ${NOW})`,
    );
  }
}

before(() => {
  db();
  seedCreator('UC_strong', 1, 70); // one item, but it did well
  seedCreator('UC_weak', 1, 4); // one item, and it did not
  seedCreator('UC_covered', 9, 50); // already has plenty
});

after(() => {
  closeDb();
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(`${DB_FILE}${suffix}`);
    } catch {
      // A missing side-file is not a failure worth reporting from a teardown.
    }
  }
});

describe('choosing who to backfill', () => {
  test('a creator with enough samples already is left alone', () => {
    const wanted = repo.creatorsNeedingHistory('youtube', 8, NOW, 50);
    assert.ok(!wanted.some((w) => w.externalId === 'UC_covered'));
  });

  test('the creator whose work actually did well comes first', () => {
    const wanted = repo.creatorsNeedingHistory('youtube', 8, NOW, 50);
    // Effort is finite; knowing the normal for a channel that reached 70 is
    // worth more than for one that reached 4.
    assert.equal(wanted[0]?.externalId, 'UC_strong');
    assert.ok(wanted.some((w) => w.externalId === 'UC_weak'));
  });

  test('the budget is respected', () => {
    assert.equal(repo.creatorsNeedingHistory('youtube', 8, NOW, 1).length, 1);
  });

  test('a creator looked at recently is skipped until they go stale', () => {
    repo.markHistoryFetched(['youtube:UC_weak'], NOW);

    const fresh = repo.creatorsNeedingHistory('youtube', 8, NOW - WEEK, 50);
    assert.ok(!fresh.some((w) => w.externalId === 'UC_weak'), 'should be resting');

    // A week later they are fair game again.
    const later = repo.creatorsNeedingHistory('youtube', 8, NOW + WEEK, 50);
    assert.ok(later.some((w) => w.externalId === 'UC_weak'));
  });
});

describe('promoting creators to the watch list', () => {
  test('a creator with a good average is promoted', () => {
    // UC_covered has nine items averaging well above the bar.
    const proven = repo.provenCreators('youtube', 2, 5, 50);
    assert.ok(proven.includes('UC_covered'));
  });

  test('one lucky video does not promote a channel', () => {
    // UC_strong scored 70 once, on its only item. That is not a track record,
    // and following it every cycle on that basis would be the whole point of
    // the minimum missed.
    const proven = repo.provenCreators('youtube', 2, 5, 50);
    assert.ok(!proven.includes('UC_strong'), 'a single item should not qualify');
  });

  test('the bar is the average, so a quiet channel stays out', () => {
    // UC_weak's only item scored 4.
    assert.ok(!repo.provenCreators('youtube', 1, 30, 50).includes('UC_weak'));
    // Drop the bar far enough and it qualifies, which proves the bar is what
    // excluded it rather than something incidental.
    assert.ok(repo.provenCreators('youtube', 1, 0, 50).includes('UC_weak'));
  });

  test('best first, and capped', () => {
    const proven = repo.provenCreators('youtube', 1, 0, 1);
    assert.equal(proven.length, 1);
    // UC_strong's single item scored 70, the highest average in the fixture.
    assert.equal(proven[0], 'UC_strong');
  });

  test('a source with no creators returns nothing rather than failing', () => {
    assert.deepEqual(repo.provenCreators('reddit', 2, 30, 50), []);
  });
});

describe('history as baseline', () => {
  before(() => {
    repo.saveCreatorHistory(
      Array.from({ length: 6 }, (_, i) => ({
        creatorId: 'youtube:UC_strong',
        externalId: `past_${i}`,
        metric: 'views',
        value: 500 + i * 10,
        publishedAt: NOW - (i + 1) * 86400,
      })),
      NOW,
    );
  });

  test('backfilled posts join the creator’s samples', () => {
    const samples = repo.creatorSamples('youtube', 'UC_strong', 'views');
    // One tracked item plus six reference posts.
    assert.equal(samples.length, 7);
    assert.ok(samples.includes(500), 'a backfilled value is missing');
    assert.ok(samples.includes(1000), 'the tracked value is missing');
  });

  test('history counts towards the target, and stops the asking once it is met', () => {
    // One tracked item plus six backfilled is seven: still short of eight, so
    // still worth asking about.
    const short = repo.creatorsNeedingHistory('youtube', 8, NOW + WEEK * 2, 50);
    assert.ok(short.some((w) => w.externalId === 'UC_strong'), 'seven of eight is not done');

    repo.saveCreatorHistory(
      [6, 7].map((i) => ({
        creatorId: 'youtube:UC_strong',
        externalId: `past_${i}`,
        metric: 'views',
        value: 560 + i,
        publishedAt: NOW - (i + 1) * 86400,
      })),
      NOW,
    );

    // Nine now, so the creator drops out of the queue entirely.
    const done = repo.creatorsNeedingHistory('youtube', 8, NOW + WEEK * 2, 50);
    assert.ok(!done.some((w) => w.externalId === 'UC_strong'), 'nine samples is enough');
  });

  test('backfilled posts never become content', () => {
    // The whole reason they live in their own table: a backfill reaches back
    // through a channel's old uploads, and those are not trending.
    const rows = db()
      .prepare("SELECT COUNT(*) AS n FROM content WHERE external_id LIKE 'past_%'")
      .get() as { n: number };
    assert.equal(rows.n, 0);
  });

  test('re-fetching the same post updates it rather than duplicating it', () => {
    const before = repo.creatorSamples('youtube', 'UC_strong', 'views').length;
    repo.saveCreatorHistory(
      [
        {
          creatorId: 'youtube:UC_strong',
          externalId: 'past_0',
          metric: 'views',
          value: 999,
          publishedAt: NOW - 86400,
        },
      ],
      NOW + 60,
    );
    const samples = repo.creatorSamples('youtube', 'UC_strong', 'views');
    assert.equal(samples.length, before, 'the count should not have grown');
    assert.ok(samples.includes(999));
    assert.ok(!samples.includes(500), 'the old value should have been replaced');
  });

  test('coverage counts creators, not rows', () => {
    const coverage = repo.creatorHistoryCoverage('youtube');
    assert.equal(coverage.withHistory, 1);
    assert.equal(coverage.total, 3);
  });
});
