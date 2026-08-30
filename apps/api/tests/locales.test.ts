/**
 * Every string the interface asks for is a string the interface has.
 *
 * `check-locales.mjs` already compares the three locale files against each
 * other, which catches a half-translated feature. It cannot catch a key that
 * is missing from all three, because they agree — and that is what happens
 * when a page is written and the translations are added in a separate step
 * that fails. The page then renders `gaps.title` as its heading, in every
 * language, and the build is green.
 *
 * This reads the other direction: from what the source asks for, to what
 * exists. Same shape as the icon test, and it exists because the same mistake
 * happened.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const WEB_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'src');
const LOCALES = join(WEB_SRC, 'locales');

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (full !== LOCALES) sourceFiles(full, found);
    } else if (/\.(vue|ts)$/.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Every key defined in one locale file, flattened to `a.b.c`.
 *
 * The source is read rather than imported, for the same reason the sibling
 * script does it: no bundler, and a runtime error in a locale file cannot hide
 * the answer.
 */
function definedKeys(file: string): Set<string> {
  const source = readFileSync(join(LOCALES, file), 'utf8');
  const keys = new Set<string>();
  const stack: string[] = [];

  for (const raw of source.split('\n')) {
    const line = raw.trim();
    const open = /^([A-Za-z_$][\w$]*)\s*:\s*\{$/.exec(line);
    if (open !== null) {
      stack.push(open[1] as string);
      continue;
    }
    if (line.startsWith('}')) {
      stack.pop();
      continue;
    }
    const leaf = /^([A-Za-z_$][\w$]*)\s*:/.exec(line);
    if (leaf !== null) keys.add([...stack, leaf[1] as string].join('.'));
  }
  return keys;
}

/**
 * Static translation keys used in the source.
 *
 * Only the literal ones. A key built at runtime — `$t(\`formats.group.${g.key}\`)`
 * — cannot be checked without knowing the data, and guessing at it would
 * produce false failures that teach people to ignore this test.
 */
const USED = /\$?\bt\(\s*'([a-z][\w.]*)'/gi;

describe('translations', () => {
  const english = definedKeys('en.ts');

  const used = new Map<string, string[]>();
  for (const file of sourceFiles(WEB_SRC)) {
    for (const match of readFileSync(file, 'utf8').matchAll(USED)) {
      const key = match[1] as string;
      const where = used.get(key) ?? [];
      if (!where.includes(file)) where.push(file);
      used.set(key, where);
    }
  }

  test('the scan finds keys at all', () => {
    assert.ok(used.size > 100, `only found ${used.size} used keys — the scan is broken`);
    assert.ok(english.size > 200, `only found ${english.size} defined keys — the parse is broken`);
  });

  test('every key the interface asks for is defined', () => {
    // The failure this catches renders the key itself on screen, in every
    // language at once, with a green build.
    const missing = [...used]
      .filter(([key]) => !english.has(key))
      .map(([key, files]) => `  ${key}  used in ${files.map((f) => f.split(/[\\/]/).pop()).join(', ')}`);

    assert.deepEqual(missing, [], `these render as the key itself:\n${missing.join('\n')}`);
  });

  test('the other two languages define what English does', () => {
    // The sibling script checks this during the build; asserting it here means
    // a test run alone is enough to know.
    for (const file of ['fa.ts', 'ar.ts']) {
      const keys = definedKeys(file);
      const missing = [...english].filter((k) => !keys.has(k));
      assert.deepEqual(missing, [], `${file} is missing: ${missing.slice(0, 10).join(', ')}`);
    }
  });
});
