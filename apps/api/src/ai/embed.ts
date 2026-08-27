/**
 * Sentence embeddings, entirely optional.
 *
 * The lexical clustering groups items that share words. That is most of the
 * job and it costs nothing, but it cannot see two things it has no words in
 * common with — which is exactly the case for the same story reported in
 * Persian and in English. For a user who publishes in Persian about topics the
 * English-speaking internet is also carrying, that gap is the whole point.
 *
 * So this adds a second, semantic view. Three constraints shape it:
 *
 *   - **Never required.** With `EMBED_MODEL` empty nothing here runs, no table
 *     row is written, and clustering behaves exactly as it did before. This is
 *     the same promise every other credential in the system makes.
 *   - **Never destructive.** Embeddings only ever *merge* clusters the lexical
 *     pass already built. They cannot split one, so the worst a bad model can
 *     do is join things that should have stayed apart — visible, and undone by
 *     clearing one setting.
 *   - **Never a hard dependency at runtime.** If Ollama is stopped halfway
 *     through, the items already embedded are used and the rest are skipped
 *     with one warning. A local model going away must not fail an analyse run.
 */
import { config } from '../config.ts';
import { createLogger, errFields } from '../logger.ts';
import { request } from '../net/fetcher.ts';

const log = createLogger('embed');

export function isEmbeddingEnabled(): boolean {
  return config.embed.model !== '';
}

/** The host is allowed explicitly rather than by switching the SSRF guard off. */
function allowance(): string[] {
  try {
    return [new URL(config.embed.baseUrl).hostname];
  } catch {
    return [];
  }
}

/**
 * L2 normalisation, done once at write time.
 *
 * Every later comparison is then a plain dot product. With a few thousand
 * clusters compared pairwise that saves a square root and a division per pair,
 * which is the difference between the merge pass being noticeable and not.
 */
export function normalise(values: readonly number[]): Float32Array {
  let sum = 0;
  for (const v of values) sum += v * v;
  const norm = Math.sqrt(sum);
  const out = new Float32Array(values.length);
  // A zero vector cannot be normalised; leaving it zero makes it similar to
  // nothing, which is the correct behaviour for a text the model had nothing
  // to say about.
  if (norm === 0) return out;
  for (let i = 0; i < values.length; i++) out[i] = (values[i] ?? 0) / norm;
  return out;
}

/** Cosine similarity of two already-normalised vectors. */
export function similarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] as number) * (b[i] as number);
  return sum;
}

export function toBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function fromBlob(blob: Uint8Array): Float32Array {
  // Copied rather than viewed: SQLite reuses its own buffers, and a view onto
  // one would change under us on the next read.
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}

interface EmbedResponse {
  embeddings?: number[][];
}

/**
 * Embeds one batch.
 *
 * Returns null for the whole batch on failure rather than throwing: the caller
 * is in the middle of an analyse run that must finish either way, and a
 * partially embedded corpus still clusters correctly — it just merges less.
 */
export async function embedTexts(texts: readonly string[]): Promise<Float32Array[] | null> {
  if (texts.length === 0) return [];
  const base = config.embed.baseUrl.replace(/\/+$/, '');

  try {
    const response = await request(`${base}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.embed.model, input: texts }),
      context: 'embed',
      timeoutMs: config.embed.timeoutMs,
      retries: 1,
      guard: { allowHosts: allowance() },
    });

    const parsed = JSON.parse(response.body) as EmbedResponse;
    const vectors = parsed.embeddings;
    if (!Array.isArray(vectors) || vectors.length !== texts.length) {
      log.warn('embedding response did not match the batch', {
        expected: texts.length,
        got: Array.isArray(vectors) ? vectors.length : 0,
      });
      return null;
    }
    return vectors.map((v) => normalise(v));
  } catch (e) {
    log.warn('embedding failed', { ...errFields(e) });
    return null;
  }
}

export interface EmbedResult {
  readonly vectors: Map<string, Float32Array>;
  readonly embedded: number;
  readonly failed: number;
}

/**
 * Embeds texts that have no vector yet, in batches.
 *
 * Stops after the first batch failure. One failure almost always means the
 * server is down or the model is gone, and hammering it with another fifty
 * batches would turn a warning into a two-minute stall on every run.
 */
export async function embedMissing(
  pending: ReadonlyMap<string, string>,
): Promise<EmbedResult> {
  const vectors = new Map<string, Float32Array>();
  if (!isEmbeddingEnabled() || pending.size === 0) {
    return { vectors, embedded: 0, failed: 0 };
  }

  const entries = [...pending];
  const size = config.embed.batchSize;
  let failed = 0;

  for (let i = 0; i < entries.length; i += size) {
    const batch = entries.slice(i, i + size);
    const result = await embedTexts(batch.map(([, text]) => text));
    if (result === null) {
      failed = entries.length - i;
      log.warn('stopping early; the rest will be embedded on the next run', { remaining: failed });
      break;
    }
    for (let j = 0; j < batch.length; j++) {
      const id = batch[j]?.[0];
      const vector = result[j];
      if (id !== undefined && vector !== undefined) vectors.set(id, vector);
    }
  }

  return { vectors, embedded: vectors.size, failed };
}
