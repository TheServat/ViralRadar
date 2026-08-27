/**
 * The settings gate and the notification filter.
 *
 * Both decide whether something happens, so both are worth testing on their
 * own: one guards the screen that can rewrite `.env`, the other decides what
 * is worth interrupting someone for.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Pinned before the configuration module is imported, and with the developer's
// own .env ignored, so these results do not depend on anyone's machine.
process.env['RADAR_NO_ENV_FILE'] = '1';
process.env['LOG_LEVEL'] = 'error';
process.env['SETTINGS_PASSWORD'] = 'correct horse battery staple';
process.env['NOTIFY_QUIET_HOURS'] = '23,8';

const { checkSettingsPassword, isSettingsProtected, resetSettingsAttempts } = await import(
  '../src/api/gate.ts'
);
const { escapeHtml, formatNotification } = await import('../src/notify/channels.ts');
const { inQuietHours } = await import('../src/notify/index.ts');

describe('the settings gate', () => {
  beforeEach(() => {
    resetSettingsAttempts();
  });

  test('is on when a password is configured', () => {
    assert.equal(isSettingsProtected(), true);
  });

  test('accepts the password', () => {
    assert.equal(checkSettingsPassword('correct horse battery staple', 'a').ok, true);
  });

  test('rejects a wrong password, an empty one and a missing one', () => {
    assert.equal(checkSettingsPassword('wrong', 'a').ok, false);
    assert.equal(checkSettingsPassword('', 'b').ok, false);
    assert.equal(checkSettingsPassword(null, 'c').ok, false);
  });

  test('rejects a prefix of the real password', () => {
    // A comparison that stopped at the first difference would still reject
    // this, but the point is that length alone never gets anyone in.
    assert.equal(checkSettingsPassword('correct horse', 'a').ok, false);
    assert.equal(checkSettingsPassword('correct horse battery staple!', 'a').ok, false);
  });

  test('locks a client out after five failures', () => {
    for (let i = 0; i < 4; i++) {
      const attempt = checkSettingsPassword('wrong', 'guesser');
      assert.equal(attempt.ok, false);
      assert.equal(attempt.retryAfterSec, 0, `attempt ${i + 1} should not lock yet`);
    }
    const locked = checkSettingsPassword('wrong', 'guesser');
    assert.equal(locked.ok, false);
    assert.ok(locked.retryAfterSec > 0, 'the fifth failure should start a lockout');
  });

  test('a lockout holds even against the correct password', () => {
    for (let i = 0; i < 5; i++) checkSettingsPassword('wrong', 'guesser');
    const attempt = checkSettingsPassword('correct horse battery staple', 'guesser');
    assert.equal(attempt.ok, false, 'guessing must not be rewarded by eventually being right');
    assert.ok(attempt.retryAfterSec > 0);
  });

  test('one client being locked out does not lock out another', () => {
    for (let i = 0; i < 6; i++) checkSettingsPassword('wrong', 'guesser');
    assert.equal(checkSettingsPassword('correct horse battery staple', 'someone-else').ok, true);
  });

  test('a success clears the failures that came before it', () => {
    checkSettingsPassword('wrong', 'typo');
    checkSettingsPassword('wrong', 'typo');
    assert.equal(checkSettingsPassword('correct horse battery staple', 'typo').ok, true);
    // Back to a full allowance, rather than one mistake from a lockout.
    for (let i = 0; i < 4; i++) {
      assert.equal(checkSettingsPassword('wrong', 'typo').retryAfterSec, 0);
    }
  });
});

describe('notification formatting', () => {
  test('escapes markup so a title cannot inject into the message', () => {
    assert.equal(escapeHtml('<b>hi</b> & "bye"'), '&lt;b&gt;hi&lt;/b&gt; &amp; &quot;bye&quot;');
  });

  test('a hostile title is rendered as text, not as a link', () => {
    const message = formatNotification({
      kind: 'viral',
      title: '<a href="https://evil.example">click me</a>',
      reason: 'test',
      url: 'https://example.com/real',
      source: 'rss',
      score: 90,
      at: 0,
    });
    assert.ok(!message.includes('href="https://evil.example"'), 'the injected anchor survived');
    assert.ok(message.includes('https://example.com/real'), 'the real link is missing');
  });

  test('includes the score, the source and the reason', () => {
    const message = formatNotification({
      kind: 'breakout',
      title: 'A small channel just exploded',
      reason: '240× what this account normally gets',
      url: 'https://example.com/x',
      source: 'youtube',
      score: 87.4,
      at: 0,
    });
    assert.ok(message.includes('87'), 'score missing');
    assert.ok(message.includes('youtube'), 'source missing');
    assert.ok(message.includes('240×'), 'reason missing');
  });
});

describe('quiet hours', () => {
  const at = (hour: number): number => {
    const d = new Date();
    d.setHours(hour, 30, 0, 0);
    return Math.floor(d.getTime() / 1000);
  };

  test('a window that wraps past midnight covers both sides of it', () => {
    // Configured as 23 to 8.
    assert.equal(inQuietHours(at(23)), true);
    assert.equal(inQuietHours(at(2)), true);
    assert.equal(inQuietHours(at(7)), true);
  });

  test('daytime is not quiet', () => {
    assert.equal(inQuietHours(at(9)), false);
    assert.equal(inQuietHours(at(15)), false);
    assert.equal(inQuietHours(at(22)), false);
  });
});
