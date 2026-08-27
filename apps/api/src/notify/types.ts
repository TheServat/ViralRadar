/**
 * Notifications.
 *
 * The radar's whole value is noticing something early, which is worth nothing
 * if it only happens while someone is looking at the dashboard. This turns the
 * durable event log into a push, so the tool works when nobody is watching.
 *
 * Every channel is a plain HTTP POST. No dependency, no daemon, no account
 * beyond the one the user already has.
 */

export const NOTIFY_KINDS = ['viral', 'breakout', 'crossPlatform', 'intervention'] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

export interface Notification {
  readonly kind: NotifyKind;
  readonly title: string;
  /** One line saying why this is worth interrupting someone for. */
  readonly reason: string;
  readonly url: string | null;
  readonly source: string | null;
  readonly score: number | null;
  readonly at: number;
}

export interface NotifyChannel {
  readonly id: string;
  /** False when the channel has no credentials; it is then simply skipped. */
  readonly configured: boolean;
  /**
   * Sends one batch. Batched rather than one message per item on purpose: when
   * twenty things move at once, twenty separate pings are noise, not news.
   */
  send(batch: readonly Notification[]): Promise<void>;
}
