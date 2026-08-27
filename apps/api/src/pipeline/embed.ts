/**
 * The embedding job.
 *
 * Deliberately its own job rather than a step inside `analyze`. Analysis is
 * synchronous, reproducible from the database, and must finish quickly; an
 * HTTP call to a local model is none of those things. Keeping them apart means
 * a stopped Ollama can never slow down or fail an analyse run — the worst that
 * happens is that some items have no vector yet, and clustering falls back to
 * exactly what it did before.
 *
 * So this job writes vectors, and `analyze` only ever reads the ones already
 * there.
 */
import { config } from '../config.ts';
import { createLogger } from '../logger.ts';
import * as repo from '../db/repo.ts';
import { nowSec } from '../core/types.ts';
import { embedMissing, isEmbeddingEnabled, toBlob } from '../ai/embed.ts';
import { verifyEmbedding } from '../ai/probe.ts';

const log = createLogger('embed');

/**
 * Whether the configured model has proved it can tell related text from
 * unrelated text. Checked once per process: it costs a model call, and the
 * answer cannot change while the process is running.
 *
 * Cached as a promise so that concurrent callers share one check rather than
 * racing to make three.
 */
let verified: Promise<boolean> | null = null;

export function resetEmbeddingVerification(): void {
  verified = null;
}

export async function embeddingUsable(): Promise<boolean> {
  if (!isEmbeddingEnabled()) return false;
  verified ??= verifyEmbedding(config.languages).then((verdict) => {
    if (verdict.ok) {
      log.info('embedding model verified', {
        model: verdict.model,
        dims: verdict.dims,
        languages: verdict.languages.map((l) => `${l.lang}:${l.separation}`).join(' '),
      });
    } else {
      // Refusing is the point. A model that cannot separate related from
      // unrelated text in the user's language would merge every topic in that
      // language into one, and it would do it while looking perfectly healthy.
      log.warn('embedding disabled: the model did not pass its own check', {
        model: verdict.model,
        error: verdict.error,
      });
    }
    return verdict.ok;
  });
  return verified;
}

export interface EmbedRunResult {
  readonly considered: number;
  readonly embedded: number;
  readonly remaining: number;
  readonly skipped: boolean;
}

/**
 * Embeds items that have no vector for the current model.
 *
 * Newest first, and capped per run: a database with thousands of items would
 * otherwise spend an hour on its first pass. The rest are picked up on the
 * next run, so coverage climbs steadily instead of arriving in one stall.
 */
export async function runEmbedding(now = nowSec()): Promise<EmbedRunResult> {
  const model = config.embed.model;
  if (!isEmbeddingEnabled() || config.embed.maxPerRun === 0) {
    return { considered: 0, embedded: 0, remaining: 0, skipped: true };
  }
  if (!(await embeddingUsable())) {
    return { considered: 0, embedded: 0, remaining: 0, skipped: true };
  }

  // Vectors from another model cannot be compared with these, so they are
  // cleared once rather than left to confuse a later similarity.
  const stale = repo.deleteEmbeddingsExcept(model);
  if (stale > 0) log.info('cleared vectors from a previous model', { removed: stale });

  const candidates = repo.contentNeedingEmbedding(model, config.embed.maxPerRun);
  if (candidates.length === 0) return { considered: 0, embedded: 0, remaining: 0, skipped: false };

  const pending = new Map<string, string>();
  for (const row of candidates) {
    // Title plus a little body: the same text the lexical clustering reads, so
    // the two views are describing the same thing.
    const text = `${row.title} ${row.body?.slice(0, 400) ?? ''}`.trim();
    if (text !== '') pending.set(row.id, text);
  }

  const { vectors, embedded, failed } = await embedMissing(pending);

  const blobs = new Map<string, { dims: number; blob: Uint8Array }>();
  for (const [id, vector] of vectors) {
    blobs.set(id, { dims: vector.length, blob: toBlob(vector) });
  }
  repo.saveEmbeddings(model, blobs, now);

  const coverage = repo.embeddingCoverage(model);
  log.info('embedded', {
    model,
    embedded,
    failed,
    coverage: `${coverage.embedded}/${coverage.total}`,
  });

  return {
    considered: pending.size,
    embedded,
    remaining: Math.max(0, coverage.total - coverage.embedded),
    skipped: false,
  };
}
