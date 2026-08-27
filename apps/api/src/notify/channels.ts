/**
 * Where notifications go.
 *
 * Telegram because it is the one messenger most people already have open, and
 * a generic webhook because it reaches everything else — Discord, Slack, ntfy,
 * Home Assistant, a shell script behind a tiny server.
 */
import { config } from '../config.ts';
import { request } from '../net/fetcher.ts';
import type { Notification, NotifyChannel } from './types.ts';

const ICON: Readonly<Record<string, string>> = {
  viral: '🔥',
  breakout: '🚀',
  crossPlatform: '🌍',
  intervention: '⚠️',
};

/**
 * Telegram treats these as markup, so they have to be escaped in body text.
 * The quote is escaped as well because one of the call sites puts a value
 * inside `href="…"`, where a bare quote would end the attribute and let a
 * crafted URL add its own.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function line(item: Notification): string {
  const icon = ICON[item.kind] ?? '•';
  const score = item.score === null ? '' : ` <b>${Math.round(item.score)}</b>`;
  const where = item.source === null ? '' : ` · ${escapeHtml(item.source)}`;
  const title = escapeHtml(item.title.slice(0, 160));
  const head = item.url === null ? title : `<a href="${escapeHtml(item.url)}">${title}</a>`;
  return `${icon}${score}${where}\n${head}\n<i>${escapeHtml(item.reason)}</i>`;
}

function createTelegram(): NotifyChannel {
  const token = config.notify.telegramBotToken;
  const chat = config.notify.telegramChatId;

  return {
    id: 'telegram',
    configured: token !== '' && chat !== '',

    async send(batch) {
      if (batch.length === 0) return;
      const text = [`<b>Viral Radar</b> · ${batch.length}`, '', ...batch.map(line)].join('\n\n');

      await request(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chat,
          text: text.slice(0, 4000),
          parse_mode: 'HTML',
          // The links are the point of the message, not decoration to preview.
          disable_web_page_preview: true,
        }),
        context: 'notify-telegram',
        rps: 1,
        retries: 1,
      });
    },
  };
}

/**
 * A generic webhook.
 *
 * The payload carries the structured items rather than a rendered string, so
 * whatever receives it can decide how to present them. A `text` field is
 * included too, because Discord and Slack both accept exactly that shape.
 */
function createWebhook(): NotifyChannel {
  const url = config.notify.webhookUrl;

  return {
    id: 'webhook',
    configured: url !== '',

    async send(batch) {
      if (batch.length === 0) return;
      const text = batch
        .map((n) => `${ICON[n.kind] ?? '•'} ${n.title}${n.url === null ? '' : ` — ${n.url}`}`)
        .join('\n');

      await request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: text.slice(0, 1900), // Discord's field name and its limit.
          text: text.slice(0, 1900), // Slack's.
          source: 'viral-radar',
          count: batch.length,
          items: batch,
        }),
        context: 'notify-webhook',
        rps: 1,
        retries: 1,
      });
    },
  };
}

export function createChannels(): NotifyChannel[] {
  return [createTelegram(), createWebhook()].filter((channel) =>
    config.notify.channels.includes(channel.id),
  );
}

export { line as formatNotification, escapeHtml };
