/**
 * Every locale must define every key.
 *
 * A missing key falls back to English silently, which is exactly how a
 * half-translated interface ships without anyone noticing. This makes it noisy,
 * and it runs as part of the build.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'src', 'locales');

/**
 * Flattens `a: { b: 'x' }` into `a.b`.
 *
 * Reads the source rather than importing it, so the check works without a
 * bundler and cannot be defeated by a runtime error in a locale file.
 */
function keysOf(file) {
  const source = readFileSync(join(localesDir, file), 'utf8');
  const keys = [];
  const stack = [];
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    const open = line.match(/^(\w+): \{$/);
    if (open) {
      stack.push(open[1]);
      continue;
    }
    if (line === '},' || line === '};' || line === '}') {
      stack.pop();
      continue;
    }
    // A long value is often wrapped onto the next line, so a key whose line
    // ends at the colon counts too - otherwise the check reports translated
    // strings as missing, which is worse than not checking at all.
    const leaf = line.match(/^(\w+):\s*(?:'|$)/);
    if (leaf && stack.length > 0) keys.push([...stack, leaf[1]].join('.'));
  }
  return new Set(keys);
}

const files = ['en.ts', 'fa.ts', 'ar.ts'];
const sets = new Map(files.map((f) => [f, keysOf(f)]));
const reference = sets.get('en.ts');

let failed = false;
for (const [file, keys] of sets) {
  const missing = [...reference].filter((k) => !keys.has(k));
  const extra = [...keys].filter((k) => !reference.has(k));
  if (missing.length > 0) {
    failed = true;
    console.error(`\n  ${file}: missing ${missing.length} keys`);
    for (const k of missing.slice(0, 30)) console.error(`     - ${k}`);
  }
  if (extra.length > 0) {
    failed = true;
    console.error(`\n  ${file}: ${extra.length} keys that en.ts does not have`);
    for (const k of extra.slice(0, 30)) console.error(`     + ${k}`);
  }
}

if (failed) {
  console.error('\n  Translations are incomplete.\n');
  process.exit(1);
}
console.log(`  locales complete: ${files.join(', ')} — ${reference.size} keys each`);
