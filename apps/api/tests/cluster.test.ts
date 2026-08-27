import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildClusters, DEFAULT_CLUSTER_OPTIONS, keywordKey, type ClusterableItem } from '../src/core/cluster.ts';
import { simhash } from '../src/core/text.ts';
import { NOW } from './support/fixtures.ts';

function item(overrides: Partial<ClusterableItem> & Pick<ClusterableItem, 'id' | 'source' | 'text'>): ClusterableItem {
  return {
    simhash: simhash(overrides.text),
    creatorId: null,
    embedding: null,
    lang: 'en',
    country: null,
    hashtags: [],
    score: 50,
    state: 'RISING',
    views: null,
    engagement: null,
    seenAt: NOW - 600,
    ...overrides,
  };
}

const OPTIONS = { ...DEFAULT_CLUSTER_OPTIONS, now: NOW };

describe('clustering', () => {
  test('groups the same story reported by four different platforms', () => {
    const items = [
      item({ id: '1', source: 'youtube', text: 'Volcano erupts in Iceland forcing thousands to evacuate' }),
      item({ id: '2', source: 'reddit', text: 'Iceland volcano eruption forces thousands of evacuations' }),
      item({ id: '3', source: 'rss', text: 'Thousands evacuated as volcano erupts in Iceland' }),
      item({ id: '4', source: 'hackernews', text: 'Iceland volcano erupts, evacuation under way' }),
      item({ id: '5', source: 'rss', text: 'Central bank holds interest rates steady for a third meeting' }),
    ];

    const clusters = buildClusters(items, OPTIONS);
    const volcano = clusters.find((c) => c.members.length >= 4);
    assert.ok(volcano !== undefined, 'the volcano story should form one cluster');
    assert.equal(volcano.sources.length, 4);
    assert.ok(volcano.keywords.some((k) => k.includes('volcano') || k.includes('iceland')));
    assert.ok(!volcano.members.some((m) => m.id === '5'), 'the unrelated story must stay out');
  });

  test('unrelated items do not end up together', () => {
    const items = [
      item({ id: 'a', source: 'rss', text: 'New telescope captures image of a distant galaxy' }),
      item({ id: 'b', source: 'rss', text: 'Local bakery wins national sourdough competition' }),
      item({ id: 'c', source: 'rss', text: 'Stock markets close lower after inflation report' }),
    ];
    const clusters = buildClusters(items, { ...OPTIONS, minClusterSize: 1 });
    assert.equal(clusters.length, 3);
  });

  test('a verbatim repost joins even when the wording is thin', () => {
    const text = 'wait for it';
    const items = [
      item({ id: 'x', source: 'telegram', text }),
      item({ id: 'y', source: 'youtube', text }),
    ];
    const clusters = buildClusters(items, { ...OPTIONS, minClusterSize: 2 });
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0]?.members.length, 2);
  });

  test('cluster growth is measured in items joining per hour', () => {
    const items = [
      item({ id: '1', source: 'rss', text: 'Cargo ship runs aground blocking the canal', seenAt: NOW - 300 }),
      item({ id: '2', source: 'reddit', text: 'Canal blocked after cargo ship runs aground', seenAt: NOW - 900 }),
      item({ id: '3', source: 'youtube', text: 'Ship aground in canal blocks all traffic', seenAt: NOW - 5400 }),
    ];
    const cluster = buildClusters(items, { ...OPTIONS, minClusterSize: 2 })[0];
    assert.ok(cluster !== undefined);
    assert.equal(cluster.velocity, 2, 'two of the three arrived within the last hour');
    assert.equal(cluster.acceleration, 1);
  });

  test('a cross-platform cluster scores above a single-source one', () => {
    const spread = buildClusters(
      [
        item({ id: '1', source: 'youtube', text: 'Robot dog learns to open doors by itself' }),
        item({ id: '2', source: 'reddit', text: 'This robot dog can open doors by itself now' }),
        item({ id: '3', source: 'rss', text: 'Robot dog opens doors without help' }),
      ],
      { ...OPTIONS, minClusterSize: 2 },
    )[0];

    const alone = buildClusters(
      [
        item({ id: '4', source: 'rss', text: 'Ferry timetable changes take effect next Monday' }),
        item({ id: '5', source: 'rss', text: 'Changes to the ferry timetable start next Monday' }),
      ],
      { ...OPTIONS, minClusterSize: 2 },
    )[0];

    assert.ok(spread !== undefined && alone !== undefined);
    assert.ok(spread.score > alone.score, `${spread.score} should beat ${alone.score}`);
  });

  test('language and country distributions are reported as percentages', () => {
    const items = [
      item({ id: '1', source: 'youtube', text: 'Solar eclipse crosses the country today', lang: 'en', country: 'US' }),
      item({ id: '2', source: 'reddit', text: 'Total solar eclipse crosses the country', lang: 'en', country: 'US' }),
      item({ id: '3', source: 'rss', text: 'Eclipse solar cruza el país hoy solar eclipse', lang: 'es', country: 'MX' }),
    ];
    const cluster = buildClusters(items, { ...OPTIONS, minClusterSize: 2 })[0];
    assert.ok(cluster !== undefined);
    const total = cluster.languages.reduce((a, l) => a + l.pct, 0);
    assert.ok(total >= 99 && total <= 101, `percentages summed to ${total}`);
  });

  test('cluster identity is stable while the keywords are', () => {
    assert.equal(keywordKey(['b', 'a']), keywordKey(['a', 'b']));
    assert.notEqual(keywordKey(['a', 'b']), keywordKey(['c', 'd']));
  });

  test('handles an empty input without complaint', () => {
    assert.deepEqual(buildClusters([], OPTIONS), []);
  });
});
