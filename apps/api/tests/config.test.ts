/**
 * Configuration that can change while the program is running.
 *
 * The settings screen writes `.env` and the radar keeps serving, so the
 * configuration has to be rebuildable rather than read once. Two properties
 * make that safe, and both are easy to break without noticing:
 *
 *   1. **The exported object keeps its identity.** Every module in the program
 *      did `import { config }` at load. If a reload replaced the object rather
 *      than refilling it, all of them would keep reading the old one and the
 *      new settings would apply to nothing — silently, with no error anywhere.
 *
 *   2. **A rejected build changes nothing.** Half-applying an invalid
 *      configuration to a running radar is worse than refusing it.
 *
 * Nothing here touches the real `.env`: these set environment variables
 * directly, which is the layer the builder actually reads.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env['RADAR_NO_ENV_FILE'] = '1';
process.env['LOG_LEVEL'] = 'error';

const { config, reloadConfig, RESTART_REQUIRED } = await import('../src/config.ts');
const { SETTING_FIELDS } = await import('../src/settings.ts');
const { scoringOptions } = await import('../src/pipeline/analyze.ts');

/** Restored after each case, so one test cannot decide another's outcome. */
const TOUCHED = ['W_VELOCITY', 'W_ACCELERATION', 'W_ANOMALY', 'W_ENGAGEMENT', 'W_CROSS_SOURCE', 'W_FRESHNESS', 'INTERESTS', 'EMBED_MODEL', 'ANALYZE_INTERVAL_MIN', 'MAX_AGE_HOURS'];
const original = new Map<string, string | undefined>();

before(() => {
  for (const key of TOUCHED) original.set(key, process.env[key]);
});

after(() => {
  for (const [key, value] of original) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  reloadConfig();
});

describe('reloading the configuration', () => {
  test('the exported object is refilled, never replaced', () => {
    // The property everything else rests on. `import { config }` binds once.
    const before = config;
    process.env['INTERESTS'] = 'comedy clips';
    const result = reloadConfig();
    assert.equal(result.ok, true);
    assert.equal(config, before, 'a new object would leave every importer on the old one');
    assert.equal(config.interests, 'comedy clips');
  });

  test('a value that was set and is then removed goes back to its default', () => {
    process.env['ANALYZE_INTERVAL_MIN'] = '3';
    reloadConfig();
    assert.equal(config.schedule.analyzeMin, 3);

    delete process.env['ANALYZE_INTERVAL_MIN'];
    reloadConfig();
    assert.notEqual(config.schedule.analyzeMin, 3, 'a removed setting must stop applying');
  });

  test('an invalid build is refused and leaves the running values alone', () => {
    process.env['INTERESTS'] = 'still here';
    reloadConfig();

    // Weights summing to zero mean nothing could ever be scored, which the
    // builder rejects. The point is what happens next: nothing.
    for (const key of ['W_VELOCITY', 'W_ACCELERATION', 'W_ANOMALY', 'W_ENGAGEMENT', 'W_CROSS_SOURCE', 'W_FRESHNESS']) {
      process.env[key] = '0';
    }
    const result = reloadConfig();

    assert.equal(result.ok, false);
    assert.ok(result.problems.length > 0, 'a refusal has to say why');
    assert.equal(config.interests, 'still here', 'the running configuration must be untouched');
    assert.ok(config.scoring.weights.velocity > 0, 'the rejected weights must not have been applied');
  });

  test('the settings that cannot be applied live are named, not implied', () => {
    // A blanket "restart required" trains people to ignore it. This is the
    // whole list, and each entry says why.
    assert.deepEqual(Object.keys(RESTART_REQUIRED).sort(), [
      'DB_PATH',
      'HOST',
      'NETWORK_MODE',
      'PORT',
      'PROXY_URL',
    ]);
    for (const why of Object.values(RESTART_REQUIRED)) {
      assert.ok(why.length > 10, 'each one should explain itself');
    }
  });

  test('the scoring pass reads the weights it is run with, not the ones it loaded with', () => {
    // These are the settings the tuning recipe in the docs tells people to
    // change, and they used to be copied into a constant at module scope —
    // which `config.ts` warns about by name. Reloading replaces
    // `config.scoring` wholesale, so the copy kept the original weights
    // forever while the screen said "Saved and applied. No restart needed."
    process.env['W_ACCELERATION'] = '0.9';
    process.env['W_VELOCITY'] = '0.05';
    process.env['MAX_AGE_HOURS'] = '240';
    assert.equal(reloadConfig().ok, true);

    const options = scoringOptions();
    assert.equal(options.weights.acceleration, 0.9);
    assert.equal(options.maxAgeHours, 240);
  });

  test('the settings that need a restart can actually be reached', () => {
    // The branch that reports them filters what was saved against
    // RESTART_REQUIRED, and the settings screen refuses any key it does not
    // describe. For a while those two sets were disjoint by construction, so
    // the list was always empty and the whole restart notice — the branch, the
    // component, its strings in three languages — was dead code that read like
    // a working feature.
    const editable = new Set(SETTING_FIELDS.map((f) => f.key));
    const reachable = Object.keys(RESTART_REQUIRED).filter((key) => editable.has(key));
    assert.ok(
      reachable.length > 0,
      'nothing that needs a restart is editable, so the notice can never appear',
    );
  });

  test('a proxy setting never reports itself as applied', () => {
    // The one where being wrong is not an inconvenience. Someone who sets a
    // proxy and is told "applied, no restart needed" goes on collecting from
    // their own address believing they are not.
    for (const key of ['NETWORK_MODE', 'PROXY_URL']) {
      assert.ok(key in RESTART_REQUIRED, `${key} must not claim to apply live`);
    }
  });
});

describe('every setting the code reads is a setting the file explains', () => {
  /*
   * `.env.example` is the only place most people will ever look for what can
   * be configured, and two settings had never been written down:
   * EMBED_BATCH_SIZE and EMBED_TIMEOUT_MS. The second matters - the embedding
   * pass is synchronous, so its two-minute default is also the longest the
   * dashboard can stall on a wedged model, and a reader who could not find it
   * would conclude the stall was not configurable.
   *
   * Found by hand in review. This is the mechanical version.
   */
  test('no key is read by config.ts without a line in .env.example', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const configSrc = readFileSync(join(here, '..', 'src', 'config.ts'), 'utf8');
    const example = readFileSync(join(here, '..', '..', '..', '.env.example'), 'utf8');

    // Every key passed to one of the readers, e.g. num('EMBED_BATCH_SIZE', ...).
    const keys = new Set<string>();
    for (const m of configSrc.matchAll(/(?:num|str|bool|list)\(\s*'([A-Z][A-Z0-9_]*)'/g)) {
      keys.add(m[1] as string);
    }
    assert.ok(keys.size > 50, `only found ${keys.size} settings - the scan is broken`);

    const documented = new Set<string>();
    for (const m of example.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]*)=/gm)) documented.add(m[1] as string);

    const missing = [...keys].filter((k) => !documented.has(k)).sort();
    assert.deepEqual(missing, [], 'read by config.ts, absent from .env.example: ' + missing.join(', '));
  });
});
