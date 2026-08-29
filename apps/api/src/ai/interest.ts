/**
 * Matching what is trending against what you actually make.
 *
 * Every other filter in this system is categorical — this language, that
 * platform, that country. None of them can express "I make Persian comedy
 * clips", which is the filter a creator actually wants, because subject is not
 * a category the sources supply.
 *
 * The obvious implementation is to ask a model about each item. That is what
 * comparable tools do, and it costs a call per item, per run, for ever. It is
 * also unnecessary here: the clustering already builds a sentence embedding for
 * every item, verified to separate related from unrelated text in the user's own
 * languages. Embedding one description and taking a dot product against vectors
 * that already exist gives the same answer instantly, offline, and free.
 *
 * What this is *not*: a judgement about quality or a promise of relevance. It is
 * a similarity between two pieces of text. Measured on a real corpus it ranks
 * sensibly — comedy clips at 0.82 against a comedy description, unrelated
 * foreign news at 0.01 — but the number is a distance, and the interface says so
 * rather than presenting it as a verdict.
 */
import { createHash } from 'node:crypto';
import { config } from '../config.ts';
import { createLogger } from '../logger.ts';
import * as repo from '../db/repo.ts';
import { embedTexts, fromBlob, isEmbeddingEnabled, similarity, toBlob } from './embed.ts';

const log = createLogger('interest');

/**
 * Where the interest vector is cached.
 *
 * Keyed by the text *and* the model: a reworded description means a different
 * vector, and a different model means a vector that cannot be compared with the
 * stored item vectors at all.
 */
const VECTOR_KEY = 'interest_vector';
const STAMP_KEY = 'interest_stamp';

function stamp(): string {
  return createHash('sha256').update(`${config.embed.model}\n${config.interests}`, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Whether the description has changed since the corpus was last scored.
 *
 * A reworded description means every stored relevance is answering a question
 * nobody asked any more, so they are cleared rather than left to filter against
 * a definition that no longer exists.
 */
export function interestsChanged(): boolean {
  return hasInterests() && repo.kvGet(STAMP_KEY) !== stamp();
}

export function hasInterests(): boolean {
  return config.interests.trim() !== '' && isEmbeddingEnabled();
}

let cached: Float32Array | null = null;
let cachedStamp = '';

/**
 * The interest vector, embedded once and kept.
 *
 * Returns null when there is nothing to match against — no description, no
 * model, or the model refused to answer. Every caller treats that as "do not
 * score relevance", never as "nothing is relevant".
 */
export async function interestVector(): Promise<Float32Array | null> {
  if (!hasInterests()) return null;

  const want = stamp();
  if (cached !== null && cachedStamp === want) return cached;

  // Survives a restart, so a description that has not changed is not re-embedded.
  if (repo.kvGet(STAMP_KEY) === want) {
    const stored = repo.kvGetBlob(VECTOR_KEY);
    if (stored !== null) {
      cached = fromBlob(stored);
      cachedStamp = want;
      return cached;
    }
  }

  const result = await embedTexts([config.interests.trim()]);
  const vector = result?.[0];
  if (vector === undefined) {
    log.warn('could not embed the interest description; relevance scoring is off');
    return null;
  }

  repo.kvSetBlob(VECTOR_KEY, toBlob(vector));
  repo.kvSet(STAMP_KEY, want);
  cached = vector;
  cachedStamp = want;
  log.info('interests embedded', { dims: vector.length, chars: config.interests.trim().length });
  return vector;
}

/**
 * Scores stored items against the interest vector.
 *
 * Items with no vector of their own are skipped rather than scored zero — the
 * embedding job has simply not reached them yet, and calling that "irrelevant"
 * would hide new items behind a filter they were never measured against.
 */
export async function scoreRelevance(ids: readonly string[]): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  const interest = await interestVector();
  if (interest === null || ids.length === 0) return scores;

  const vectors = repo.embeddingsFor(ids, config.embed.model);
  for (const [id, blob] of vectors) {
    const value = similarity(interest, fromBlob(blob));
    if (Number.isFinite(value)) scores.set(id, value);
  }
  return scores;
}
