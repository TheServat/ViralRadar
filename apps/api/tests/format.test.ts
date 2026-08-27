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

const { analyzeFormats, charCount, featuresOf, wordCount } = await import('../src/core/format.ts');
import type { FormatSample } from '../src/core/format.ts';

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
