/**
 * A date the interface formats means the same thing in every timezone.
 *
 * The weekday chart labelled its bars by formatting seven UTC midnights with
 * an `Intl.DateTimeFormat` that had no `timeZone`. That formatter renders in
 * the *viewer's* zone, so anywhere west of Greenwich each instant fell on the
 * previous evening and every label slid one day: the bar computed for Sunday
 * was labelled Saturday, for the whole of the Americas.
 *
 * Nothing about it looked wrong. The rows sort on the numeric key, so the
 * order stayed 0..6 while the names moved underneath, and the only artifact
 * was a week that appeared to start on Saturday — which reads as a styling
 * choice. The finding sentence underneath interpolates the same label into
 * prose, so the page also gave the wrong day as advice.
 *
 * The check reads the source, because the defect is an option that was not
 * written down, and there is no rendering that reveals it without knowing
 * which zone you are in.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const WEB_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'src');

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, found);
    else if (/\.(vue|ts)$/.test(entry)) found.push(full);
  }
  return found;
}

describe('dates the interface formats itself', () => {
  test('a weekday or month name built from a fixed instant names its zone', () => {
    // Deliberately narrow: this is about formatters given a *constructed*
    // reference date to extract a name from, which is the case where the
    // viewer's zone is never what was meant. A formatter shown a real
    // timestamp should use the viewer's zone, and is not what this matches.
    const offenders: string[] = [];
    for (const file of sourceFiles(WEB_SRC)) {
      const text = readFileSync(file, 'utf8');
      if (!/Date\.UTC\(/.test(text)) continue;
      for (const [call] of text.matchAll(/new Intl\.DateTimeFormat\([^)]*\)/g)) {
        if (/weekday|month/.test(call) && !/timeZone/.test(call)) {
          offenders.push(`${file.slice(WEB_SRC.length + 1)}: ${call}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `these format a fixed instant in the viewer's zone, which shifts the name:\n  ${offenders.join('\n  ')}`,
    );
  });

  test('the seven reference instants really do start on Sunday', () => {
    // The other half of the same bug: the server numbers weekdays with
    // strftime('%w'), where Sunday is 0. If this ever stops lining up, every
    // label is wrong in every zone rather than only in some.
    const names = Array.from({ length: 7 }, (_, i) =>
      new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(
        new Date(Date.UTC(2024, 0, 7 + i)),
      ),
    );
    assert.deepEqual(names, [
      'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
    ]);
  });
});
