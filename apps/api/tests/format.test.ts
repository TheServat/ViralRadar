/**
 * The format analysis.
 *
 * Two things are worth testing here, and they are different in kind. The
 * feature detection has to work on Persian and Arabic, not only on English —
 * an emoji regex that quietly matches nothing looks exactly like "emoji do not
 * help". And the statistics have to refuse to call noise a finding, which is
 * the whole reason the feature is trustworthy at all.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env['RADAR_NO_ENV_FILE'] = '1';
process.env['LOG_LEVEL'] = 'error';

const { analyzeFormats, assignFormatBucket, charCount, featuresOf, matchesFormatBucket, wordCount } =
  await import('../src/core/format.ts');
import type { FormatSample } from '../src/core/format.ts';
const { controlDiscoveryRate } = await import('../src/core/lift.ts');
import type { LiftBucket } from '../src/core/lift.ts';

describe('title features', () => {
  test('finds a question mark in every script that has one', () => {
    assert.ok(featuresOf('Is this working?', 'en').has('question'));
    assert.ok(featuresOf('این کار می‌کند؟', 'fa').has('question'), 'Persian question mark missed');
    assert.ok(featuresOf('هل يعمل هذا؟', 'ar').has('question'), 'Arabic question mark missed');
  });

  test('finds emoji, including ones outside the basic plane', () => {
    // This is the case a SQL LIKE cannot do: these are surrogate pairs.
    assert.ok(featuresOf('چالش کی هوش قوی تری داره؟😂😆', 'fa').has('emoji'));
    assert.ok(featuresOf('🔥 یک خرید؛ شانس بردن آیفون', 'fa').has('emoji'));
    assert.ok(!featuresOf('a plain title', 'en').has('emoji'));
  });

  test('finds digits in Persian and Arabic-Indic form', () => {
    assert.ok(featuresOf('۵ روش برای', 'fa').has('number'), 'Persian digits missed');
    assert.ok(featuresOf('٧ طرق', 'ar').has('number'), 'Arabic-Indic digits missed');
    assert.ok(featuresOf('5 ways', 'en').has('number'));
    assert.ok(!featuresOf('no numbers here', 'en').has('number'));
  });

  test('a listicle needs a number and something counted, not just a year', () => {
    assert.ok(featuresOf('۵ روش برای بهتر شدن', 'fa').has('listicle'));
    assert.ok(featuresOf('7 ways to cook rice', 'en').has('listicle'));
    // Leading number counts on its own; a year buried mid-title does not.
    assert.ok(featuresOf('10 Best Films', 'en').has('listicle'));
    assert.ok(!featuresOf('The Iran match in 2026', 'en').has('listicle'));
  });

  test('second person is detected per language', () => {
    assert.ok(featuresOf('This will change your life', 'en').has('you'));
    assert.ok(featuresOf('شما این را ندیده‌اید', 'fa').has('you'));
    assert.ok(!featuresOf('A report on the weather', 'en').has('you'));
  });

  test('shouting is a Latin-script idea only', () => {
    assert.ok(featuresOf('This is HUGE news', 'en').has('shout'));
    // Persian has no case, so nothing here should ever be called shouting.
    assert.ok(!featuresOf('این خبر بسیار مهم است', 'fa').has('shout'));
  });

  test('a hashtag must be a tag, not a stray hash', () => {
    assert.ok(featuresOf('funny clip #طنز', 'fa').has('hashtag'));
    assert.ok(!featuresOf('issue #', 'en').has('hashtag'));
  });
});

describe('counting', () => {
  test('an emoji is one character, not two', () => {
    // String.length says 6 here; the bucket boundaries depend on it being 5.
    assert.equal(charCount('abc😂d'), 5);
  });

  test('a Persian word joined by a zero-width non-joiner is one word', () => {
    assert.equal(wordCount('می‌رود'), 1);
    assert.equal(wordCount('این کار می‌کند'), 3);
  });

  test('empty and whitespace-only titles count as nothing', () => {
    assert.equal(wordCount('   '), 0);
    assert.equal(charCount('   '), 0);
  });
});

// ── Statistics ─────────────────────────────────────────────────────────────

function sample(title: string, percentile: number, contentType = 'video', lang = 'en'): FormatSample {
  return { title, contentType, lang, percentile, score: percentile * 100 };
}

/** n copies of one shape, so a bucket can be given a known mean and spread. */
function many(n: number, title: string, percentile: number, jitter = 0.05): FormatSample[] {
  return Array.from({ length: n }, (_, i) =>
    sample(title, percentile + (i % 2 === 0 ? jitter : -jitter)),
  );
}

describe('the format analysis', () => {
  test('an empty set produces nothing rather than dividing by zero', () => {
    const result = analyzeFormats([]);
    assert.equal(result.n, 0);
    assert.deepEqual(result.findings, []);
  });

  test('the baseline is the filtered set, not 50', () => {
    // Every item sits low inside its own platform, as Persian items actually
    // do. A hardcoded 50 would call all of this "below average".
    const result = analyzeFormats(many(40, 'plain title', 0.32));
    assert.ok(Math.abs(result.baseline - 32) < 1, `baseline was ${result.baseline}`);
    // Nothing differs from itself, so there is nothing to report.
    assert.equal(result.findings.length, 0);
  });

  test('a real difference is found and reported', () => {
    const result = analyzeFormats([
      ...many(60, 'a plain statement', 0.3),
      ...many(60, 'does this work?', 0.7),
    ]);
    const question = result.groups
      .find((g) => g.key === 'titlePattern')
      ?.buckets.find((b) => b.key === 'question');
    assert.ok(question !== undefined, 'the question bucket is missing');
    assert.ok(question.significant, 'a 40-point gap should be significant');
    assert.ok(question.lift > 15, `lift was ${question.lift}`);
    assert.ok(result.findings.some((f) => f.key === 'question'));
  });

  test('noise is not called a finding', () => {
    // Two groups that differ by well under their own spread.
    const result = analyzeFormats([
      ...many(60, 'a plain statement', 0.5, 0.25),
      ...many(60, 'does this work?', 0.51, 0.25),
    ]);
    const question = result.groups
      .find((g) => g.key === 'titlePattern')
      ?.buckets.find((b) => b.key === 'question');
    assert.ok(question !== undefined);
    assert.equal(question.significant, false, 'a 1-point gap must not be a finding');
    assert.equal(result.findings.length, 0);
  });

  test('a thin bucket is shown but never called a result', () => {
    const result = analyzeFormats([
      ...many(60, 'a plain statement', 0.3),
      // Three items at a wildly better rank: exactly the shape that produces a
      // confident-looking lie.
      ...many(3, 'does this work?', 0.95, 0.01),
    ]);
    const question = result.groups
      .find((g) => g.key === 'titlePattern')
      ?.buckets.find((b) => b.key === 'question');
    assert.ok(question !== undefined);
    assert.equal(question.n, 3);
    assert.equal(question.thin, true);
    assert.equal(question.significant, false, 'three items must never be significant');
    assert.equal(result.findings.length, 0);
  });

  test('a single item has an infinite interval, not a perfect one', () => {
    const result = analyzeFormats([...many(40, 'plain', 0.3), sample('one only?', 0.99)]);
    const question = result.groups
      .find((g) => g.key === 'titlePattern')
      ?.buckets.find((b) => b.key === 'question');
    assert.ok(question !== undefined);
    assert.equal(question.significant, false);
    assert.equal(question.margin, 100, 'one item should report the widest possible margin');
  });

  test('length buckets stay in order, strongest or not', () => {
    const result = analyzeFormats([
      ...many(30, 'short', 0.4),
      ...many(30, 'a considerably longer title than the other one here now', 0.8),
    ]);
    const lengths = result.groups.find((g) => g.key === 'titleLength');
    assert.ok(lengths !== undefined);
    const keys = lengths.buckets.map((b) => b.key);
    const expected = ['0-30', '31-50', '51-70', '71-100', '100+'].filter((k) => keys.includes(k));
    assert.deepEqual(keys, expected, 'length buckets must read short to long');
  });

  test('content types are compared against each other', () => {
    const result = analyzeFormats([
      ...Array.from({ length: 50 }, (_, i) => sample('x', 0.25 + (i % 2) * 0.05, 'link')),
      ...Array.from({ length: 50 }, (_, i) => sample('y', 0.75 + (i % 2) * 0.05, 'short_video')),
    ]);
    const types = result.groups.find((g) => g.key === 'contentType');
    assert.ok(types !== undefined);
    // Sorted strongest first when there is no natural order.
    assert.equal(types.buckets[0]?.key, 'short_video');
    assert.ok(types.buckets[0]?.significant);
  });

  test('features that nothing has are left out entirely', () => {
    const result = analyzeFormats(many(40, 'plain title', 0.4));
    const patterns = result.groups.find((g) => g.key === 'titlePattern');
    assert.ok(patterns !== undefined);
    assert.equal(patterns.buckets.length, 0, 'no feature is present, so no rows');
  });
});

// ── The drill-down ─────────────────────────────────────────────────────────
//
// Clicking a bar shows the items behind it, and those items are selected by
// the same functions the chart bucketed with. If the two ever diverge the page
// shows examples that are not what the bar measured — a wrong answer with no
// visible symptom, which is the worst kind this system can produce. These
// tests are the join that holds them together.

describe('the examples behind a bar', () => {
  const corpus: FormatSample[] = [
    ...many(30, 'short one', 0.4),
    ...many(30, 'a considerably longer title than the other one here right now', 0.8),
    ...many(20, '5 ways to fix your setup?', 0.6),
    ...many(10, 'یک عنوان فارسی با ۳ نکته', 0.5),
    sample('a link', 0.3, 'link'),
    sample('another link', 0.35, 'link'),
  ];

  test('every bucket selects exactly the items it was counted from', () => {
    const result = analyzeFormats(corpus);
    let checked = 0;
    for (const group of result.groups) {
      for (const bucket of group.buckets) {
        const selected = corpus.filter((s) => matchesFormatBucket(group.key, bucket.key, s));
        assert.equal(
          selected.length,
          bucket.n,
          `${group.key}/${bucket.key}: the drill-down and the chart disagree`,
        );
        checked++;
      }
    }
    assert.ok(checked > 8, 'the corpus should exercise more than a couple of buckets');
  });

  test('an overlapping title pattern is matched per feature', () => {
    // The point of asking membership per feature rather than assigning one
    // key: this title is three of them at once.
    const both = sample('5 ways to fix your setup?', 0.6);
    assert.ok(matchesFormatBucket('titlePattern', 'question', both));
    assert.ok(matchesFormatBucket('titlePattern', 'listicle', both));
    assert.ok(matchesFormatBucket('titlePattern', 'you', both));
    assert.ok(!matchesFormatBucket('titlePattern', 'emoji', both));
  });

  test('an unknown group matches nothing rather than everything', () => {
    assert.equal(assignFormatBucket('nonsense', sample('x', 0.5)), null);
    assert.ok(!matchesFormatBucket('nonsense', 'anything', sample('x', 0.5)));
  });
});

describe('a bucket that did not vary', () => {
  test('identical values are unmeasurable, not certain', () => {
    // The arithmetic trap: variance 0 gives margin 0, and every lift clears
    // zero. Seen live as `audio` — 127 items whose source_percentile was 0 for
    // all of them, rendering as "-34.1 +/- 0.0, real difference" at the top of
    // the page, which is the bucket carrying the least information presented as
    // the most confident claim on it.
    const flat = Array.from({ length: 60 }, () => sample('same', 0.2));
    const varied = Array.from({ length: 60 }, (_, i) => sample('other', 0.8 + (i % 2) * 0.04, 'link'));
    const result = analyzeFormats([...flat, ...varied]);

    const same = result.groups
      .find((g) => g.key === 'contentType')
      ?.buckets.find((b) => b.key === 'video');
    assert.ok(same !== undefined);
    assert.ok(Math.abs(same.lift) > 20, 'the lift is real and large');
    assert.equal(same.margin, 100, 'and the interval is the widest possible, not zero');
    assert.equal(same.significant, false, 'so it is never a finding');
  });

  test('a bucket with real spread is unaffected', () => {
    const result = analyzeFormats([
      ...Array.from({ length: 60 }, (_, i) => sample('a', 0.8 + (i % 2) * 0.05)),
      ...Array.from({ length: 60 }, (_, i) => sample('b', 0.2 + (i % 2) * 0.05, 'link')),
    ]);
    const bucket = result.groups
      .find((g) => g.key === 'contentType')
      ?.buckets.find((b) => b.key === 'video');
    assert.ok(bucket?.significant, 'a genuine 60-point gap must still be a finding');
    assert.ok((bucket?.margin ?? 100) < 10);
  });
});

describe('asking eighty questions at once', () => {
  /*
   * Every bucket is tested at 95% on its own, and the pages then flatten all
   * of them into one list headed "real differences". One screen of the live
   * database is 80 tests; 41 of them cleared a lone 95% test. At one in twenty
   * each, some of those are the price of asking eighty questions rather than
   * anything about the data.
   *
   * Benjamini-Hochberg rather than Bonferroni, because the thing worth
   * protecting is the share of the findings that are wrong, not the chance
   * that any one of them is - Bonferroni would empty a genuinely interesting
   * page to avoid a single mistake.
   */

  function bucket(key: string, p: number): LiftBucket {
    // Only `p`, `thin` and `significant` matter to the correction; the rest is
    // filled in so this is a real bucket rather than a shape that happens to
    // typecheck.
    return {
      key,
      n: 100,
      percentile: 50,
      lift: 5,
      margin: 2,
      significant: p <= 0.05,
      p,
      thin: false,
      medianScore: 10,
    };
  }

  const survivors = (buckets: LiftBucket[]): string[] =>
    (controlDiscoveryRate([{ key: 'g', buckets }])[0]?.buckets ?? [])
      .filter((b) => b.significant)
      .map((b) => b.key);

  test('a page of strong findings keeps all of them', () => {
    // The property that makes this usable at all. A correction that punished
    // a page for being interesting would be worse than none.
    const strong = Array.from({ length: 20 }, (_, i) => bucket(`s${i}`, 1e-8));
    assert.equal(survivors(strong).length, 20);
  });

  test('knife-edge findings are withdrawn once enough questions were asked', () => {
    // The shape of a real page: twenty results just inside 0.05 among sixty
    // that found nothing. Twenty of eighty at one-in-twenty each is about what
    // asking eighty questions produces on its own.
    const marginal = Array.from({ length: 20 }, (_, i) => bucket(`m${i}`, 0.04));
    const quiet = Array.from({ length: 60 }, (_, i) => ({ ...bucket(`q${i}`, 0.9), significant: false }));
    assert.deepEqual(
      survivors([...marginal, ...quiet]),
      [],
      'twenty knife-edge results among eighty tests are not twenty findings',
    );
  });

  test('the same marginal result survives when it is the only question asked', () => {
    // BH is about multiplicity, not about a stricter threshold. One test at
    // p=0.04 is still a finding.
    assert.deepEqual(survivors([bucket('only', 0.04)]), ['only']);
  });

  test('the questions that found nothing still count as questions', () => {
    // The denominator is every test that could have been a finding. Counting
    // only the ones that passed would make the correction almost inert - which
    // is the mistake that looks correct.
    const marginal = bucket('m', 0.04);
    const alone = survivors([marginal]);
    const amongMany = survivors([
      marginal,
      ...Array.from({ length: 60 }, (_, i) => ({ ...bucket(`q${i}`, 0.9), significant: false })),
    ]);
    assert.deepEqual(alone, ['m']);
    assert.deepEqual(amongMany, []);
  });

  test('a strong finding is not dragged down by weak company', () => {
    const mixed = [bucket('real', 1e-9), ...Array.from({ length: 30 }, (_, i) => bucket(`noise${i}`, 0.9))];
    assert.deepEqual(survivors(mixed), ['real']);
  });

  test('the correction only ever withdraws', () => {
    // A bucket the single test declined must stay declined: this exists to
    // take findings away, never to add them.
    const declined = { ...bucket('declined', 0.2), significant: false };
    assert.deepEqual(survivors([declined, bucket('kept', 1e-9)]), ['kept']);
  });

  test('thin buckets are not counted as questions', () => {
    // They were never eligible to be findings, so including them would make
    // the correction harsher for nothing.
    const thin = Array.from({ length: 100 }, (_, i) => ({ ...bucket(`t${i}`, 0.9), thin: true, significant: false }));
    assert.deepEqual(survivors([bucket('real', 0.04), ...thin]), ['real']);
  });
});
