/**
 * Choosing which seed words to spend quota on.
 *
 * Each search costs 100 quota units, so a word that has never surfaced
 * anything is a standing bill. But demoting on thin evidence is worse than
 * paying it: a newly added word looks identical to a dead one until it has had
 * enough turns, and a permanent demotion would freeze a judgement about a
 * moving target.
 *
 * These tests pin down both halves — that measurement is used, and that it is
 * not trusted before it means anything.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env['RADAR_NO_ENV_FILE'] = '1';
process.env['LOG_LEVEL'] = 'error';

const { rotateTerms, selectTerms } = await import('../src/sources/youtube.ts');
import type { TermRecord } from '../src/sources/youtube.ts';

const TERMS = ['alpha', 'beta', 'gamma', 'delta'];

/** A word tried `found` times that produced `moving` things worth looking at. */
function rec(term: string, found: number, moving: number): TermRecord {
  return { term, found, moving };
}

describe('plain rotation', () => {
  test('gives every word its turn, in order', () => {
    assert.deepEqual(rotateTerms(TERMS, 0, 2), ['alpha', 'beta']);
    assert.deepEqual(rotateTerms(TERMS, 2, 2), ['gamma', 'delta']);
  });

  test('wraps around rather than running out', () => {
    assert.deepEqual(rotateTerms(TERMS, 3, 2), ['delta', 'alpha']);
  });

  test('never asks for more words than exist', () => {
    assert.equal(rotateTerms(TERMS, 0, 99).length, TERMS.length);
  });

  test('an empty list is not an error', () => {
    assert.deepEqual(rotateTerms([], 0, 2), []);
    assert.deepEqual(rotateTerms(TERMS, 0, 0), []);
  });
});

describe('selection with no measurements', () => {
  test('behaves exactly like the plain rotation', () => {
    // The state of every fresh database. Measurement must be an addition, not
    // a precondition.
    for (let cursor = 0; cursor < 6; cursor++) {
      assert.deepEqual(
        selectTerms(TERMS, cursor, 2, [], 1),
        rotateTerms(TERMS, cursor, 2),
        `cursor ${cursor}`,
      );
    }
  });
});

describe('selection with measurements', () => {
  // 'beta' has had plenty of turns and produced nothing.
  const dead = [rec('alpha', 100, 12), rec('beta', 80, 0), rec('gamma', 100, 5)];

  test('a word with real evidence against it is skipped', () => {
    const picked = selectTerms(TERMS, 0, 3, dead, 1);
    assert.ok(!picked.includes('beta'), 'a word measured as dead should not be paid for');
    assert.equal(picked.length, 3);
  });

  test('a word without enough turns is never demoted', () => {
    // Same zero movers, but only a handful of tries: that is not evidence.
    const thin = [rec('beta', 5, 0)];
    assert.ok(selectTerms(TERMS, 0, 4, thin, 1).includes('beta'));
  });

  test('a word that has produced something is kept however little', () => {
    const barely = [rec('beta', 500, 1)];
    assert.ok(selectTerms(TERMS, 0, 4, barely, 1).includes('beta'));
  });

  test('demotion is revisable: dead words get a turn periodically', () => {
    // Every fifth run belongs to the demoted, so a judgement about a moving
    // target can be overturned by new evidence.
    const retried = selectTerms(TERMS, 0, 1, dead, 5);
    assert.deepEqual(retried, ['beta']);
  });

  test('the retry run only offers the demoted words', () => {
    const twoDead = [rec('beta', 80, 0), rec('delta', 90, 0)];
    const picked = selectTerms(TERMS, 0, 2, twoDead, 10);
    assert.deepEqual(picked.sort(), ['beta', 'delta']);
  });

  test('every word being dead does not stop searching', () => {
    // The failure this guards against is silent: returning nothing would end
    // discovery entirely, and look like a quiet system rather than a broken one.
    const allDead = TERMS.map((t) => rec(t, 100, 0));
    const picked = selectTerms(TERMS, 0, 2, allDead, 1);
    assert.equal(picked.length, 2);
  });

  test('a record for a word that is no longer configured is ignored', () => {
    const stale = [rec('removed-word', 100, 0), rec('alpha', 100, 9)];
    const picked = selectTerms(TERMS, 0, 4, stale, 1);
    assert.deepEqual(picked.sort(), [...TERMS].sort());
  });
});
