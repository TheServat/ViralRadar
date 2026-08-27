/**
 * The settings screen writes `.env`, which makes this the one place a browser
 * can change what the process does. These tests are about that boundary.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyToEnvContent, SETTING_FIELDS } from '../src/settings.ts';
import { isRadarError } from '../src/errors.ts';

const SAMPLE = `# Trend Radar configuration
PORT=7788

# Which countries to follow
REGIONS=US
LANGUAGES=

YOUTUBE_API_KEY=existing-key
`;

describe('writing .env', () => {
  test('changes only the keys given, leaving the rest untouched', () => {
    const { content, applied } = applyToEnvContent(SAMPLE, { REGIONS: 'IR,US' });
    assert.deepEqual(applied, ['REGIONS']);
    assert.match(content, /^REGIONS=IR,US$/m);
    assert.match(content, /^YOUTUBE_API_KEY=existing-key$/m);
    assert.match(content, /^PORT=7788$/m);
  });

  test('keeps comments and ordering, because a person edits this file too', () => {
    const { content } = applyToEnvContent(SAMPLE, { LANGUAGES: 'fa,en' });
    assert.match(content, /^# Trend Radar configuration$/m);
    assert.match(content, /^# Which countries to follow$/m);
    assert.ok(content.indexOf('PORT=') < content.indexOf('REGIONS='), 'order should survive');
  });

  test('appends a key that is not in the file yet', () => {
    const { content, applied } = applyToEnvContent(SAMPLE, { HOT_REFRESH_MIN: '3' });
    assert.deepEqual(applied, ['HOT_REFRESH_MIN']);
    assert.match(content, /^HOT_REFRESH_MIN=3$/m);
  });

  test('refuses a key that is not an editable setting', () => {
    assert.throws(
      () => applyToEnvContent(SAMPLE, { PATH: '/evil' }),
      (e: unknown) => isRadarError(e) && e.kind === 'VALIDATION',
    );
    assert.throws(() => applyToEnvContent(SAMPLE, { DB_PATH: '../../etc/passwd' }));
  });

  test('refuses a value that would break out of its line', () => {
    assert.throws(
      () => applyToEnvContent(SAMPLE, { REGIONS: 'US\nAPI_TOKEN=stolen' }),
      (e: unknown) => isRadarError(e) && e.kind === 'VALIDATION',
    );
  });

  test('rejects numbers outside the declared range', () => {
    assert.throws(() => applyToEnvContent(SAMPLE, { HOT_REFRESH_MIN: '0' }));
    assert.throws(() => applyToEnvContent(SAMPLE, { HOT_REFRESH_MIN: 'soon' }));
    assert.throws(() => applyToEnvContent(SAMPLE, { W_VELOCITY: '5' }));
    const { content } = applyToEnvContent(SAMPLE, { W_VELOCITY: '0.4' });
    assert.match(content, /^W_VELOCITY=0\.4$/m);
  });

  test('rejects a select value that is not one of the options', () => {
    assert.throws(() => applyToEnvContent(SAMPLE, { NETWORK_MODE: 'TOR_MAGIC' }));
    const { content } = applyToEnvContent(SAMPLE, { NETWORK_MODE: 'HTTP_PROXY' });
    assert.match(content, /^NETWORK_MODE=HTTP_PROXY$/m);
  });

  test('normalises a list, dropping blanks and stray spaces', () => {
    const { content } = applyToEnvContent(SAMPLE, { REGIONS: ' IR , , US ,' });
    assert.match(content, /^REGIONS=IR,US$/m);
  });

  test('an empty list clears the setting rather than writing junk', () => {
    const { content } = applyToEnvContent(SAMPLE, { REGIONS: '' });
    assert.match(content, /^REGIONS=$/m);
  });
});

describe('the editable surface', () => {
  test('every field has a translation key and a default', () => {
    for (const field of SETTING_FIELDS) {
      assert.match(field.label, /^settings\./, `${field.key} label`);
      assert.match(field.help, /^settings\./, `${field.key} help`);
      assert.equal(typeof field.defaultValue, 'string');
      assert.ok(field.group.length > 0);
    }
  });

  test('no field key is declared twice', () => {
    const keys = SETTING_FIELDS.map((f) => f.key);
    assert.equal(new Set(keys).size, keys.length);
  });

  test('credentials are marked secret so they are never sent to a browser', () => {
    for (const key of ['YOUTUBE_API_KEY', 'REDDIT_CLIENT_SECRET', 'AI_API_KEY']) {
      const field = SETTING_FIELDS.find((f) => f.key === key);
      assert.ok(field !== undefined, `${key} should be editable`);
      assert.equal(field.kind, 'secret', `${key} must be a secret`);
    }
  });

  test('nothing that would move the database or open the server is editable', () => {
    const keys = new Set(SETTING_FIELDS.map((f) => f.key));
    for (const forbidden of ['DB_PATH', 'HOST', 'PORT', 'API_TOKEN']) {
      assert.ok(!keys.has(forbidden), `${forbidden} must not be editable from a browser`);
    }
  });
});
