/**
 * The settings gate.
 *
 * `API_TOKEN` protects the whole API and is all-or-nothing. This is narrower
 * and answers a different worry: the dashboard is open on a machine other
 * people can reach, and the Settings page is the one screen that lists which
 * credentials exist, which channels are followed — and can rewrite `.env`.
 *
 * What this defends against is someone using the browser in front of them. It
 * is not a defence against anyone who can read the filesystem, because `.env`
 * sits there in plain text either way. Saying so plainly matters more than the
 * feature looking stronger than it is.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { config } from '../config.ts';

/** Empty password means the gate is off, which is the default. */
export function isSettingsProtected(): boolean {
  return config.server.settingsPassword !== '';
}

/**
 * Constant-time comparison.
 *
 * Both sides are hashed first so the buffers are always the same length —
 * `timingSafeEqual` throws on a length mismatch, and the length of the real
 * password should not be discoverable by watching for that throw.
 */
function matches(supplied: string, expected: string): boolean {
  const a = createHash('sha256').update(supplied, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

// ── Attempt limiting ───────────────────────────────────────────────────────

interface Attempts {
  failures: number;
  firstFailureAt: number;
  lockedUntil: number;
}

const attempts = new Map<string, Attempts>();
const WINDOW_MS = 10 * 60_000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60_000;

export interface GateResult {
  readonly ok: boolean;
  /** Seconds until another attempt is allowed, when locked out. */
  readonly retryAfterSec: number;
}

/**
 * A short password on a local service is still worth guessing at machine speed
 * if nothing stops it. Five failures buys a fifteen-minute lockout for that
 * client; a success clears the record.
 */
export function checkSettingsPassword(supplied: string | null, client: string): GateResult {
  if (!isSettingsProtected()) return { ok: true, retryAfterSec: 0 };

  const now = Date.now();
  const record = attempts.get(client);

  if (record !== undefined && record.lockedUntil > now) {
    return { ok: false, retryAfterSec: Math.ceil((record.lockedUntil - now) / 1000) };
  }

  if (supplied !== null && supplied !== '' && matches(supplied, config.server.settingsPassword)) {
    attempts.delete(client);
    return { ok: true, retryAfterSec: 0 };
  }

  const fresh =
    record === undefined || now - record.firstFailureAt > WINDOW_MS
      ? { failures: 0, firstFailureAt: now, lockedUntil: 0 }
      : record;

  fresh.failures++;
  if (fresh.failures >= MAX_FAILURES) fresh.lockedUntil = now + LOCKOUT_MS;
  attempts.set(client, fresh);

  return {
    ok: false,
    retryAfterSec: fresh.lockedUntil > now ? Math.ceil((fresh.lockedUntil - now) / 1000) : 0,
  };
}

/** Exposed for tests; lockouts are per-process and never persisted. */
export function resetSettingsAttempts(): void {
  attempts.clear();
}
