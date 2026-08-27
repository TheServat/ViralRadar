/**
 * Export and archive.
 *
 * The CSV tests are mostly about spreadsheets rather than about CSV. The format
 * is trivial; what is not trivial is that titles here are written by strangers
 * and land in a file the user opens in Excel, where a leading `=` is a formula
 * and a missing BOM turns every Persian title into mojibake.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env['RADAR_NO_ENV_FILE'] = '1';
process.env['LOG_LEVEL'] = 'error';

const { exportFilename, toCsv, toJson } = await import('../src/api/export.ts');
import type { RankedRow } from '../src/db/repo.ts';

function row(overrides: Partial<RankedRow> = {}): RankedRow {
  return {
    id: 'youtube:abc',
    source: 'youtube',
    external_id: 'abc',
    url: 'https://youtube.com/watch?v=abc',
    canonical_url: null,
    title: 'A normal title',
    body: null,
    content_type: 'video',
    author_id: 'UC1',
    author_name: 'Someone',
    thumbnail_url: null,
    lang: 'en',
    lang_confidence: 0.9,
    country: 'US',
    country_confidence: 0.5,
    country_source: null,
    published_at: 1_750_000_000,
    published_at_source: 'api',
    first_seen_at: 1_750_000_000,
    last_seen_at: 1_750_003_600,
    region: null,
    keywords: null,
    hashtags: null,
    simhash: null,
    raw: null,
    score: 66.66,
    confidence: 0.75,
    state: 'HOT',
    velocity: 12.34,
    acceleration: 1.5,
    engagement_rate: 0.02,
    creator_anomaly: 3.2,
    source_percentile: 0.91,
    freshness: 0.8,
    cross_source: 0.2,
    primary_metric: 'views',
    primary_value: 12345,
    observations: 4,
    age_hours: 3.5,
    peak_score: null,
    peak_at: null,
    author_followers: 1000,
    creator_url: 'https://youtube.com/channel/UC1',
    creator_median: 500,
    views: 12345,
    likes: 100,
    comments: 20,
    shares: null,
    native_score: null,
    ...overrides,
  } as RankedRow;
}

describe('CSV export', () => {
  test('starts with a BOM so Excel reads UTF-8 as UTF-8', () => {
    const csv = toCsv([row({ title: 'قیمت دلار امروز' })]);
    assert.equal(csv.charCodeAt(0), 0xfeff);
    assert.ok(csv.includes('قیمت دلار امروز'), 'the Persian title should survive intact');
  });

  test('a title that looks like a formula is neutralised', () => {
    // Titles come from strangers. Without this, opening the file runs it.
    for (const dangerous of ['=1+1', '+1', '-1', '@SUM(A1)']) {
      const csv = toCsv([row({ title: dangerous })]);
      const line = csv.split('\r\n')[1] ?? '';
      assert.ok(line.startsWith(`"'${dangerous}`), `${dangerous} was not neutralised: ${line}`);
    }
  });

  test('quotes and commas are escaped rather than breaking the row', () => {
    const csv = toCsv([row({ title: 'He said "hi", then left' })]);
    assert.ok(csv.includes('"He said ""hi"", then left"'));
    // Still one header row and one data row.
    assert.equal(csv.trimEnd().split('\r\n').length, 2);
  });

  test('a newline inside a title is kept, quoted, not stripped', () => {
    const csv = toCsv([row({ title: 'line one\nline two' })]);
    assert.ok(csv.includes('"line one\nline two"'));
  });

  test('missing values are empty cells, not the word null', () => {
    const csv = toCsv([row({ likes: null, author_name: null })]);
    assert.ok(!csv.includes('null'), 'a literal "null" would be read as text by a spreadsheet');
  });

  test('timestamps are readable dates, not epoch seconds', () => {
    const csv = toCsv([row()]);
    assert.ok(/\d{4}-\d{2}-\d{2}T/.test(csv), 'no ISO timestamp found');
  });

  test('the header names every column exactly once', () => {
    const header = (toCsv([]).split('\r\n')[0] ?? '').replace('﻿', '').split(',');
    assert.equal(new Set(header).size, header.length, 'duplicate column name');
    assert.ok(header.includes('title') && header.includes('score') && header.includes('url'));
  });
});

describe('JSON export', () => {
  test('is valid JSON with the same columns as the CSV', () => {
    const parsed = JSON.parse(toJson([row()])) as Record<string, unknown>[];
    assert.equal(parsed.length, 1);
    const header = (toCsv([]).split('\r\n')[0] ?? '').replace('﻿', '').split(',');
    assert.deepEqual(Object.keys(parsed[0] ?? {}).sort(), [...header].sort());
  });

  test('numbers stay numbers, so a script does not have to parse them', () => {
    const parsed = JSON.parse(toJson([row()])) as { score: unknown }[];
    assert.equal(typeof parsed[0]?.score, 'number');
  });
});

describe('the filename', () => {
  test('sorts chronologically and says what it holds', () => {
    const name = exportFilename('trends', 'csv', 1_750_000_000);
    assert.match(name, /^viral-radar-trends-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.csv$/);
  });

  test('has no characters a filesystem would object to', () => {
    const name = exportFilename('trends', 'json', 1_750_000_000);
    assert.ok(!/[:\\/*?"<>|]/.test(name), `unsafe filename: ${name}`);
  });
});
