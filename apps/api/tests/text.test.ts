import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  contentTokens,
  detectLanguage,
  extractEntities,
  hammingDistance,
  isNearDuplicate,
  jaccard,
  labelFromKeywords,
  normaliseText,
  simhash,
  TfIdf,
} from '../src/core/text.ts';

describe('normalisation', () => {
  test('folds Persian and Arabic glyph variants together', () => {
    // The same word written with Arabic ya/kaf and with Persian ye/ke.
    assert.equal(normaliseText('كيف'), normaliseText('کیف'));
  });

  test('strips URLs and punctuation but keeps hashtags', () => {
    assert.equal(normaliseText('Look! https://x.com/a #Bitcoin, now.'), 'look #bitcoin now');
  });

  test('converts Persian and Arabic digits', () => {
    assert.equal(normaliseText('۱۲۳'), '123');
    assert.equal(normaliseText('٤٥٦'), '456');
  });
});

describe('language detection', () => {
  const cases: readonly [string, string][] = [
    ['The president said the new policy will apply to all of the states', 'en'],
    ['این ویدیو خیلی سریع در حال پخش شدن است و همه درباره آن صحبت می کنند', 'fa'],
    ['هذا الفيديو ينتشر بسرعة كبيرة في جميع أنحاء العالم من الناس', 'ar'],
    ['Der neue Film ist sehr gut und die Leute sprechen mit ihm darüber', 'de'],
    ['Esta es una noticia muy importante para todos los que están en el país', 'es'],
    ['この動画はとても人気があります', 'ja'],
  ];

  for (const [text, expected] of cases) {
    test(`identifies ${expected}`, () => {
      const guess = detectLanguage(text);
      assert.equal(guess.code, expected);
      assert.ok(guess.confidence > 0.4, `confidence was ${guess.confidence}`);
    });
  }

  test('a short English headline is not mistaken for Dutch or German', () => {
    // Real titles that the first implementation misread, because "in" and "man"
    // are shared function words and it counted shared hits equally.
    for (const title of [
      'FDA approves first in class targeted therapy for lung cancer',
      '11,000-year-old sculpture of man riding a leopard',
      'GitHub Outage Tracker: Is GitHub Cooked?',
    ]) {
      assert.equal(detectLanguage(title).code, 'en', title);
    }
  });

  test('returns null rather than guessing on an empty string', () => {
    assert.equal(detectLanguage('   ').code, null);
    assert.equal(detectLanguage('   ').confidence, 0);
  });
});

describe('entities', () => {
  test('pulls hashtags, mentions, domains and proper nouns', () => {
    const e = extractEntities('Breaking News from Los Angeles #wildfire @cnn https://cnn.com/story');
    assert.deepEqual(e.hashtags, ['wildfire']);
    assert.deepEqual(e.mentions, ['cnn']);
    assert.deepEqual(e.domains, ['cnn.com']);
    assert.ok(e.properNouns.includes('Los Angeles'));
  });
});

describe('tokens', () => {
  test('drops stopwords, single characters and bare numbers', () => {
    // "best" is itself a stopword here: title filler carries no topic signal.
    assert.deepEqual(contentTokens('The 5 best ways to a b cook rice'), ['ways', 'cook', 'rice']);
  });

  test('splits CJK into character bigrams so it can be compared at all', () => {
    assert.ok(contentTokens('人気動画').length > 1);
  });
});

describe('near-duplicate detection', () => {
  test('a reworded repost stays close', () => {
    const a = simhash('Massive explosion reported at the port in the capital city this morning');
    const b = simhash('A massive explosion was reported at the capital city port this morning');
    assert.ok(hammingDistance(a, b) <= 8, `distance was ${hammingDistance(a, b)}`);
  });

  test('unrelated texts stay far apart', () => {
    const a = simhash('Massive explosion reported at the port in the capital city');
    const b = simhash('New study finds coffee may improve long distance running performance');
    assert.ok(hammingDistance(a, b) > 15);
  });

  test('identical text is distance zero', () => {
    assert.equal(simhash('same words here'), simhash('same words here'));
    assert.ok(isNearDuplicate(simhash('same words here'), simhash('same words here')));
  });
});

describe('similarity', () => {
  test('jaccard is 1 for identical sets and 0 for disjoint ones', () => {
    assert.equal(jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
    assert.equal(jaccard(new Set(['a']), new Set(['b'])), 0);
  });
});

describe('tf-idf', () => {
  test('ranks the term that is rare across documents above the common one', () => {
    const idf = new TfIdf();
    const documents = [
      ['election', 'results', 'today'],
      ['election', 'results', 'yesterday'],
      ['election', 'results', 'tomorrow'],
      ['election', 'results', 'quokka'],
    ];
    for (const d of documents) idf.add(d);
    const top = idf.top(['election', 'results', 'quokka'], 4).map((k) => k.term);
    // The distinguishing term wins, alone or inside the phrase that carries it.
    assert.ok((top[0] as string).includes('quokka'), `top term was ${top[0]}`);
    assert.ok(top.indexOf('election') > 1, 'the term shared by every document should rank last');
  });

  test('a term in every document carries almost no weight', () => {
    const idf = new TfIdf();
    for (let i = 0; i < 10; i++) idf.add(['news', `story${i}`]);
    assert.ok(idf.idf('news') < idf.idf('story3'));
  });
});

describe('labels', () => {
  test('builds a readable label from keywords', () => {
    assert.equal(labelFromKeywords(['solar eclipse', 'viewing']), 'Solar Eclipse · Viewing');
  });

  test('drops overlapping keywords instead of repeating every word', () => {
    // Sliding bigrams of one sentence, which is what tf-idf actually returns.
    const label = labelFromKeywords(['air condition', 'condition luxury', 'luxury necessity', 'summer']);
    assert.equal(label, 'Air Condition · Summer');
  });

  test('says so rather than inventing a name when there is nothing', () => {
    assert.equal(labelFromKeywords([]), 'unlabelled');
  });
});
