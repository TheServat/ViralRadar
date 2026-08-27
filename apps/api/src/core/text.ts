/**
 * Text processing: normalisation, tokens, keywords, near-duplicate hashing and
 * language identification.
 *
 * Deliberately classical - no model, no network, no LLM. Language detection in
 * particular must be cheap and deterministic because it runs on every item.
 */
import { clamp } from './stats.ts';

// ── Normalisation ──────────────────────────────────────────────────────────

const ZERO_WIDTH = /[​-‏‪-‮﻿]/g;
/** Arabic/Persian glyph variants that must fold together before comparison. */
const ARABIC_FOLD: readonly (readonly [RegExp, string])[] = [
  [/[يیى]/g, 'ی'], // ya variants -> Persian ye
  [/[ك]/g, 'ک'], // Arabic kaf -> Persian ke
  [/[أإآٱ]/g, 'ا'], // alef variants
  [/[ة]/g, 'ه'], // ta marbuta -> he
  [/[ً-ْٰ]/g, ''], // harakat
];

export function normaliseText(input: string): string {
  let s = input.normalize('NFKC').replace(ZERO_WIDTH, ' ');
  for (const [re, to] of ARABIC_FOLD) s = s.replace(re, to);
  return s
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)) // Arabic digits
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0)) // Persian digits
    .replace(/[^\p{L}\p{N}#@_\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Stopwords ──────────────────────────────────────────────────────────────

const STOPWORDS_BY_LANG: Readonly<Record<string, readonly string[]>> = {
  en: ['the','a','an','and','or','but','if','of','to','in','on','for','with','as','at','by','from','is','are','was','were','be','been','being','it','its','this','that','these','those','i','you','he','she','we','they','my','your','his','her','our','their','not','no','so','than','then','there','here','what','which','who','whom','how','when','where','why','all','any','can','will','just','do','does','did','have','has','had','about','after','before','over','under','up','down','out','into','new','more','most','very','also','get','got','one','two','like','make','made','best','top','via','vs','you re','dont','quot','amp','nbsp','apos','href','http','https','www','com'],
  fa: ['و','در','به','از','که','این','را','با','است','برای','آن','یک','های','شد','می','بر','تا','کرد','بود','هم','هر','یا','اما','ما','شما','او','من','ولی','چه','چون','اگر','باید','شود','کند','دارد','هست','نیست','روی','بین','همه','دیگر','خیلی','بسیار','فقط','دو','سه','بعد','قبل','وقتی'],
  ar: ['في','من','على','إلى','عن','مع','هذا','هذه','ذلك','التي','الذي','أن','إن','كان','كانت','لا','ما','هو','هي','هم','قد','كل','بعد','قبل','بين','عند','لكن','أو','ثم','حتى','لم','لن'],
  es: ['el','la','los','las','un','una','de','del','y','o','que','en','con','por','para','se','su','al','lo','como','más','pero','sus','le','ya','o','este','esta','son','fue','ser','es','no','muy'],
  pt: ['o','a','os','as','um','uma','de','do','da','e','ou','que','em','com','por','para','se','no','na','mais','como','mas','foi','ser','é','não','muito'],
  fr: ['le','la','les','un','une','de','des','du','et','ou','que','qui','en','dans','avec','pour','par','sur','au','aux','ce','cette','est','sont','pas','ne','plus','comme','mais'],
  de: ['der','die','das','ein','eine','und','oder','von','zu','mit','für','auf','im','in','den','dem','des','ist','sind','war','nicht','auch','als','aber','wie','man','sich','bei','nach'],
  it: ['il','lo','la','i','gli','le','un','una','di','del','della','e','o','che','in','con','per','su','da','non','come','più','ma','sono','è'],
  tr: ['ve','ile','bir','bu','da','de','için','ama','çok','daha','en','gibi','ki','ne','mi','ya','olarak','var','yok','olan','sonra','önce'],
  ru: ['и','в','не','на','я','что','он','с','как','а','то','все','она','так','его','но','да','ты','к','у','же','вы','за','бы','по','только','ее','мне','было','вот','от','меня'],
  id: ['yang','dan','di','ke','dari','untuk','dengan','ini','itu','pada','adalah','tidak','akan','sudah','juga','bisa','ada','saya','kami','mereka'],
  hi: ['के','का','की','है','में','से','और','को','पर','यह','कि','हैं','था','ने','एक','भी','लिए','कर','हो','नहीं'],
  nl: ['de','het','een','en','van','in','op','voor','met','is','zijn','dat','die','niet','aan','als','er','maar','ook','naar'],
  pl: ['i','w','na','z','do','nie','to','że','jest','się','o','jak','po','za','od','ale','czy','tak','ten','przez'],
  ja: ['の','に','は','を','た','が','で','て','と','し','れ','さ','ある','いる','も','する','から','な','こと','として'],
};

const ALL_STOPWORDS: ReadonlySet<string> = new Set(Object.values(STOPWORDS_BY_LANG).flat());

export function isStopword(token: string): boolean {
  return ALL_STOPWORDS.has(token);
}

// ── Tokenisation ───────────────────────────────────────────────────────────

export function tokenize(text: string): string[] {
  const n = normaliseText(text);
  if (n.length === 0) return [];
  // CJK has no spaces: fall back to character bigrams for those runs.
  const out: string[] = [];
  for (const part of n.split(' ')) {
    if (part.length === 0) continue;
    if (/^[぀-ヿ一-鿿]+$/.test(part)) {
      if (part.length === 1) out.push(part);
      for (let i = 0; i + 1 < part.length; i++) out.push(part.slice(i, i + 2));
    } else {
      out.push(part);
    }
  }
  return out;
}

/** Content-bearing tokens: no stopwords, no 1-character noise, no bare numbers. */
export function contentTokens(text: string): string[] {
  return tokenize(text).filter(
    (t) => t.length > 1 && !isStopword(t) && !/^\d+$/.test(t) && !t.startsWith('@'),
  );
}

/**
 * A deliberately small suffix stripper for Latin-script words.
 *
 * Headlines about one event almost never agree on morphology - "erupts",
 * "eruption", "evacuated", "evacuations" - and without folding those together
 * the clustering sees four unrelated stories. This is not a linguistically
 * correct stemmer and does not try to be; it only has to make variants of the
 * same word collide. Non-Latin scripts are left untouched, where suffix
 * stripping would do more harm than good.
 */
export function stem(word: string): string {
  if (!/^[a-z]{4,}$/.test(word)) return word;
  let w = word;
  if (w.endsWith('ies') && w.length > 4) w = `${w.slice(0, -3)}i`;
  else if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) w = w.slice(0, -1);
  if (w.endsWith('ing') && w.length > 5) w = w.slice(0, -3);
  else if (w.endsWith('ed') && w.length > 4) w = w.slice(0, -2);
  if (w.endsWith('ion') && w.length > 5) w = w.slice(0, -3);
  if (w.endsWith('y') && w.length > 3) w = `${w.slice(0, -1)}i`;
  if (w.endsWith('e') && w.length > 4) w = w.slice(0, -1);
  return w;
}

export function stemTokens(tokens: readonly string[]): string[] {
  return tokens.map(stem);
}

export function ngrams(tokens: readonly string[], n: number): string[] {
  if (n <= 1) return [...tokens];
  const out: string[] = [];
  for (let i = 0; i + n <= tokens.length; i++) out.push(tokens.slice(i, i + n).join(' '));
  return out;
}

// ── Entities ───────────────────────────────────────────────────────────────

export interface Entities {
  readonly hashtags: readonly string[];
  readonly mentions: readonly string[];
  readonly urls: readonly string[];
  readonly domains: readonly string[];
  /** Capitalised multi-word runs: crude but effective proper-noun candidates. */
  readonly properNouns: readonly string[];
}

const URL_RE = /https?:\/\/[^\s<>"')]+/g;
const HASHTAG_RE = /#([\p{L}\p{N}_]{2,50})/gu;
const MENTION_RE = /@([A-Za-z0-9_.]{2,40})/g;
const PROPER_RE = /\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){0,3})\b/g;

function uniq(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function extractEntities(text: string): Entities {
  const urls = uniq(text.match(URL_RE) ?? []);
  const domains = uniq(
    urls
      .map((u) => {
        try {
          return new URL(u).hostname.replace(/^www\./, '').toLowerCase();
        } catch {
          return '';
        }
      })
      .filter((d) => d.length > 0),
  );
  const hashtags = uniq([...text.matchAll(HASHTAG_RE)].map((m) => (m[1] as string).toLowerCase()));
  const mentions = uniq([...text.matchAll(MENTION_RE)].map((m) => (m[1] as string).toLowerCase()));
  const properNouns = uniq(
    [...text.matchAll(PROPER_RE)]
      .map((m) => (m[1] as string).trim())
      .filter((p) => !isStopword(p.toLowerCase())),
  ).slice(0, 12);
  return { hashtags, mentions, urls, domains, properNouns };
}

// ── Keyword extraction (TF-IDF over the current window) ────────────────────

export interface KeywordScore {
  readonly term: string;
  readonly score: number;
  readonly df: number;
}

/**
 * Builds inverse document frequencies over the documents currently in play.
 * A word is interesting when it is frequent *here* and rare *elsewhere* - which
 * is exactly what "a trending topic" means, without needing to know any topics.
 */
export class TfIdf {
  private readonly df = new Map<string, number>();
  private docCount = 0;

  /**
   * Bigrams are registered alongside unigrams. Without that they would have a
   * document frequency of zero and therefore always look maximally rare, which
   * makes every common two-word phrase masquerade as the key term.
   */
  add(tokens: readonly string[]): void {
    this.docCount++;
    for (const t of new Set([...tokens, ...ngrams(tokens, 2)])) {
      this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
  }

  idf(term: string): number {
    const d = this.df.get(term) ?? 0;
    return Math.log((this.docCount + 1) / (d + 1)) + 1;
  }

  documentFrequency(term: string): number {
    return this.df.get(term) ?? 0;
  }

  get documents(): number {
    return this.docCount;
  }

  /** Top terms of one document, unigrams and bigrams, ranked by tf-idf. */
  top(tokens: readonly string[], limit = 8): KeywordScore[] {
    const counts = new Map<string, number>();
    for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const bg of ngrams(tokens, 2)) counts.set(bg, (counts.get(bg) ?? 0) + 1.5);

    const total = tokens.length || 1;
    const scored: KeywordScore[] = [];
    for (const [term, count] of counts) {
      const tf = count / total;
      scored.push({ term, score: tf * this.idf(term), df: this.documentFrequency(term) });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

// ── Similarity ─────────────────────────────────────────────────────────────

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const v of small) if (large.has(v)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Cosine similarity over sparse tf-idf weighted vectors. */
export function cosine(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [, w] of a) na += w * w;
  for (const [k, w] of b) {
    nb += w * w;
    const av = a.get(k);
    if (av !== undefined) dot += av * w;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ── SimHash (near-duplicate detection) ─────────────────────────────────────

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

export function hash64(input: string): bigint {
  let h = FNV_OFFSET;
  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i));
    h = (h * FNV_PRIME) & MASK64;
  }
  return h;
}

/**
 * 64-bit SimHash. Two texts that differ by a few words land within a few bits
 * of each other, which catches reposts and retitled reuploads that an exact
 * hash would miss entirely.
 */
export function simhash(text: string): string {
  const tokens = contentTokens(text);
  if (tokens.length === 0) return '0000000000000000';
  const weights = new Array<number>(64).fill(0);
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);

  for (const [token, count] of counts) {
    const h = hash64(token);
    for (let bit = 0; bit < 64; bit++) {
      const set = (h >> BigInt(bit)) & 1n;
      weights[bit] = (weights[bit] as number) + (set === 1n ? count : -count);
    }
  }
  let out = 0n;
  for (let bit = 0; bit < 64; bit++) {
    if ((weights[bit] as number) > 0) out |= 1n << BigInt(bit);
  }
  return out.toString(16).padStart(16, '0');
}

export function hammingDistance(aHex: string, bHex: string): number {
  let x = (BigInt(`0x${aHex}`) ^ BigInt(`0x${bHex}`)) & MASK64;
  let d = 0;
  while (x > 0n) {
    d += Number(x & 1n);
    x >>= 1n;
  }
  return d;
}

/** Empirically, <= 6 differing bits out of 64 means "the same story". */
export function isNearDuplicate(aHex: string, bHex: string, maxDistance = 6): boolean {
  return hammingDistance(aHex, bHex) <= maxDistance;
}

// ── Language identification ────────────────────────────────────────────────

export interface LanguageGuess {
  readonly code: string | null;
  readonly confidence: number;
}

const SCRIPT_RANGES: readonly (readonly [RegExp, string])[] = [
  [/[؀-ۿݐ-ݿ]/u, 'arabic'],
  [/[Ѐ-ӿ]/u, 'cyrillic'],
  [/[一-鿿]/u, 'han'],
  [/[぀-ゟ゠-ヿ]/u, 'kana'],
  [/[가-힯]/u, 'hangul'],
  [/[ऀ-ॿ]/u, 'devanagari'],
  [/[֐-׿]/u, 'hebrew'],
  [/[Ͱ-Ͽ]/u, 'greek'],
  [/[฀-๿]/u, 'thai'],
  [/[a-z]/i, 'latin'],
];

const LATIN_CANDIDATES = ['en', 'es', 'pt', 'fr', 'de', 'it', 'tr', 'id', 'nl', 'pl'] as const;
/** Characters that are strong single-language tells inside a shared script. */
const PERSIAN_MARKERS = /[پچژگکی]/u; // پ چ ژ گ ک ی

/**
 * Script first, then stopword profile inside the script. Returns `null` with a
 * low confidence rather than pretending: an unknown language is stored as NULL.
 */
export function detectLanguage(text: string): LanguageGuess {
  const sample = text.slice(0, 600);
  if (sample.trim().length < 8) return { code: null, confidence: 0 };

  const scriptCounts = new Map<string, number>();
  for (const ch of sample) {
    for (const [re, name] of SCRIPT_RANGES) {
      if (re.test(ch)) {
        scriptCounts.set(name, (scriptCounts.get(name) ?? 0) + 1);
        break;
      }
    }
  }
  const total = [...scriptCounts.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return { code: null, confidence: 0 };

  const [script, count] = [...scriptCounts.entries()].sort((a, b) => b[1] - a[1])[0] as [string, number];
  const scriptShare = count / total;

  switch (script) {
    case 'cyrillic':
      return { code: 'ru', confidence: clamp(scriptShare, 0, 0.85) };
    case 'han':
      return { code: 'zh', confidence: clamp(scriptShare, 0, 0.85) };
    case 'kana':
      return { code: 'ja', confidence: clamp(scriptShare, 0, 0.9) };
    case 'hangul':
      return { code: 'ko', confidence: clamp(scriptShare, 0, 0.9) };
    case 'devanagari':
      return { code: 'hi', confidence: clamp(scriptShare, 0, 0.8) };
    case 'hebrew':
      return { code: 'he', confidence: clamp(scriptShare, 0, 0.85) };
    case 'greek':
      return { code: 'el', confidence: clamp(scriptShare, 0, 0.85) };
    case 'thai':
      return { code: 'th', confidence: clamp(scriptShare, 0, 0.9) };
    case 'arabic': {
      const faHits = countStopwordHits(sample, 'fa');
      const arHits = countStopwordHits(sample, 'ar');
      if (PERSIAN_MARKERS.test(sample) || faHits > arHits) {
        return { code: 'fa', confidence: clamp(0.55 + 0.05 * faHits, 0, 0.9) };
      }
      return { code: 'ar', confidence: clamp(0.5 + 0.05 * arHits, 0, 0.85) };
    }
    case 'latin':
      return detectLatin(sample, scriptShare);
    default:
      return { code: null, confidence: 0 };
  }
}

function countStopwordHits(text: string, lang: string): number {
  const words = new Set(tokenize(text));
  const list = STOPWORDS_BY_LANG[lang] ?? [];
  let hits = 0;
  for (const w of list) if (words.has(w)) hits++;
  return hits;
}

/**
 * Function words belonging to exactly one candidate language.
 *
 * Shared words are almost useless for telling Latin languages apart: "in" is
 * English, Dutch and German, and a six-word headline may contain nothing else.
 * Counting shared hits equally is what made "FDA approves first in class
 * targeted therapy" come out as Dutch.
 */
const EXCLUSIVE_STOPWORDS: ReadonlyMap<string, ReadonlySet<string>> = (() => {
  const owners = new Map<string, string[]>();
  for (const lang of LATIN_CANDIDATES) {
    for (const word of STOPWORDS_BY_LANG[lang] ?? []) {
      const list = owners.get(word) ?? [];
      list.push(lang);
      owners.set(word, list);
    }
  }
  const exclusive = new Map<string, Set<string>>();
  for (const lang of LATIN_CANDIDATES) exclusive.set(lang, new Set());
  for (const [word, langs] of owners) {
    if (langs.length === 1) exclusive.get(langs[0] as string)?.add(word);
  }
  return exclusive;
})();

function detectLatin(text: string, scriptShare: number): LanguageGuess {
  const words = tokenize(text);
  if (words.length < 3) return { code: null, confidence: 0 };
  const set = new Set(words);

  const scores = LATIN_CANDIDATES.map((lang) => {
    const exclusive = EXCLUSIVE_STOPWORDS.get(lang) ?? new Set<string>();
    let unique = 0;
    let shared = 0;
    for (const w of STOPWORDS_BY_LANG[lang] ?? []) {
      if (!set.has(w)) continue;
      if (exclusive.has(w)) unique++;
      else shared++;
    }
    // A word only this language uses is worth far more than one four
    // languages share, and raw counts are used: normalising by list size
    // punished whichever language had the most thorough word list.
    return { lang, score: unique + 0.2 * shared, unique };
  }).sort((a, b) => b.score - a.score);

  const best = scores[0];
  const second = scores[1];

  // Nothing distinctive matched. On these sources Latin script with no
  // recognisable function words is overwhelmingly English - said quietly,
  // with a confidence that admits it is a default rather than a finding.
  if (best === undefined || best.unique === 0) {
    return { code: 'en', confidence: 0.3 * scriptShare };
  }

  const margin = second === undefined || best.score === 0 ? 1 : (best.score - second.score) / best.score;
  const evidence = clamp(best.unique / 3, 0.3, 1);
  return { code: best.lang, confidence: clamp(0.4 + 0.5 * margin, 0.3, 0.95) * evidence * scriptShare };
}

// ── Misc helpers ───────────────────────────────────────────────────────────

/**
 * Human-readable label built from the strongest keywords of a cluster.
 *
 * Overlapping candidates are dropped. Top keywords from one story are usually
 * sliding bigrams of the same sentence - "air condition", "condition luxury",
 * "luxury necessity" - and stringing them together produces a label that
 * repeats every word twice and names nothing.
 */
export function labelFromKeywords(keywords: readonly string[], max = 3): string {
  const used = new Set<string>();
  const picked: string[] = [];

  for (const keyword of keywords) {
    if (keyword.length <= 1) continue;
    const words = keyword.split(' ');
    const fresh = words.every((w) => !used.has(w));
    // Every word is consumed even when the candidate is rejected. Sliding
    // bigrams overlap only their neighbour, so marking just the accepted ones
    // would let the chain through one link at a time.
    for (const w of words) used.add(w);
    if (!fresh) continue;
    picked.push(keyword);
    if (picked.length === max) break;
  }

  if (picked.length === 0) return 'unlabelled';
  return picked.map((k) => k.split(' ').map(capitalise).join(' ')).join(' · ');
}

function capitalise(word: string): string {
  return word.length === 0 ? word : word[0]?.toUpperCase() + word.slice(1);
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
