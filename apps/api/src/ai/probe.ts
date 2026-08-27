/**
 * Proving an embedding model is usable before trusting it.
 *
 * This exists because of a real failure. `paraphrase-multilingual` is
 * advertised as multilingual and behaves perfectly in English — two ways of
 * saying the dollar rose score 0.89, and a cake recipe scores -0.02. In
 * Persian the same model scores *unrelated* sentences at 0.991, because it has
 * no useful representation of the script at all and returns almost the same
 * vector for anything written in it.
 *
 * Nothing about that is visible from the outside. The model loads, answers
 * quickly, returns well-formed vectors of the right dimension, and would have
 * merged every Persian topic in the database into a single cluster — a
 * catastrophic result produced by a component that looks healthy.
 *
 * So a model does not get used on the strength of its name. It has to
 * demonstrate, in each language the user actually publishes in, that it puts
 * related sentences closer together than unrelated ones.
 */
import { createLogger } from '../logger.ts';
import { embedTexts, isEmbeddingEnabled, similarity } from './embed.ts';

const log = createLogger('embed');

/**
 * Three sentences per language: two that mean nearly the same thing, and one
 * about something else entirely. Everyday wording on purpose — the corpus is
 * news headlines and video titles, not literary text.
 */
const PROBES: Readonly<Record<string, readonly [string, string, string]>> = {
  en: [
    'The price of the dollar rose sharply today',
    'The dollar exchange rate went up a lot today',
    'How to bake a chocolate cake at home',
  ],
  fa: [
    'قیمت دلار امروز به شدت افزایش یافت',
    'نرخ دلار امروز خیلی بالا رفت',
    'طرز تهیه کیک شکلاتی در خانه',
  ],
  ar: [
    'ارتفع سعر الدولار بشدة اليوم',
    'صعد سعر صرف الدولار كثيرا اليوم',
    'طريقة عمل كعكة الشوكولاتة في المنزل',
  ],
  tr: [
    'Dolar fiyatı bugün sert şekilde yükseldi',
    'Dolar kuru bugün çok arttı',
    'Evde çikolatalı kek nasıl yapılır',
  ],
};

/**
 * How far apart "related" and "unrelated" must land for the model to be worth
 * using. A model that scores both at 0.99 has told us nothing, whatever those
 * numbers look like on their own.
 */
const MIN_SEPARATION = 0.15;

export interface LanguageVerdict {
  readonly lang: string;
  /** Similarity of the two sentences that mean the same thing. */
  readonly related: number;
  /** Similarity of the unrelated pair. */
  readonly unrelated: number;
  /** related − unrelated. This, not `related`, is what makes a model usable. */
  readonly separation: number;
  readonly usable: boolean;
}

export interface EmbeddingVerdict {
  readonly ok: boolean;
  readonly model: string;
  readonly dims: number;
  readonly languages: readonly LanguageVerdict[];
  /** Languages that were asked for but have no probe text here. */
  readonly untested: readonly string[];
  readonly error: string | null;
  readonly minSeparation: number;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Checks the model in each requested language.
 *
 * A model is accepted only if every language that could be tested passes. One
 * broken language is enough to ruin clustering for the user who writes in it,
 * and that user is usually the one running this.
 */
export async function verifyEmbedding(languages: readonly string[]): Promise<EmbeddingVerdict> {
  const model = process.env['EMBED_MODEL'] ?? '';
  const empty: EmbeddingVerdict = {
    ok: false,
    model,
    dims: 0,
    languages: [],
    untested: [],
    error: null,
    minSeparation: MIN_SEPARATION,
  };

  if (!isEmbeddingEnabled()) return { ...empty, error: 'no embedding model configured' };

  // English is always checked: it is the lingua franca of the sources even when
  // the user does not publish in it, and a model failing there is broken.
  const wanted = [...new Set(['en', ...languages])];
  const testable = wanted.filter((lang) => PROBES[lang] !== undefined);
  const untested = wanted.filter((lang) => PROBES[lang] === undefined);

  const texts: string[] = [];
  for (const lang of testable) texts.push(...(PROBES[lang] as readonly string[]));

  const vectors = await embedTexts(texts);
  if (vectors === null) {
    return { ...empty, untested, error: 'the model did not answer' };
  }

  const verdicts: LanguageVerdict[] = [];
  for (let i = 0; i < testable.length; i++) {
    const a = vectors[i * 3];
    const b = vectors[i * 3 + 1];
    const c = vectors[i * 3 + 2];
    if (a === undefined || b === undefined || c === undefined) continue;

    const related = similarity(a, b);
    const unrelated = similarity(a, c);
    const separation = related - unrelated;
    verdicts.push({
      lang: testable[i] as string,
      related: round(related),
      unrelated: round(unrelated),
      separation: round(separation),
      usable: separation >= MIN_SEPARATION,
    });
  }

  const ok = verdicts.length > 0 && verdicts.every((v) => v.usable);
  const failed = verdicts.filter((v) => !v.usable).map((v) => v.lang);

  if (!ok && failed.length > 0) {
    log.warn('embedding model rejected', {
      model,
      failed,
      detail: verdicts
        .map((v) => `${v.lang}: related ${v.related} vs unrelated ${v.unrelated}`)
        .join('; '),
    });
  }

  return {
    ok,
    model,
    dims: vectors[0]?.length ?? 0,
    languages: verdicts,
    untested,
    error: ok ? null : `the model cannot tell related from unrelated text in: ${failed.join(', ')}`,
    minSeparation: MIN_SEPARATION,
  };
}
