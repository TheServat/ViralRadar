/**
 * Which tags to use.
 *
 * The statistics come from `lift.ts` and are tested there. What is specific to
 * this analysis is the failure it exists to survive: **a tag block is not a
 * sample.** One account posting fifty videos with the same nine tags produces
 * nine buckets of fifty items each, identical means, every one of them past any
 * sample-size test. On the first real database this ran against, that was
 * literally the top of the list — nine meditation tags from two accounts,
 * outranking every genuinely broad tag.
 *
 * Counting posts cannot see it. Counting distinct accounts can, and most of
 * what is below is about that.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env['RADAR_NO_ENV_FILE'] = '1';
process.env['LOG_LEVEL'] = 'error';

const { analyzeTags, MIN_CREATORS } = await import('../src/core/tags.ts');
const { MIN_TEXT_SEARCH } = await import('../src/db/repo.ts');
import type { TagSample } from '../src/core/tags.ts';

function post(
  tags: string[],
  percentile: number,
  creatorId: string | null = 'c1',
  views: number | null = 1000,
): TagSample {
  return { tags, creatorId, percentile, score: percentile * 100, views, carriesSeed: true };
}

/** n posts sharing a tag set, spread over `creators` distinct accounts. */
function many(n: number, tags: string[], percentile: number, creators: number): TagSample[] {
  return Array.from({ length: n }, (_, i) =>
    post(tags, percentile + (i % 2 === 0 ? 0.03 : -0.03), `creator-${i % creators}`),
  );
}

describe('finding the tags worth using', () => {
  test('a tag used by many accounts and doing better is a finding', () => {
    const result = analyzeTags('comedy', [
      ...many(40, ['funny'], 0.75, 20),
      ...many(40, ['boring'], 0.25, 20),
    ]);
    const funny = result.tags.find((t) => t.key === 'funny');
    assert.ok(funny !== undefined);
    assert.ok(funny.significant, 'a 50-point gap across 20 accounts should be a finding');
    assert.ok(funny.lift > 0);
    assert.equal(funny.creators, 20);
  });

  test('the same numbers from one account are not', () => {
    // Identical to the case above in every respect a sample-size test can see.
    const result = analyzeTags('comedy', [
      ...many(40, ['funny'], 0.75, 1),
      ...many(40, ['boring'], 0.25, 20),
    ]);
    const funny = result.tags.find((t) => t.key === 'funny');
    assert.ok(funny !== undefined);
    assert.equal(funny.creators, 1);
    assert.equal(funny.concentrated, true);
    assert.equal(funny.significant, false, 'one account is one sample, whatever the interval says');
    // Still reported: seeing why a spectacular number is not a finding is more
    // useful than never seeing the number.
    assert.ok(funny.lift > 0);
  });

  test('a whole tag block from one account is refused together', () => {
    // The shape that made this necessary: nine tags, one poster, every one of
    // them clearing the sample bar.
    const block = ['calm', 'meditation', 'peace', 'mindful', 'quiet', 'stillness', 'breathe', 'rest', 'slow'];
    const result = analyzeTags('comedy', [
      ...many(56, block, 0.85, 1),
      ...many(60, ['ordinary'], 0.35, 30),
    ]);
    for (const tag of block) {
      const row = result.tags.find((t) => t.key === tag);
      assert.ok(row !== undefined, `${tag} should still be listed`);
      assert.equal(row.significant, false, `${tag} was called a finding on one account`);
    }
    // `ordinary` is legitimately a finding here, and a negative one: the block
    // drags the baseline up, so a broad tag at the 35th percentile really is
    // below what these posts typically manage. The point of the test is that
    // none of the block is a finding, not that nothing is.
    const found = result.tags.filter((t) => t.significant).map((t) => t.key);
    assert.deepEqual(found, ['ordinary']);
  });

  test('the bar is the number of accounts, not a proportion of them', () => {
    const result = analyzeTags('comedy', [
      ...many(60, ['shared'], 0.8, MIN_CREATORS),
      ...many(60, ['narrow'], 0.8, MIN_CREATORS - 1),
    ]);
    assert.equal(result.tags.find((t) => t.key === 'shared')?.concentrated, false);
    assert.equal(result.tags.find((t) => t.key === 'narrow')?.concentrated, true);
  });
});

describe('what the numbers mean', () => {
  test('the searched word is not reported back as a tag', () => {
    // "Posts about comedy use #comedy" is not advice.
    const result = analyzeTags('comedy', many(40, ['comedy', 'funny'], 0.6, 20));
    assert.ok(!result.tags.some((t) => t.key === 'comedy'));
    assert.ok(result.tags.some((t) => t.key === 'funny'));
  });

  test('a hash and any casing find the same tag', () => {
    const result = analyzeTags('#Comedy', many(30, ['Comedy', 'FUNNY'], 0.6, 15));
    assert.equal(result.seed, 'comedy');
    assert.ok(!result.tags.some((t) => t.key === 'comedy'));
    assert.ok(result.tags.some((t) => t.key === 'funny'), 'tags should match case-insensitively');
  });

  test('the same tag twice on one post counts once', () => {
    const result = analyzeTags('comedy', [post(['funny', 'funny', 'FUNNY'], 0.6, 'c1')]);
    assert.equal(result.tags.find((t) => t.key === 'funny')?.n, 1);
  });

  test('the baseline is the matched set, never 50', () => {
    // Everything here ranks badly. A tag at the 30th percentile among posts
    // that average 30 is ordinary, not a failure, and lift has to say so.
    const result = analyzeTags('comedy', many(40, ['ordinary'], 0.3, 20));
    assert.equal(result.baseline, 30);
    assert.equal(result.tags.find((t) => t.key === 'ordinary')?.lift, 0);
  });

  test('reach is the median, so one viral post cannot speak for a tag', () => {
    const samples = [
      ...Array.from({ length: 9 }, (_, i) => post(['steady'], 0.5, `c${i}`, 1000)),
      post(['steady'], 0.5, 'c9', 10_000_000),
    ];
    const steady = analyzeTags('comedy', samples).tags.find((t) => t.key === 'steady');
    assert.equal(steady?.medianViews, 1000, 'a mean would report a million here');
  });

  test('an empty set produces nothing rather than dividing by zero', () => {
    const result = analyzeTags('comedy', []);
    assert.deepEqual(result.tags, []);
    assert.equal(result.n, 0);
    assert.equal(result.findings, 0);
  });

  test('findings come first, so the answer is at the top', () => {
    const result = analyzeTags('comedy', [
      ...many(40, ['proven'], 0.8, 20),
      ...many(40, ['ordinary'], 0.3, 20),
      ...many(30, ['blocked'], 0.95, 1),
    ]);
    assert.equal(result.tags[0]?.key, 'proven');
    assert.ok(result.tags[0].significant);
    // The 0.95 block is the biggest lift on the page and must not be first.
    assert.ok(!result.tags.slice(0, result.findings).some((t) => t.key === 'blocked'));
  });
});

describe('searching for something that is not there', () => {
  test('a word with no posts produces no findings rather than none-confidently', () => {
    const result = analyzeTags('nothing-like-this', []);
    assert.equal(result.n, 0);
    assert.equal(result.findings, 0);
    assert.deepEqual(result.tags, []);
    // The baseline of an empty set is zero, not fifty. Anything else would let
    // an empty search render a chart.
    assert.equal(result.baseline, 0);
  });

  test('a one-post match cannot become a finding', () => {
    // The shape a rare word produces: one post, one tag, one account, and a
    // lift computed against a baseline that is that same post.
    const result = analyzeTags('rare', [
      { tags: ['obscure'], creatorId: 'c1', percentile: 0.95, score: 95, views: 10, carriesSeed: true },
    ]);
    const row = result.tags.find((t) => t.key === 'obscure');
    assert.ok(row !== undefined);
    assert.equal(row.thin, true);
    assert.equal(row.concentrated, true);
    assert.equal(row.significant, false);
    assert.equal(result.findings, 0);
  });

  test('the shortest searchable word is stated, not implied', () => {
    // Below this only an exact tag is matched. `LIKE '%a%'` matched almost
    // every English title and produced three thousand posts and sixty
    // "findings" for a single letter — confident, and about nothing.
    assert.ok(MIN_TEXT_SEARCH >= 3, 'one and two letter substrings match everything');
  });
});
