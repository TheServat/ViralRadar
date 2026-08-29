/**
 * What the radar can be asked.
 *
 * These are shaped around the questions a person making content actually has —
 * "what should I make today", "what shape should it be", "when do I post it" —
 * rather than around the tables underneath. A tool named after a database
 * concept makes the model do the translation, and it does it badly.
 *
 * Everything goes through the HTTP API rather than the database directly. Three
 * reasons: the query logic already lives there and duplicating it would let the
 * two drift; the analysis pass holds long write transactions and a second
 * process reading through them invites lock contention; and if the radar is not
 * running, "start it" is a far better answer than a stale read.
 *
 * Results are rendered as text, not JSON. The model reasons over prose, and a
 * table of numbers with its units spelled out is more useful to it than a
 * nested object it has to interpret.
 */
import { config } from '../config.ts';
import type { McpServer, ToolDefinition, ToolResult } from './protocol.ts';

const BASE = `http://${config.server.host === '0.0.0.0' ? '127.0.0.1' : config.server.host}:${config.server.port}/api/v1`;

/** Reads from the running radar, with a legible answer when it is not up. */
async function api(path: string): Promise<{ ok: true; data: unknown } | { ok: false; why: string }> {
  try {
    const headers: Record<string, string> = {};
    // The radar refuses to serve a bound-to-network instance without this.
    if (config.server.apiToken !== '') headers['X-Radar-Token'] = config.server.apiToken;

    const res = await fetch(`${BASE}${path}`, { headers, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return { ok: false, why: `the radar answered ${res.status} for ${path}` };
    return { ok: true, data: await res.json() };
  } catch {
    return {
      ok: false,
      why: `the radar is not answering on ${BASE}. Start it with "npm start" in the project directory.`,
    };
  }
}

// ── Rendering ──────────────────────────────────────────────────────────────

function num(value: unknown, places = 0): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(places) : '—';
}

interface TrendItem {
  title: string;
  url: string;
  source: string;
  state: string;
  score: number;
  confidence: number;
  ageHours: number | null;
  relevance?: number | null;
  creator?: { name: string | null; followers: number | null };
  language?: { code: string | null };
  signals?: { velocity: number | null; acceleration: number | null; creatorAnomaly: number | null };
  metrics?: { primary: { name: string; value: number | null } };
}

function renderItems(items: readonly TrendItem[], showWhy = true): string {
  if (items.length === 0) return 'Nothing matched.';
  return items
    .map((it, i) => {
      const bits: string[] = [];
      bits.push(`${i + 1}. ${it.title}`);
      bits.push(`   ${it.url}`);

      const facts = [
        `score ${num(it.score, 1)}/100`,
        `confidence ${num(it.confidence, 2)}`,
        it.state.toLowerCase(),
        it.language?.code ? `lang ${it.language.code}` : '',
        it.ageHours === null ? '' : `${num(it.ageHours, 1)}h old`,
        it.creator?.name ? `by ${it.creator.name}` : '',
      ].filter((s) => s !== '');
      bits.push(`   ${facts.join(' · ')}`);

      if (showWhy) {
        const s: NonNullable<TrendItem['signals']> =
          it.signals ?? { velocity: null, acceleration: null, creatorAnomaly: null };
        const why = [
          s.velocity ? `${num(s.velocity)} ${it.metrics?.primary.name ?? ''}/hour` : '',
          s.acceleration ? `accelerating ${num(s.acceleration)}` : '',
          s.creatorAnomaly && s.creatorAnomaly > 2 ? `${num(s.creatorAnomaly, 1)}x this creator's normal` : '',
        ].filter((x) => x !== '');
        if (why.length > 0) bits.push(`   why: ${why.join(', ')}`);
      }
      return bits.join('\n');
    })
    .join('\n\n');
}

/** Query string from defined arguments only, so an unset filter never appears. */
function qs(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const s = search.toString();
  return s === '' ? '' : `?${s}`;
}

const LANG_ARG = {
  type: 'string',
  description: "Language code such as 'fa' or 'en'. Omit to use the configured preference; 'all' to clear it.",
};

// ── The tools ──────────────────────────────────────────────────────────────

const DEFINITIONS: ToolDefinition[] = [
  {
    name: 'trending_now',
    description:
      'What is spreading right now, strongest first. The general question — use whats_rising instead to catch things earlier, while they are still climbing.',
    inputSchema: {
      type: 'object',
      properties: {
        lang: LANG_ARG,
        country: { type: 'string', description: "Two-letter country code, e.g. 'IR'." },
        source: { type: 'string', description: "Platform, e.g. 'youtube' or 'googletrends'." },
        limit: { type: 'number', description: 'How many to return. Default 15.' },
      },
    },
  },
  {
    name: 'whats_rising',
    description:
      'Things still climbing, ordered by acceleration rather than size. This is what finds a small item mid-explosion, before it has finished happening — the most useful list for deciding what to make today.',
    inputSchema: {
      type: 'object',
      properties: { lang: LANG_ARG, country: { type: 'string' }, limit: { type: 'number' } },
    },
  },
  {
    name: 'topics',
    description:
      'Stories grouped across platforms and languages. A topic carried by several platforms at once is stronger evidence than any single post.',
    inputSchema: {
      type: 'object',
      properties: {
        lang: LANG_ARG,
        minSources: { type: 'number', description: 'Platforms a topic must appear on. Default 1.' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'creator_breakouts',
    description:
      "Posts doing far better than their own account normally does. Finds a small channel exploding rather than a big channel being big — measured against that creator's own history, not against the platform.",
    inputSchema: {
      type: 'object',
      properties: { hours: { type: 'number', description: 'Look-back window. Default 48.' }, limit: { type: 'number' } },
    },
  },
  {
    name: 'what_shape_wins',
    description:
      'What form of content performs best for a given audience: title length, content type, and what the title contains. Every figure is measured against typical content on the same platform, and only differences the data can actually support are reported.',
    inputSchema: {
      type: 'object',
      properties: {
        lang: LANG_ARG,
        country: { type: 'string' },
        source: { type: 'string' },
      },
    },
  },
  {
    name: 'best_time_to_post',
    description:
      'Which hours and days performed best, with the effect of age removed — older items rank lower regardless of when they were posted, and that is subtracted before anything is compared.',
    inputSchema: { type: 'object', properties: { lang: LANG_ARG, country: { type: 'string' } } },
  },
  {
    name: 'for_my_channel',
    description:
      'What is trending that actually fits what this user makes, matched by meaning against the channel description in their settings rather than by keyword. Use this when they ask what THEY should make, as opposed to what is trending generally.',
    inputSchema: {
      type: 'object',
      properties: {
        minScore: { type: 'number', description: 'Ignore items below this score. Default 30.' },
        lang: LANG_ARG,
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'search_radar',
    description: 'Free-text search across everything the radar has collected.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to look for in titles.' },
        lang: LANG_ARG,
        limit: { type: 'number' },
      },
      required: ['query'],
    },
  },
  {
    name: 'radar_status',
    description:
      'Whether the radar is running and healthy: how much it has collected, when it last ran, and which optional features are on.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ── Handlers ───────────────────────────────────────────────────────────────

interface Page {
  items?: TrendItem[];
}

async function trendingNow(a: Record<string, unknown>): Promise<string> {
  const r = await api(`/trends${qs({ lang: a['lang'], country: a['country'], source: a['source'], limit: a['limit'] ?? 15 })}`);
  if (!r.ok) return r.why;
  return renderItems((r.data as Page).items ?? []);
}

async function whatsRising(a: Record<string, unknown>): Promise<string> {
  const r = await api(`/trends/rising${qs({ lang: a['lang'], country: a['country'], limit: a['limit'] ?? 15 })}`);
  if (!r.ok) return r.why;
  const items = (r.data as Page).items ?? [];
  return `Ordered by acceleration — how fast the growth itself is speeding up, not by size.\n\n${renderItems(items)}`;
}

interface Cluster {
  label: string;
  score: number;
  itemCount: number;
  platformCount: number;
  sources: string[];
  languages: { code: string; pct: number }[];
}

async function topics(a: Record<string, unknown>): Promise<string> {
  const r = await api(`/clusters${qs({ lang: a['lang'], minSources: a['minSources'] ?? 1, limit: a['limit'] ?? 12 })}`);
  if (!r.ok) return r.why;
  const items = ((r.data as { items?: Cluster[] }).items ?? []).map(
    (c, i) =>
      `${i + 1}. ${c.label}\n   score ${num(c.score, 1)} · ${c.itemCount} posts across ${c.platformCount} platform(s): ${c.sources.join(', ')}` +
      (c.languages.length > 0 ? `\n   languages: ${c.languages.map((l) => `${l.code} ${l.pct}%`).join(', ')}` : ''),
  );
  return items.length === 0 ? 'No topics matched.' : items.join('\n\n');
}

async function breakouts(a: Record<string, unknown>): Promise<string> {
  const r = await api(`/creators/breakouts${qs({ hours: a['hours'] ?? 48, limit: a['limit'] ?? 12 })}`);
  if (!r.ok) return r.why;
  const items = (r.data as Page).items ?? [];
  if (items.length === 0) {
    return 'No breakouts. That can mean nothing broke out, or that not enough creators have a baseline yet — radar_status reports which.';
  }
  return renderItems(items);
}

interface Bucket {
  key: string;
  n: number;
  lift: number;
  margin: number;
  significant: boolean;
  thin: boolean;
}
interface Analysis {
  n: number;
  baseline: number;
  minSample: number;
  groups: { key: string; buckets: Bucket[] }[];
  findings: Bucket[];
  timezone?: string;
  ageSpread?: number;
}

function renderFindings(d: Analysis, unit: string): string {
  if (d.n < 40) {
    return `Only ${d.n} items qualify — too few to say anything honest. More will accumulate as the radar runs.`;
  }
  const lines = [
    `Based on ${d.n} items. "Typical" here is the ${num(d.baseline, 1)}th percentile of these platforms, and every figure below is measured from there.`,
    '',
  ];

  if (d.findings.length === 0) {
    lines.push('Nothing stands out. Every difference so far is within what chance alone would produce — which is itself worth knowing.');
  } else {
    lines.push('Differences the data actually supports:');
    for (const f of d.findings.slice(0, 8)) {
      const dir = f.lift > 0 ? 'better' : 'worse';
      lines.push(`  ${f.key}: ${dir} by ${num(Math.abs(f.lift), 1)} ${unit} (±${num(f.margin, 1)}, from ${f.n} items)`);
    }
  }

  const thin = d.groups.flatMap((g) => g.buckets).filter((b) => b.thin).length;
  if (thin > 0) lines.push('', `${thin} group(s) had under ${d.minSample} items and were not judged.`);
  lines.push('', 'These did better; that is not the same as these caused it. Title length travels with content type, which travels with platform.');
  return lines.join('\n');
}

async function whatShapeWins(a: Record<string, unknown>): Promise<string> {
  const r = await api(`/reports/formats${qs({ lang: a['lang'], country: a['country'], source: a['source'] })}`);
  if (!r.ok) return r.why;
  return renderFindings(r.data as Analysis, 'points');
}

async function bestTime(a: Record<string, unknown>): Promise<string> {
  const r = await api(`/reports/timing${qs({ lang: a['lang'], country: a['country'] })}`);
  if (!r.ok) return r.why;
  const d = r.data as Analysis;
  const head = `Hours are in ${d.timezone ?? 'the configured timezone'}. Age accounted for ${num(d.ageSpread, 1)} points of spread and has been subtracted, so an hour cannot look good merely for holding newer items.\n`;
  return `${head}\n${renderFindings(d, 'points')}`;
}

async function searchRadar(a: Record<string, unknown>): Promise<string> {
  const query = typeof a['query'] === 'string' ? a['query'] : '';
  if (query === '') return 'search_radar needs a query.';
  const r = await api(`/trends${qs({ q: query, lang: a['lang'], limit: a['limit'] ?? 15 })}`);
  if (!r.ok) return r.why;
  return renderItems((r.data as Page).items ?? [], false);
}

interface Health {
  db: { content: number; metrics: number; clusters: number; creators: number };
  lastDiscovery: number | null;
  lastAnalysis?: number | null;
}

async function status(): Promise<string> {
  const health = await api('/system/health');
  if (!health.ok) return health.why;
  const h = health.data as Health;

  const when = (t: number | null | undefined): string =>
    t === null || t === undefined ? 'never' : new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 16);

  const lines = [
    'The radar is running.',
    '',
    `  content stored : ${h.db.content}`,
    `  measurements   : ${h.db.metrics}`,
    `  topics         : ${h.db.clusters}`,
    `  creators       : ${h.db.creators}`,
    `  last collection: ${when(h.lastDiscovery)} UTC`,
  ];

  const embed = await api('/system/embedding');
  if (embed.ok) {
    const e = embed.data as { enabled: boolean; verified: boolean; model: string; coverage: { embedded: number; total: number } | null };
    lines.push(
      '',
      e.enabled
        ? `  cross-language topics: ${e.verified ? 'on' : 'REFUSED — the model failed its own check'} (${e.model}, ${e.coverage?.embedded ?? 0}/${e.coverage?.total ?? 0} embedded)`
        : '  cross-language topics: off (no embedding model configured)',
    );
  }
  return lines.join('\n');
}

async function forMyChannel(a: Record<string, unknown>): Promise<string> {
  const state = await api('/system/interests');
  if (state.ok) {
    const s = state.data as { enabled: boolean; reason: string | null; interests: string };
    if (!s.enabled) {
      return `Subject matching is off: ${s.reason ?? 'not configured'}. Set INTERESTS in the settings to a sentence describing the channel.`;
    }
  }

  const r = await api(
    `/trends${qs({ sort: 'relevance', minScore: a['minScore'] ?? 30, lang: a['lang'], limit: a['limit'] ?? 12 })}`,
  );
  if (!r.ok) return r.why;
  const items = (r.data as Page).items ?? [];
  if (items.length === 0) return 'Nothing matched. Try a lower minScore.';

  const rendered = items
    .map((it, i) => {
      const match = it.relevance === null || it.relevance === undefined ? '—' : `${Math.round(it.relevance * 100)}%`;
      return `${i + 1}. ${it.title}\n   ${it.url}\n   match ${match} · score ${num(it.score, 1)}/100 · ${it.state.toLowerCase()}`;
    })
    .join('\n\n');

  return `Ordered by how close each item is to the channel description, not by score.\nMatch is a similarity between two pieces of text, not a judgement about quality.\n\n${rendered}`;
}

const HANDLERS: Record<string, (a: Record<string, unknown>) => Promise<string>> = {
  for_my_channel: forMyChannel,
  trending_now: trendingNow,
  whats_rising: whatsRising,
  topics,
  creator_breakouts: breakouts,
  what_shape_wins: whatShapeWins,
  best_time_to_post: bestTime,
  search_radar: searchRadar,
  radar_status: status,
};

export function createRadarMcpServer(): McpServer {
  return {
    name: 'viral-radar',
    version: '1.0.0',
    tools: DEFINITIONS,
    async call(name, args): Promise<ToolResult> {
      const handler = HANDLERS[name];
      if (handler === undefined) {
        return { text: `Unknown tool: ${name}`, isError: true };
      }
      try {
        return { text: await handler(args) };
      } catch (e) {
        return { text: e instanceof Error ? e.message : String(e), isError: true };
      }
    },
  };
}
