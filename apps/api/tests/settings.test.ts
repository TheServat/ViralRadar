/**
 * The settings screen writes `.env`, which makes this the one place a browser
 * can change what the process does. These tests are about that boundary.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// Hermetic, and it has to be set before anything that reads the configuration
// loads - which is why the imports below are dynamic. Without it this file
// reads the developer's own `.env`, and `config.ts` exits the process on an
// invalid one: `W_VELOCITY=2` in a personal file turns this suite into
// "pass 0, fail 1" with a message about a setting the tests never touch.
process.env['RADAR_NO_ENV_FILE'] = '1';
process.env['LOG_LEVEL'] = 'error';

const {
  applyToEnvContent,
  isFromEnvironment,
  parseEnvValue,
  readSettings,
  SETTING_FIELDS,
} = await import('../src/settings.ts');
const { isRadarError } = await import('../src/errors.ts');

const SAMPLE = `# Viral Radar configuration
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
    assert.match(content, /^# Viral Radar configuration$/m);
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

describe('reading a .env the way Node reads it', () => {
  /*
   * Startup fills `process.env` with `process.loadEnvFile`. The settings
   * screen reads the same file with its own parser and writes the result back
   * into `process.env` before rebuilding the configuration - so if the two
   * parsers disagree, a file behaves one way until the first save and another
   * way after it.
   *
   * They disagreed. Every case below is one Node accepts, and the failures
   * were mostly silent: a source that stops collecting, a boolean that flips,
   * a settings password that stops matching and locks the screen.
   */
  const cases: [string, string, string][] = [
    ['a double-quoted value', '"hello world"', 'hello world'],
    ['a single-quoted value', "'hello world'", 'hello world'],
    ['a back-quoted value', '`hello world`', 'hello world'],
    ['a trailing comment', 'plain # trailing', 'plain'],
    ['a comment with no space', 'plain#nospace', 'plain'],
    ['a hash inside quotes', '"has # hash"', 'has # hash'],
    ['surrounding whitespace', '  padded  ', 'padded'],
    ['a plain value', 'bare', 'bare'],
    ['an unterminated quote', '"unterminated', '"unterminated'],
  ];

  for (const [name, raw, expected] of cases) {
    test(name, () => {
      assert.equal(parseEnvValue(raw), expected);
    });
  }

  test('a list setting is not silently emptied by a comment', () => {
    // The quiet one. Read literally this yields "rss # only two", which is not
    // a source id, so the source stops collecting and nothing says so.
    assert.equal(parseEnvValue('googletrends,rss # only two'), 'googletrends,rss');
  });
});

describe('settings that came from the environment', () => {
  /*
   * Startup precedence is: a real environment variable wins over `.env`,
   * because `process.loadEnvFile` does not overwrite what is already set.
   * That held until the first settings save, which cleared every declared key
   * the file did not mention - including the ones the file never mentioned
   * because they came from the environment.
   *
   * `SETTINGS_PASSWORD` is the case that matters: provided in the environment
   * and absent from `.env`, one save took it from set to empty, which turns
   * the settings lock off. The response said `live: true, problems: []`, and
   * nothing said the gate had opened - triggered by the person who had just
   * typed that password to get in.
   */

  test('an environment-provided setting is reported as set, and as not editable here', () => {
    // The snapshot is taken when the module loads, so this asserts against
    // whatever the suite was started with rather than setting it here.
    for (const field of readSettings()) {
      if (isFromEnvironment(field.key)) {
        assert.equal(field.fromEnvironment, true);
        assert.equal(field.isSet, true, 'a value that is in force must not read as unset');
      }
    }
  });

  test('a setting absent from both places is not claimed to be set', () => {
    const absent = readSettings().filter((f) => !f.isSet);
    for (const field of absent) {
      assert.equal(field.fromEnvironment, false);
    }
  });
});

describe('writing and reading back are the same operation', () => {
  /*
   * `parseEnvValue` was added to match Node, which truncates an unquoted value
   * at the first `#`. `applyToEnvContent` went on emitting bare `KEY=value`,
   * so the two disagreed about every value containing one.
   *
   * `SETTINGS_PASSWORD=pa#ssw0rd` was written, read back as `pa`, and that is
   * what the settings gate compared against - a credential silently shortened
   * to a guessable prefix, with the screen reporting the save applied. Node's
   * own loader parses it the same way, so a restart did not recover it: the
   * rest of the value was gone from disk.
   *
   * The property is the round trip, so that is what these test.
   */
  const ROUND_TRIP = [
    ['a hash in a password', 'SETTINGS_PASSWORD', 'pa#ssw0rd'],
    ['a hashtag in a description', 'INTERESTS', 'کانال من درباره #آشپزی است'],
    ['a fragment in a URL', 'PROXY_URL', 'http://user:p#ss@127.0.0.1:10809'],
    ['an apostrophe', 'INTERESTS', "it's mostly cooking"],
    ['an ordinary value', 'INTERESTS', 'cooking and travel'],
    ['a comma list', 'SOURCES_ENABLED', 'googletrends,youtube'],
  ] as const;

  for (const [name, key, value] of ROUND_TRIP) {
    test(name, () => {
      const { content, applied } = applyToEnvContent('', { [key]: value });
      assert.deepEqual(applied, [key]);
      const line = content.split('\n').find((l) => l.startsWith(`${key}=`));
      assert.ok(line, `${key} was not written`);
      assert.equal(
        parseEnvValue(line.slice(key.length + 1)),
        value,
        `written as ${JSON.stringify(line)} and read back wrong`,
      );
    });
  }

  test('an existing line is rewritten the same way as a new one', () => {
    // The two branches of applyToEnvContent are separate code paths, and only
    // one of them was exercised by the previous tests.
    const { content } = applyToEnvContent('SETTINGS_PASSWORD=old\n', {
      SETTINGS_PASSWORD: 'pa#ssw0rd',
    });
    const line = content.split('\n').find((l) => l.startsWith('SETTINGS_PASSWORD='));
    assert.ok(line);
    assert.equal(parseEnvValue(line.slice('SETTINGS_PASSWORD='.length)), 'pa#ssw0rd');
  });

  test('a value that cannot be written safely is refused, not mangled', () => {
    // Quoting is with double quotes, so a value containing one has no safe
    // form. Refusing beats writing something that reads back as a prefix.
    assert.throws(
      () => applyToEnvContent('', { INTERESTS: 'a "quoted" phrase # here' }),
      (e: unknown) => isRadarError(e) && e.kind === 'VALIDATION',
    );
  });

  test('a plain value is still written without quotes', () => {
    // `.env` is a file people edit by hand; quoting everything would make it
    // worse to read for no gain.
    const { content } = applyToEnvContent('', { INTERESTS: 'cooking and travel' });
    assert.ok(content.includes('INTERESTS=cooking and travel'), content);
  });
});
