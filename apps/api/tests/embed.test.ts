/**
 * Semantic clustering.
 *
 * Vectors are supplied by hand rather than by a model, so these tests need no
 * Ollama, no network and no download — and they can construct the exact
 * situations that matter, including the ones a real model would rarely produce
 * on demand.
 *
 * The behaviours worth pinning down are all about restraint: the pass must add
 * nothing when it is switched off, must never split what the lexical pass
 * built, and must refuse a model that cannot tell related text from unrelated.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env['RADAR_NO_ENV_FILE'] = '1';
process.env['LOG_LEVEL'] = 'error';

const { buildClusters, DEFAULT_CLUSTER_OPTIONS } = await import('../src/core/cluster.ts');
const { fromBlob, normalise, similarity, toBlob } = await import('../src/ai/embed.ts');
import type { ClusterableItem } from '../src/core/cluster.ts';

const NOW = 1_750_000_000;

/** A unit vector pointing mostly along one axis, with a little of another. */
function vector(axis: number, blend = 0): Float32Array {
  const raw = new Array<number>(8).fill(0);
  raw[axis] = 1;
  if (blend > 0) raw[(axis + 1) % 8] = blend;
  return normalise(raw);
}

function item(
  id: string,
  text: string,
  embedding: Float32Array | null,
  overrides: Partial<ClusterableItem> = {},
): ClusterableItem {
  return {
    id,
    source: 'test',
    text,
    simhash: null,
    creatorId: null,
    lang: 'en',
    country: null,
    hashtags: [],
    score: 50,
    state: 'RISING',
    views: null,
    engagement: null,
    seenAt: NOW,
    embedding,
    ...overrides,
  };
}

const OPTIONS = { ...DEFAULT_CLUSTER_OPTIONS, now: NOW, minClusterSize: 1 };

describe('vector storage', () => {
  test('a vector survives the round trip through a blob', () => {
    const original = normalise([1, 2, 3, 4]);
    const restored = fromBlob(toBlob(original));
    assert.equal(restored.length, original.length);
    for (let i = 0; i < original.length; i++) {
      assert.ok(Math.abs((restored[i] as number) - (original[i] as number)) < 1e-6);
    }
  });

  test('normalising makes similarity a plain dot product', () => {
    const a = normalise([3, 0, 0]);
    const b = normalise([9, 0, 0]);
    // Same direction, different magnitude: cosine 1.
    assert.ok(Math.abs(similarity(a, b) - 1) < 1e-6);
    assert.ok(Math.abs(similarity(normalise([1, 0]), normalise([0, 1]))) < 1e-6);
  });

  test('a zero vector is similar to nothing rather than to everything', () => {
    const zero = normalise([0, 0, 0]);
    assert.equal(similarity(zero, normalise([1, 2, 3])), 0);
  });

  test('vectors of different lengths never compare as similar', () => {
    // Two models produce incompatible spaces; a number here would be a lie.
    assert.equal(similarity(normalise([1, 0]), normalise([1, 0, 0])), 0);
  });
});

describe('semantic merging', () => {
  const farApart = [
    item('a', 'the central bank raised interest rates', vector(0)),
    item('b', 'بانک مرکزی نرخ بهره را افزایش داد', vector(0, 0.05), { lang: 'fa' }),
    item('c', 'a recipe for chocolate cake', vector(4)),
  ];

  test('switched off, embeddings change nothing', () => {
    const off = buildClusters(farApart, { ...OPTIONS, semanticMergeThreshold: 0 });
    // Three texts with no shared vocabulary: three topics.
    assert.equal(off.length, 3);
  });

  test('items with no vector are left exactly as the lexical pass had them', () => {
    const none = farApart.map((i) => ({ ...i, embedding: null }));
    const withPass = buildClusters(none, { ...OPTIONS, semanticMergeThreshold: 0.86 });
    const withoutPass = buildClusters(none, { ...OPTIONS, semanticMergeThreshold: 0 });
    assert.equal(withPass.length, withoutPass.length);
  });

  test('the same story in two languages becomes one topic', () => {
    const merged = buildClusters(farApart, { ...OPTIONS, semanticMergeThreshold: 0.86 });
    assert.equal(merged.length, 2, 'the two rate stories should have joined');

    const both = merged.find((c) => c.members.length === 2);
    assert.ok(both !== undefined);
    assert.deepEqual(both.members.map((m) => m.id).sort(), ['a', 'b']);
    // And the topic now knows it spans two languages, which is the point.
    assert.deepEqual(both.languages.map((l) => l.code).sort(), ['en', 'fa']);
  });

  test('unrelated things stay apart however low the bar for related ones', () => {
    const merged = buildClusters(farApart, { ...OPTIONS, semanticMergeThreshold: 0.86 });
    const cake = merged.find((c) => c.members.some((m) => m.id === 'c'));
    assert.ok(cake !== undefined);
    assert.equal(cake.members.length, 1, 'the cake recipe must not join a finance topic');
  });

  test('merging is transitive, so a story in three languages is one topic', () => {
    const chain = [
      item('en', 'the central bank raised rates', vector(0)),
      item('fa', 'بانک مرکزی نرخ بهره را بالا برد', vector(0, 0.04), { lang: 'fa' }),
      item('ar', 'رفع البنك المركزي أسعار الفائدة', vector(0, 0.08), { lang: 'ar' }),
    ];
    const merged = buildClusters(chain, { ...OPTIONS, semanticMergeThreshold: 0.86 });
    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.members.length, 3);
  });

  test('a mix of embedded and unembedded items still clusters', () => {
    // The normal state of a live database: the job has not caught up yet.
    const partial = [
      item('a', 'the central bank raised interest rates', vector(0)),
      item('b', 'بانک مرکزی نرخ بهره را افزایش داد', vector(0, 0.05), { lang: 'fa' }),
      item('c', 'something else entirely', null),
    ];
    const merged = buildClusters(partial, { ...OPTIONS, semanticMergeThreshold: 0.86 });
    assert.equal(merged.length, 2);
    assert.ok(merged.some((c) => c.members.length === 2));
  });

  test('a permissive threshold is what collapses everything, and it is ours to set', () => {
    // Real models do not place unrelated text at zero — on the tested corpus
    // an unrelated pair still scores about 0.3 — so the failure mode is
    // reproduced with vectors that overlap the way real ones do.
    const realistic = [
      item('a', 'the central bank raised interest rates', normalise([1, 0, 0.55, 0])),
      item('b', 'بانک مرکزی نرخ بهره را افزایش داد', normalise([0.97, 0.1, 0.55, 0]), { lang: 'fa' }),
      item('c', 'a recipe for chocolate cake', normalise([0, 1, 0.55, 0])),
    ];

    // At the tuned default the cake stays out.
    const safe = buildClusters(realistic, { ...OPTIONS, semanticMergeThreshold: 0.86 });
    assert.equal(safe.length, 2, 'the default must not merge unrelated subjects');

    // Lowered far enough, everything becomes one topic. This is the collapse
    // the default exists to prevent, and it is why the threshold was tuned on
    // real data rather than guessed.
    const collapsed = buildClusters(realistic, { ...OPTIONS, semanticMergeThreshold: 0.2 });
    assert.equal(collapsed.length, 1);
  });
});
