/**
 * Taking the answer somewhere else.
 *
 * The dashboard is for deciding what to make; a spreadsheet is where people
 * actually plan a week of it. This turns any ranked query — with every filter
 * the interface offers — into a file, so the tool does not become a place data
 * goes to be looked at once and lost.
 *
 * CSV rather than only JSON because the intended destination is Excel, Google
 * Sheets, or Numbers. Which means the CSV has to survive them, and the two
 * things that break it there are worth naming.
 */
import type { RankedRow } from '../db/repo.ts';

/**
 * Columns, in the order a person reads them: what it is, how it is doing, then
 * the numbers behind that. Not every field in the row — an export nobody can
 * scan is no more useful than no export.
 */
const COLUMNS: readonly { key: string; of: (row: RankedRow) => unknown }[] = [
  { key: 'title', of: (r) => r.title },
  { key: 'url', of: (r) => r.url },
  { key: 'source', of: (r) => r.source },
  { key: 'state', of: (r) => r.state },
  { key: 'score', of: (r) => round(r.score) },
  { key: 'confidence', of: (r) => round(r.confidence, 2) },
  { key: 'creator', of: (r) => r.author_name },
  { key: 'creator_url', of: (r) => r.creator_url },
  { key: 'followers', of: (r) => r.author_followers },
  { key: 'language', of: (r) => r.lang },
  { key: 'country', of: (r) => r.country },
  { key: 'type', of: (r) => r.content_type },
  { key: 'primary_metric', of: (r) => r.primary_metric },
  { key: 'primary_value', of: (r) => r.primary_value },
  { key: 'per_hour', of: (r) => round(r.velocity) },
  { key: 'acceleration', of: (r) => round(r.acceleration) },
  { key: 'vs_creator_normal', of: (r) => round(r.creator_anomaly, 2) },
  { key: 'platform_rank', of: (r) => round(percent(r.source_percentile)) },
  { key: 'age_hours', of: (r) => round(r.age_hours) },
  { key: 'observations', of: (r) => r.observations },
  { key: 'views', of: (r) => r.views },
  { key: 'likes', of: (r) => r.likes },
  { key: 'comments', of: (r) => r.comments },
  { key: 'published_at', of: (r) => iso(r.published_at) },
  { key: 'first_seen_at', of: (r) => iso(r.first_seen_at) },
];

function round(value: number | null | undefined, places = 1): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function percent(value: number | null): number | null {
  return value === null ? null : value * 100;
}

/** ISO rather than epoch seconds: a spreadsheet can read one of those. */
function iso(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '';
  return new Date(seconds * 1000).toISOString();
}

/**
 * One CSV field.
 *
 * Two guards, both for real spreadsheet behaviour rather than for the CSV spec:
 *
 * A leading `=`, `+`, `-` or `@` makes Excel and Sheets treat the cell as a
 * formula. Titles here are written by strangers, so `=cmd|...` in a video title
 * would be a formula injection in the user's spreadsheet. Prefixing a single
 * quote makes it text; the quote is not displayed.
 *
 * Newlines inside a quoted field are legal CSV and handled correctly by every
 * real parser, so they are kept rather than stripped — losing content to be
 * safe would be its own small dishonesty.
 */
function field(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  const risky = /^[=+\-@\t\r]/.test(text);
  const escaped = (risky ? `'${text}` : text).replace(/"/g, '""');
  return /[",\n\r]/.test(escaped) || risky ? `"${escaped}"` : escaped;
}

export function toCsv(rows: readonly RankedRow[]): string {
  const lines = [COLUMNS.map((c) => c.key).join(',')];
  for (const row of rows) lines.push(COLUMNS.map((c) => field(c.of(row))).join(','));
  // A BOM, so Excel on Windows opens UTF-8 as UTF-8. Without it Persian and
  // Arabic titles arrive as mojibake, which makes the whole export worthless
  // for exactly the user this is built for.
  return `﻿${lines.join('\r\n')}\r\n`;
}

export function toJson(rows: readonly RankedRow[]): string {
  return JSON.stringify(
    rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const column of COLUMNS) out[column.key] = column.of(row);
      return out;
    }),
    null,
    2,
  );
}

/** A filename that sorts chronologically and says what it holds. */
/**
 * The name the browser saves the download as.
 *
 * `kind` comes from a query parameter and used to reach the header verbatim.
 * That is not a truncation problem, it is parameter injection: a quote closes
 * `filename="`, and everything after it is read by the browser as further
 * parameters. A crafted local link could add its own `filename*=UTF-8''...`
 * and choose both the saved name and its **extension**, so a page could offer
 * "your export" and have it land as an `.html` file. A newline was worse in a
 * different way - it threw inside `writeHead`, after the handler had returned,
 * so a request that looked valid produced a generic 500.
 *
 * Reduced to the characters a name is made of. Anything else is dropped rather
 * than escaped, because there is no legitimate `kind` that needs them.
 */
export function exportFilename(kind: string, format: 'csv' | 'json', now: number): string {
  const safe = kind.replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || 'trends';
  const stamp = new Date(now * 1000).toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return `viral-radar-${safe}-${stamp}.${format}`;
}
