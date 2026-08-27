/**
 * Deciding what is worth interrupting someone for.
 *
 * The event log records everything; almost none of it deserves a notification.
 * Four filters stand between an event and a push, and each exists because
 * without it the feature becomes noise and gets muted — which is the same as
 * not having it:
 *
 *   what      only the four event kinds that mean something changed
 *   quality   a minimum score and a minimum confidence
 *   audience  the configured language preference, if there is one
 *   once      a high-water mark, so nothing is ever announced twice
 *
 * Quiet hours are honoured by holding events, not dropping them: waking up to
 * what happened overnight is useful, being woken by it is not.
 */
import { config } from '../config.ts';
import { createLogger, errFields } from '../logger.ts';
import * as repo from '../db/repo.ts';
import { nowSec } from '../core/types.ts';
import { createChannels } from './channels.ts';
import type { Notification, NotifyKind } from './types.ts';

const log = createLogger('notify');

/** Where the high-water mark lives, so a restart does not re-announce. */
const CURSOR_KEY = 'notify_last_event_id';

const EVENT_KIND: Readonly<Record<string, NotifyKind>> = {
  'trend.detected': 'viral',
  'creator.breakout': 'breakout',
  'manual.intervention.required': 'intervention',
};

interface EventPayload {
  state?: string;
  score?: number;
  ratio?: number;
  creator?: string | null;
  type?: string;
}

/** Local hour, because quiet hours are about the person, not about UTC. */
function inQuietHours(at: number): boolean {
  const [from, to] = config.notify.quietHours;
  if (from === to) return false;
  const hour = new Date(at * 1000).getHours();
  // A window that wraps past midnight, e.g. 23 to 8.
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

function describe(kind: NotifyKind, payload: EventPayload, item: repo.RankedRow | undefined): string {
  switch (kind) {
    case 'breakout': {
      const ratio = payload.ratio;
      return ratio === undefined
        ? 'far above what this account normally gets'
        : `${Math.round(ratio)}× what ${payload.creator ?? 'this account'} normally gets`;
    }
    case 'intervention':
      return `${payload.type ?? 'action'} needed before this source can run again`;
    case 'crossPlatform':
      return 'the same story on several platforms at once';
    default: {
      const velocity = item?.velocity;
      const state = payload.state ?? item?.state ?? 'moving';
      return velocity === null || velocity === undefined
        ? `now ${state.toLowerCase()}`
        : `now ${state.toLowerCase()}, gaining ${Math.round(velocity)} ${item?.primary_metric ?? ''}/hour`;
    }
  }
}

/**
 * Turns new events into notifications, applying every filter.
 *
 * Returns what *should* be sent without sending it, so the decision is
 * testable on its own.
 */
export function pending(): { items: Notification[]; cursor: number } {
  const since = Number(repo.kvGet(CURSOR_KEY) ?? 0);
  const events = repo.eventsSince(since, 200);
  if (events.length === 0) return { items: [], cursor: since };

  const cursor = events[events.length - 1]?.id ?? since;
  const languages = config.languages;
  const items: Notification[] = [];
  const seen = new Set<string>();

  for (const event of events) {
    const kind = EVENT_KIND[event.type];
    if (kind === undefined || !config.notify.kinds.includes(kind)) continue;

    const payload = (event.payload ?? {}) as EventPayload;

    // Something needing a human is always worth saying, and carries no item.
    if (kind === 'intervention') {
      items.push({
        kind,
        title: `${event.source ?? 'a source'} needs you`,
        reason: describe(kind, payload, undefined),
        url: null,
        source: event.source,
        score: null,
        at: event.ts,
      });
      continue;
    }

    if (event.ref_id === null || seen.has(event.ref_id)) continue;

    const row = repo.rankedContent({ limit: 1, offset: 0, ids: [event.ref_id] })[0];
    if (row === undefined) continue;

    if (row.score < config.notify.minScore) continue;
    if (row.confidence < config.notify.minConfidence) continue;
    // A trend in a language the user does not publish in is not their problem.
    if (languages.length > 0 && row.lang !== null && !languages.includes(row.lang)) continue;

    seen.add(event.ref_id);
    items.push({
      kind,
      title: row.title,
      reason: describe(kind, payload, row),
      url: row.url,
      source: row.source,
      score: row.score,
      at: event.ts,
    });
  }

  // Strongest first, and capped: a digest people read beats a wall they mute.
  items.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return { items: items.slice(0, config.notify.maxPerRun), cursor };
}

export interface NotifyResult {
  readonly considered: number;
  readonly sent: number;
  readonly channels: string[];
  readonly held: boolean;
}

/** Sends whatever is pending. Safe to call when nothing is configured. */
export async function dispatch(now = nowSec()): Promise<NotifyResult> {
  const channels = createChannels().filter((c) => c.configured);
  if (channels.length === 0) return { considered: 0, sent: 0, channels: [], held: false };

  const { items, cursor } = pending();
  if (items.length === 0) {
    // Still advance: events that matched nothing must not be reconsidered.
    repo.kvSet(CURSOR_KEY, String(cursor));
    return { considered: 0, sent: 0, channels: channels.map((c) => c.id), held: false };
  }

  // Held, not dropped: the cursor stays put so these arrive after quiet hours.
  if (inQuietHours(now)) {
    log.info('holding until quiet hours end', { items: items.length });
    return { considered: items.length, sent: 0, channels: channels.map((c) => c.id), held: true };
  }

  let sent = 0;
  for (const channel of channels) {
    try {
      await channel.send(items);
      sent++;
    } catch (e) {
      // A channel that is down must not cost the others their notification,
      // and must not advance the cursor past events nobody was told about.
      log.warn('channel failed', { channel: channel.id, ...errFields(e) });
    }
  }

  if (sent > 0) repo.kvSet(CURSOR_KEY, String(cursor));
  log.info('notified', { items: items.length, channels: sent });
  return { considered: items.length, sent: items.length, channels: channels.map((c) => c.id), held: false };
}

/** Sends one message so the user can confirm the setup actually works. */
export async function sendTest(): Promise<{ channels: string[]; errors: string[] }> {
  const channels = createChannels().filter((c) => c.configured);
  const errors: string[] = [];
  const sample: Notification[] = [
    {
      kind: 'viral',
      title: 'Test notification from Viral Radar',
      reason: 'if you can read this, notifications are working',
      url: `http://${config.server.host}:${config.server.port}`,
      source: 'viral-radar',
      score: 100,
      at: nowSec(),
    },
  ];

  for (const channel of channels) {
    try {
      await channel.send(sample);
    } catch (e) {
      errors.push(`${channel.id}: ${(e as Error).message}`);
    }
  }
  return { channels: channels.map((c) => c.id), errors };
}

export { inQuietHours };
