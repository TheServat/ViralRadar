/**
 * Things that need a human.
 *
 * The failure this guards against is a quiet one: an intervention raised by a
 * source that has since been switched off can never be resolved, because the
 * source that would clear it never runs again. It sits on the System page
 * indefinitely, making a healthy system look broken.
 *
 * That is not hypothetical — two Reddit warnings outlived Reddit being enabled
 * by two days and were still being shown to a user who had never configured
 * Reddit and had no way to act on them.
 */
import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DB_FILE = join(tmpdir(), `radar-intervention-${process.pid}.db`);
process.env['RADAR_NO_ENV_FILE'] = '1';
process.env['DB_PATH'] = DB_FILE;
process.env['LOG_LEVEL'] = 'error';
// The sources this test's radar is running. Reddit is deliberately not one.
process.env['SOURCES_ENABLED'] = 'googletrends,youtube';

const { db, closeDb } = await import('../src/db/db.ts');
const repo = await import('../src/db/repo.ts');
const { createHandlers } = await import('../src/api/routes.ts');

const NOW = 1_750_000_000;

before(() => {
  db();
  repo.openIntervention({
    source: 'reddit',
    type: 'CONFIGURATION',
    message: 'Reddit refused anonymous access from this network',
    url: null,
    now: NOW,
  });
  repo.openIntervention({
    source: 'youtube',
    type: 'AUTH_REQUIRED',
    message: 'the API key was rejected',
    url: null,
    now: NOW,
  });
});

after(() => {
  closeDb();
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(`${DB_FILE}${suffix}`);
    } catch {
      // A missing side-file is not worth failing a teardown over.
    }
  }
});

describe('what the user is asked to fix', () => {
  test('a source that is running can raise a warning', () => {
    const result = createHandlers(null).interventions() as { items: { source: string }[] };
    assert.ok(result.items.some((i) => i.source === 'youtube'));
  });

  test('a source that is switched off cannot', () => {
    // Nothing the user does resolves this one: reddit never runs to clear it.
    const result = createHandlers(null).interventions() as { items: { source: string }[] };
    assert.ok(!result.items.some((i) => i.source === 'reddit'), 'a disabled source should not nag');
  });

  test('the muted ones are counted rather than silently dropped', () => {
    // "Why am I not seeing this" needs an answer that is not "read the database".
    const result = createHandlers(null).interventions() as { mutedForDisabledSources: number };
    assert.equal(result.mutedForDisabledSources, 1);
  });

  test('the record itself is kept, not deleted', () => {
    // Filtered on read: switch the source back on and the warning returns
    // without having to be rediscovered.
    const stored = repo.listInterventions('OPEN');
    assert.ok(stored.some((i) => i.source === 'reddit'), 'history should survive the filter');
  });
});
