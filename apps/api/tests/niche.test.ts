/**
 * Subjects where a small account beats what its size predicts.
 *
 * Three ways this measure goes wrong, all of them producing a list that looks
 * insightful and is not. Every test here is one of them:
 *
 *   1. **It ranks channel size.** Raw views put the biggest accounts on top,
 *      which is the thing every other page already does.
 *   2. **It ranks format.** Views per subscriber is five times higher for
 *      shorts than for ordinary videos, because YouTube shows shorts to people
 *      who have not subscribed. Uncorrected, the top of the list is simply
 *      whichever subjects are made as shorts.
 *   3. **It ranks one person's tag block.** A single account posting thirty
 *      videos under its own tag clears any item-count threshold, and has done
 *      so twice in this codebase already.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env['RADAR_NO_ENV_FILE'] = '1';
process.env['LOG_LEVEL'] = 'error';

const { MIN_CREATORS, MIN_ITEMS, findNiches } = await import('../src/core/niche.ts');
import type { NicheItem } from '../src/core/niche.ts';

function item(
  subjects: string[],
  contentType: string,
  creatorId: string,
  followers: number,
  views: number,
): NicheItem {
  return { subjects, contentType, creatorId, followers, views, title: `about ${subjects[0]}`, url: 'https://x.test' };
}

/** n items on one subject, spread over `creators` accounts. */
function many(
  n: number,
  subject: string,
  contentType: string,
  followers: number,
  views: number,
  creators: number,
): NicheItem[] {
  return Array.from({ length: n }, (_, i) =>
    item([subject], contentType, `c${i % creators}`, followers, views),
  );
}

/** Enough ordinary items to give a format a believable normal. */
function background(contentType: string, ratio: number, n = 40): NicheItem[] {
  return Array.from({ length: n }, (_, i) =>
    item([`filler${i % 12}`], contentType, `bg${i}`, 1000, 1000 * ratio),
  );
}

describe('what an opening is measured against', () => {
  test('a big channel with big numbers is not an opening', () => {
    // The failure that makes this page identical to every other page: ranking
    // by absolute reach. Both subjects here sit in the same size band, so the
    // comparison is purely about which one beats its peers.
    const result = findNiches([
      ...many(30, 'peers', 'video', 5000, 5_000, 15),
      ...many(20, 'strong', 'video', 5000, 40_000, 10),
    ]);
    const order = result.niches.map((n) => n.subject);
    assert.ok(
      order.indexOf('strong') < order.indexOf('peers'),
      'the subject beating accounts of its own size must come first',
    );
  });

  test('a subject is judged against accounts of its own size, not against all', () => {
    // Reach per subscriber falls steeply as an account grows — measured on a
    // real corpus, 10.1x under a hundred subscribers against 0.27x over a
    // hundred thousand, a 37-fold gradient. Dividing by followers does not
    // remove that, it inverts it. Uncorrected, this page ranks whichever
    // subjects very small accounts happen to tag.
    const result = findNiches([
      // Tiny accounts, all performing exactly as tiny accounts do.
      ...many(30, 'tiny-ordinary', 'video', 50, 2_500, 15),
      ...many(30, 'tiny-filler', 'video', 50, 2_500, 15),
      // A large account genuinely beating other large accounts.
      ...many(30, 'large-filler', 'video', 50_000, 50_000, 15),
      ...many(20, 'large-strong', 'video', 50_000, 400_000, 10),
    ]);
    const order = result.niches.map((n) => n.subject);
    assert.ok(
      order.indexOf('large-strong') < order.indexOf('tiny-ordinary'),
      'a large account beating its peers must outrank a tiny one merely being tiny',
    );
    const tiny = result.niches.find((n) => n.subject === 'tiny-ordinary');
    assert.ok(
      Math.abs((tiny?.lift ?? 0) - 1) < 0.5,
      `a tiny account performing normally for its size should read as ordinary, got ${tiny?.lift}x`,
    );
  });

  test('a subject is judged against its own format, not against everything', () => {
    // Shorts reach far beyond their subscribers, so an uncorrected ranking puts
    // every shorts subject on top regardless of merit.
    const result = findNiches([
      ...background('short_video', 10, 60),
      ...background('video', 1, 60),
      // Ordinary for a short: reach ten times followers, like every other short.
      ...many(20, 'ordinary-short', 'short_video', 1000, 10_000, 10),
      // Exceptional for a video: three times what videos normally manage.
      ...many(20, 'strong-video', 'video', 1000, 3_000, 10),
    ]);
    const shorts = result.niches.find((n) => n.subject === 'ordinary-short');
    const video = result.niches.find((n) => n.subject === 'strong-video');
    assert.ok(shorts !== undefined && video !== undefined);
    assert.ok(
      video.lift > shorts.lift,
      `a typical short (${shorts.lift}x) must not outrank a genuinely strong video (${video.lift}x)`,
    );
    assert.ok(Math.abs(shorts.lift - 1) < 0.5, 'a typical short should read as typical');
  });

  test('the normal for each format is reported, not hidden', () => {
    const result = findNiches([...background('short_video', 10, 60), ...background('video', 1, 60)]);
    const shorts = result.formatBaselines.find((b) => b.key === 'short_video');
    const video = result.formatBaselines.find((b) => b.key === 'video');
    assert.ok((shorts?.perFollower ?? 0) > (video?.perFollower ?? 0) * 5);
  });
});

describe('what cannot become an opening', () => {
  test('one account posting under its own tag is refused', () => {
    const result = findNiches([
      ...background('video', 1),
      ...many(30, 'my-own-tag', 'video', 100, 50_000, 1),
    ]);
    assert.ok(!result.niches.some((n) => n.subject === 'my-own-tag'));
    assert.equal(result.droppedForConcentration, 1, 'and the trim is counted, not silent');
  });

  test('the bar is accounts, and it is stated', () => {
    const enough = findNiches([...background('video', 1), ...many(20, 'shared', 'video', 100, 5000, MIN_CREATORS)]);
    const notEnough = findNiches([
      ...background('video', 1),
      ...many(20, 'narrow', 'video', 100, 5000, MIN_CREATORS - 1),
    ]);
    assert.ok(enough.niches.some((n) => n.subject === 'shared'));
    assert.ok(!notEnough.niches.some((n) => n.subject === 'narrow'));
    assert.equal(enough.minCreators, MIN_CREATORS);
  });

  test('a subject with too few items is not judged', () => {
    const result = findNiches([
      ...background('video', 1),
      ...many(MIN_ITEMS - 1, 'thin', 'video', 100, 50_000, MIN_CREATORS),
    ]);
    assert.ok(!result.niches.some((n) => n.subject === 'thin'));
  });

  test('an account nobody has subscribed to yet cannot be an outlier', () => {
    // A thousand views on two subscribers is not a five-hundred-times
    // breakout, it is a channel with no subscribers.
    const result = findNiches([
      ...background('video', 1),
      ...many(20, 'no-followers', 'video', 2, 1000, 10),
    ]);
    assert.ok(
      !result.niches.some((n) => n.subject === 'no-followers'),
      'dividing by almost nothing must not manufacture an opening',
    );
  });

  test('one viral item cannot speak for a subject', () => {
    const steady = many(19, 'steady', 'video', 1000, 1000, 10);
    const [first] = steady;
    assert.ok(first !== undefined);
    const withSpike = [...steady, item(['steady'], 'video', 'c99', 1000, 50_000_000)];
    const result = findNiches([...background('video', 1), ...withSpike]);
    const found = result.niches.find((n) => n.subject === 'steady');
    assert.ok(found !== undefined);
    assert.ok(found.lift < 5, `a median should absorb one spike, got ${found.lift}x`);
  });
});

describe('what the answer carries', () => {
  test('how contested a subject is, not only how well it does', () => {
    const result = findNiches([...background('video', 1), ...many(20, 'niche', 'video', 800, 9000, 10)]);
    const found = result.niches.find((n) => n.subject === 'niche');
    assert.equal(found?.medianFollowers, 800, 'the size of who is already there is the competition');
    assert.equal(found?.creators, 10);
  });

  test('examples, so the number can be checked against reality', () => {
    const result = findNiches([...background('video', 1), ...many(20, 'niche', 'video', 800, 9000, 10)]);
    const found = result.niches.find((n) => n.subject === 'niche');
    assert.ok((found?.examples.length ?? 0) > 0);
    assert.ok(found?.examples[0]?.url !== undefined);
  });

  test('nothing at all answers with nothing rather than dividing by zero', () => {
    const result = findNiches([]);
    assert.deepEqual(result.niches, []);
    assert.equal(result.n, 0);
    assert.deepEqual(result.formatBaselines, []);
  });
});

describe('how firm a finding is', () => {
  test('the bar can be moved, because the right one depends on the corpus', () => {
    // Found by re-running a real corpus at successive bars: at five, the top
    // was two subjects with near-identical figures — a tag block on the same
    // few accounts. At eight it changed character and then settled. A finding
    // that vanishes when you ask for three more accounts was not one.
    const items = [...background('video', 1), ...many(20, 'six-accounts', 'video', 100, 5000, 6)];
    assert.ok(findNiches(items, 5).niches.some((n) => n.subject === 'six-accounts'));
    assert.ok(!findNiches(items, 8).niches.some((n) => n.subject === 'six-accounts'));
  });

  test('the bar in force is reported, so a reader knows what they are looking at', () => {
    assert.equal(findNiches([], 12).minCreators, 12);
    assert.equal(findNiches([]).minCreators, MIN_CREATORS);
  });

  test('the default is the stricter one', () => {
    assert.ok(MIN_CREATORS >= 8, 'five let a tag block reach the top of a real corpus');
  });
});
