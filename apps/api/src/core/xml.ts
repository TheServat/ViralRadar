/**
 * A small, tolerant RSS/Atom reader.
 *
 * Feeds in the wild are not well-formed XML often enough to justify a strict
 * parser, and pulling in a dependency for six known feed shapes is not worth
 * it. This handles what feeds actually contain: CDATA, entities, namespaced
 * tags and attributes.
 */

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  '#34': '"',
};

export function decodeEntities(input: string): string {
  // Twice on purpose: feeds that double-encode send `&amp;quot;` where they
  // mean a quotation mark, and the leftover "quot" ends up in cluster labels.
  // The result is only ever rendered through an escaping layer, never as HTML.
  return decodeOnce(decodeOnce(input));
}

function decodeOnce(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, name: string) => {
    const direct = ENTITIES[name];
    if (direct !== undefined) return direct;
    if (name.startsWith('#x') || name.startsWith('#X')) {
      const code = Number.parseInt(name.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (name.startsWith('#')) {
      const code = Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return match;
  });
}

function unwrap(raw: string): string {
  const cdata = raw.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  const text = cdata !== null ? (cdata[1] as string) : decodeEntities(raw);
  return text.replace(/\s+/g, ' ').trim();
}

/** All inner texts of `<name>` (namespace-insensitive) inside `xml`. */
export function tagTexts(xml: string, name: string): string[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<(?:[\\w-]+:)?${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${escaped}>`, 'gi');
  return [...xml.matchAll(re)].map((m) => unwrap(m[1] as string));
}

export function tagText(xml: string, name: string): string | null {
  return tagTexts(xml, name)[0] ?? null;
}

/** Value of an attribute on the first `<name ...>` tag. */
export function tagAttr(xml: string, name: string, attr: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<(?:[\\w-]+:)?${escaped}\\s[^>]*${attr}="([^"]*)"`, 'i');
  const m = xml.match(re);
  return m === null ? null : decodeEntities(m[1] as string);
}

/** Raw inner XML of every `<name>` block, so nested tags survive. */
export function blocks(xml: string, name: string): string[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<(?:[\\w-]+:)?${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${escaped}>`, 'gi');
  return [...xml.matchAll(re)].map((m) => m[1] as string);
}

export interface FeedItem {
  readonly title: string;
  readonly link: string | null;
  readonly description: string | null;
  /** Epoch seconds, or null when the feed omits or mangles the date. */
  readonly publishedAt: number | null;
  readonly guid: string | null;
  readonly author: string | null;
  readonly thumbnail: string | null;
  readonly categories: readonly string[];
  /** The item's raw XML, for source-specific extras like ht:approx_traffic. */
  readonly raw: string;
}

export function parseDate(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function linkOf(block: string): string | null {
  const text = tagText(block, 'link');
  if (text !== null && text.startsWith('http')) return text;
  // Atom puts the URL in an attribute instead of the element body.
  const href = tagAttr(block, 'link', 'href');
  return href !== null && href.startsWith('http') ? href : null;
}

function thumbnailOf(block: string): string | null {
  return (
    tagAttr(block, 'thumbnail', 'url') ??
    tagAttr(block, 'content', 'url') ??
    tagText(block, 'picture') ??
    null
  );
}

/** Parses both RSS `<item>` and Atom `<entry>` documents. */
export function parseFeed(xml: string): FeedItem[] {
  const raws = [...blocks(xml, 'item'), ...blocks(xml, 'entry')];
  const items: FeedItem[] = [];

  for (const raw of raws) {
    const title = tagText(raw, 'title');
    if (title === null || title.length === 0) continue;
    items.push({
      title,
      link: linkOf(raw),
      description: tagText(raw, 'description') ?? tagText(raw, 'summary'),
      publishedAt:
        parseDate(tagText(raw, 'pubDate')) ??
        parseDate(tagText(raw, 'published')) ??
        parseDate(tagText(raw, 'updated')) ??
        parseDate(tagText(raw, 'date')),
      guid: tagText(raw, 'guid') ?? tagText(raw, 'id'),
      author: tagText(raw, 'creator') ?? tagText(raw, 'name') ?? tagText(raw, 'author'),
      thumbnail: thumbnailOf(raw),
      categories: tagTexts(raw, 'category'),
      raw,
    });
  }
  return items;
}

export function feedTitle(xml: string): string | null {
  const head = xml.slice(0, 4000);
  return tagText(head, 'title');
}
