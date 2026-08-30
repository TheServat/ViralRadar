/**
 * Every icon the interface asks for is one the interface actually has.
 *
 * The icon set is seventy-odd SVG paths rather than the four-megabyte Material
 * font, which is the right trade — but it makes the set a list somebody has to
 * remember to add to. An unregistered name does not throw: it renders a
 * question mark. So a missing icon looks like a design decision, and a name
 * used on every card in a list becomes a screen full of question marks
 * discovered long after the commit that caused it.
 *
 * This is the check that turns that into a build failure. It reads the source
 * rather than the running app on purpose — the failure is a name that was
 * written down, and reading what was written down is the direct way to find it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const WEB_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'src');
const ICONS_FILE = join(WEB_SRC, 'plugins', 'icons.ts');

/** Every `.vue` and `.ts` file under the dashboard, except the icon set itself. */
function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, found);
    } else if (/\.(vue|ts)$/.test(entry) && full !== ICONS_FILE) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Names are matched by their shape, not by where they appear.
 *
 * They are written in several ways — a static attribute, a bound expression, a
 * fallback after `??`, a value in a lookup table — and a matcher that
 * understood only one of those would pass while the interface showed question
 * marks. The shape `mdi-…` is unambiguous enough to find all of them.
 */
const NAME = /mdi-[a-z0-9-]+/g;

describe('the icon set', () => {
  const registered = new Set(
    [...readFileSync(ICONS_FILE, 'utf8').matchAll(/'(mdi-[a-z0-9-]+)':/g)].map((m) => m[1] as string),
  );

  const used = new Map<string, string[]>();
  for (const file of sourceFiles(WEB_SRC)) {
    for (const name of readFileSync(file, 'utf8').match(NAME) ?? []) {
      const where = used.get(name) ?? [];
      if (!where.includes(file)) where.push(file);
      used.set(name, where);
    }
  }

  test('finds the names at all', () => {
    // Guards the test itself: a matcher that silently found nothing would
    // report success for ever.
    assert.ok(used.size > 50, `only found ${used.size} icon names — the scan is broken`);
    assert.ok(registered.size > 50, `only ${registered.size} registered — the parse is broken`);
  });

  test('every icon the interface asks for is registered', () => {
    const missing = [...used]
      .filter(([name]) => !registered.has(name))
      .map(([name, files]) => `  ${name}  used in ${files.map((f) => f.split(/[\\/]/).pop()).join(', ')}`);

    assert.deepEqual(
      missing,
      [],
      `these render as question marks; add them to plugins/icons.ts:\n${missing.join('\n')}`,
    );
  });

  test('the fallback exists, so an unknown name degrades rather than crashes', () => {
    // The safety net is meant to stay. Losing it would turn a missing icon from
    // a visible question mark into an exception during render.
    assert.match(readFileSync(ICONS_FILE, 'utf8'), /\?\?\s*mdiHelpCircleOutline/);
  });
});
