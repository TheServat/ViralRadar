/**
 * Demand against supply.
 *
 * The risk this analysis carries is not a wrong number, it is a wrong *claim*.
 * "Nobody has made this" is a strong thing to say, and everything below is
 * about the ways it could be said when it is not true:
 *
 *   - A topic with coverage sitting just under the bar must not be reported as
 *     empty without the near miss being visible.
 *   - One video is not a subject being served.
 *   - With no embedding model the comparison is far weaker, and a row matched
 *     that way has to say so rather than looking identical to a real one.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env['RADAR_NO_ENV_FILE'] = '1';
process.env['LOG_LEVEL'] = 'error';

const { COVERED_AT, THIN_BELOW, findGaps } = await import('../src/core/gap.ts');
import type { DemandTopic, SupplyItem } from '../src/core/gap.ts';

/** A unit vector pointing mostly along one axis, so similarity is controllable. */
function vector(angle: number): Float32Array {
  return new Float32Array([Math.cos(angle), Math.sin(angle)]);
}

function topic(title: string, angle: number | null, score = 50, countries = 1): DemandTopic {
  return {
    id: `t:${title}`,
    title,
    score,
    lang: 'fa',
    country: 'IR',
    firstSeenAt: 0,
    countries,
    vector: angle === null ? null : vector(angle),
  };
}

function item(title: string, angle: number | null, percentile = 0.5): SupplyItem {
  return {
    id: `i:${title}`,
    title,
    url: `https://example.test/${encodeURIComponent(title)}`,
    percentile,
    vector: angle === null ? null : vector(angle),
  };
}

/** An angle whose cosine against 0 is the similarity asked for. */
const at = (similarity: number): number => Math.acos(similarity);

describe('deciding what is uncovered', () => {
  test('a search with nothing like it is a gap', () => {
    const result = findGaps([topic('gold price', 0)], [item('cooking rice', at(0.2))]);
    const gap = result.gaps[0];
    assert.equal(gap?.verdict, 'uncovered');
    assert.equal(gap.covered, 0);
    assert.equal(result.uncovered, 1);
  });

  test('a search with several videos about it is covered', () => {
    const supply = Array.from({ length: THIN_BELOW }, (_, i) => item(`about it ${i}`, at(0.85)));
    const gap = findGaps([topic('gta 6', 0)], supply).gaps[0];
    assert.equal(gap?.verdict, 'covered');
    assert.equal(gap.covered, THIN_BELOW);
  });

  test('one video is not a subject being served', () => {
    const gap = findGaps([topic('a singer', 0)], [item('the one video', at(0.9))]).gaps[0];
    assert.equal(gap?.covered, 1);
    assert.equal(gap.verdict, 'thin', 'one is coverage, but it is not the subject being served');
  });

  test('the near miss is reported, so a gap can be overruled', () => {
    // The case that would otherwise be a confident lie: real coverage sitting
    // just under the bar, reported as "nobody has made this".
    const nearly = COVERED_AT - 0.05;
    const gap = findGaps([topic('quinn ewers', 0)], [item('Dolphins trade Quinn Ewers', at(nearly))]).gaps[0];
    assert.equal(gap?.verdict, 'uncovered');
    assert.equal(gap.matches.length, 1, 'the closest thing must still be shown');
    assert.ok((gap.matches[0]?.similarity ?? 0) > 0.6, 'and its score, so the miss is visible');
  });

  test('nothing at all is different from a weak match', () => {
    const gap = findGaps([topic('anything', 0)], []).gaps[0];
    assert.deepEqual(gap?.matches, []);
    assert.equal(gap.verdict, 'uncovered');
  });
});

describe('what the page is allowed to claim', () => {
  test('rows are ranked by demand, not by emptiness', () => {
    // A gap nobody is searching for is an absence, not an opportunity.
    const result = findGaps(
      [topic('barely searched', 0, 5), topic('heavily searched', 0, 90)],
      [item('unrelated', at(0.1))],
    );
    assert.equal(result.gaps[0]?.topic, 'heavily searched');
  });

  test('the bar the analysis used is reported, not assumed by the reader', () => {
    const result = findGaps([topic('x', 0)], []);
    assert.equal(result.coveredAt, COVERED_AT);
    assert.equal(result.thinBelow, THIN_BELOW);
  });

  test('a topic with no vector says it was matched on words', () => {
    // Weaker in a way the interface has to be able to show. A row that fell
    // back to word overlap must not look like one matched by meaning.
    const byWords = findGaps([topic('gold price today', null)], [item('gold price today rises', null)]).gaps[0];
    assert.equal(byWords?.byMeaning, false);

    const byMeaning = findGaps([topic('gold', 0)], [item('gold', 0)]).gaps[0];
    assert.equal(byMeaning?.byMeaning, true);
  });

  test('the word fallback still finds an obvious match', () => {
    const gap = findGaps(
      [topic('tehran weather forecast', null)],
      [item('tehran weather forecast for tomorrow', null), item('something else entirely', null)],
    ).gaps[0];
    assert.ok((gap?.matches[0]?.similarity ?? 0) > 0, 'sharing every word should score above nothing');
    assert.equal(gap?.matches[0]?.title, 'tehran weather forecast for tomorrow');
  });

  test('an empty run answers with zeroes rather than dividing by nothing', () => {
    const result = findGaps([], []);
    assert.deepEqual(result.gaps, []);
    assert.equal(result.uncovered, 0);
    assert.equal(result.topics, 0);
    assert.equal(result.supply, 0);
  });

  test('the closest matches come back in order', () => {
    const gap = findGaps(
      [topic('subject', 0)],
      [item('far', at(0.3)), item('near', at(0.9)), item('middle', at(0.6))],
    ).gaps[0];
    assert.deepEqual(gap?.matches.map((m) => m.title), ['near', 'middle', 'far']);
  });
});

describe('a subject that travels', () => {
  test('reach across countries outranks being slightly hotter in one', () => {
    // The whole reason for watching thirty countries. A fixture trending
    // hard in one place is local and there are hundreds of those a day; a
    // subject arriving in six places at once is a phenomenon, and only a
    // phenomenon can be made for an audience that has not been served it.
    const result = findGaps(
      [topic('hot at home', 0, 95, 1), topic('everywhere', 0, 60, 6)],
      [item('unrelated', at(0.1))],
    );
    assert.equal(result.gaps[0]?.topic, 'everywhere');
  });

  test('within the same reach, the hotter subject wins', () => {
    const result = findGaps(
      [topic('warm', 0, 40, 3), topic('hotter', 0, 80, 3)],
      [item('unrelated', at(0.1))],
    );
    assert.equal(result.gaps[0]?.topic, 'hotter');
  });

  test('the count travels with the row, so the page can show it', () => {
    const gap = findGaps([topic('global', 0, 50, 9)], []).gaps[0];
    assert.equal(gap?.countries, 9);
  });
});
