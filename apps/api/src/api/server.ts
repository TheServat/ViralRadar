/**
 * HTTP server: plain `node:http` with a small router.
 *
 * Binds to 127.0.0.1 by default, so the default deployment is not reachable
 * from the network at all. If HOST is widened, API_TOKEN becomes mandatory -
 * the server refuses to start otherwise rather than quietly exposing the data.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config, ROOT } from '../config.ts';
import { createLogger, errFields } from '../logger.ts';
import { err, isRadarError } from '../errors.ts';
import { createHandlers } from './routes.ts';
import { checkSettingsPassword, isSettingsProtected } from './gate.ts';
import * as repo from '../db/repo.ts';
import type { Scheduler } from '../pipeline/scheduler.ts';

const log = createLogger('http');
/** The built dashboard: `apps/web` is the Vue source, `apps/web/dist` ships. */
const WEB_ROOT = resolve(ROOT, 'apps', 'web', 'dist');

// ── Security ───────────────────────────────────────────────────────────────

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  // Thumbnails come from platform CDNs, so remote images are allowed; nothing
  // else may be loaded, and no script may come from anywhere but this server.
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    'img-src https: data:',
    // The bundle ships its own icon font; nothing is fetched from a CDN.
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; '),
};

/** Naive fixed-window limiter. Enough for a single-user local service. */
const requestCounts = new Map<string, { count: number; windowStart: number }>();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 600;

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = requestCounts.get(ip);
  if (entry === undefined || now - entry.windowStart > RATE_WINDOW_MS) {
    requestCounts.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count++;
  return entry.count > RATE_MAX;
}

function authorised(req: IncomingMessage, url: URL): boolean {
  if (config.server.apiToken === '') return true;
  const header = req.headers['x-radar-token'];
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const supplied = (Array.isArray(header) ? header[0] : header) ?? bearer ?? url.searchParams.get('token') ?? '';
  return supplied === config.server.apiToken;
}

// ── Routing ────────────────────────────────────────────────────────────────

type Handler = (ctx: {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  req: IncomingMessage;
  res: ServerResponse;
}) => unknown | Promise<unknown>;

interface Route {
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly pattern: readonly string[];
  readonly handler: Handler;
  /** Handler writes the response itself (SSE). */
  readonly raw?: boolean;
  /** Parse a JSON request body before dispatching. */
  readonly json?: boolean;
  /** Requires the settings password, when one is configured. */
  readonly gated?: boolean;
}

function match(pattern: readonly string[], parts: readonly string[]): Record<string, string> | null {
  if (pattern.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i] as string;
    const value = parts[i] as string;
    if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(value);
    else if (p !== value) return null;
  }
  return params;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
  });
  res.end(payload);
}

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.map': 'application/json; charset=utf-8',
};

function sendFile(target: string, res: ServerResponse, immutable: boolean): void {
  res.writeHead(200, {
    'Content-Type': MIME[extname(target)] ?? 'application/octet-stream',
    // Vite fingerprints its assets, so those can be cached hard while the
    // entry document must never be.
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    ...SECURITY_HEADERS,
  });
  createReadStream(target).pipe(res);
}

/**
 * Serves the built dashboard.
 *
 * Any path that is not a real file falls back to `index.html`, because the
 * router lives in the browser: a reload on /trends must not 404.
 */
function serveStatic(pathname: string, res: ServerResponse): boolean {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  // normalize + prefix check: the classic traversal guard, applied before any
  // filesystem call rather than after.
  const target = resolve(join(WEB_ROOT, normalize(relative)));

  if (target.startsWith(WEB_ROOT) && existsSync(target) && statSync(target).isFile()) {
    sendFile(target, res, relative.startsWith('assets/'));
    return true;
  }

  const index = join(WEB_ROOT, 'index.html');
  if (!pathname.includes('.') && existsSync(index)) {
    sendFile(index, res, false);
    return true;
  }
  return false;
}

/** The dashboard has to be built before it can be served. Say so clearly. */
function dashboardMissing(res: ServerResponse): void {
  const html = `<!doctype html><meta charset="utf-8"><title>Viral Radar</title>
    <style>body{font:15px/1.6 system-ui;margin:0;display:grid;place-items:center;height:100vh;
    background:#0b0d12;color:#e6e9f0}div{max-width:46ch;padding:28px}code{background:#161a24;
    padding:2px 6px;border-radius:5px;color:#5b8cff}</style>
    <div><h1>Dashboard not built yet</h1>
    <p>The API is running. To build the interface once:</p>
    <p><code>npm run build</code></p>
    <p>Until then everything is still reachable at
    <code>/api/v1/dashboard</code>.</p></div>`;
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
  });
  res.end(html);
}

/** Reads a JSON request body, with a hard size limit. */
async function readJsonBody(req: IncomingMessage, limitBytes = 256 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limitBytes) throw err.validation('Request body is too large');
    chunks.push(buf);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw err.validation('Request body is not valid JSON');
  }
}

// ── Server ─────────────────────────────────────────────────────────────────

export function createApiServer(scheduler: Scheduler | null) {
  const h = createHandlers(scheduler);

  const routes: Route[] = [
    { method: 'GET', pattern: ['api', 'v1', 'dashboard'], handler: () => h.dashboard() },
    { method: 'GET', pattern: ['api', 'v1', 'trends'], handler: ({ query }) => h.trends(query) },
    { method: 'GET', pattern: ['api', 'v1', 'trends', 'viral'], handler: ({ query }) => h.viral(query) },
    { method: 'GET', pattern: ['api', 'v1', 'trends', 'emerging'], handler: ({ query }) => h.emerging(query) },
    { method: 'GET', pattern: ['api', 'v1', 'trends', 'rising'], handler: ({ query }) => h.rising(query) },
    { method: 'GET', pattern: ['api', 'v1', 'trends', 'cross-platform'], handler: ({ query }) => h.crossPlatform(query) },
    { method: 'GET', pattern: ['api', 'v1', 'clusters'], handler: ({ query }) => h.clusters(query) },
    { method: 'GET', pattern: ['api', 'v1', 'clusters', ':id'], handler: ({ params }) => h.cluster(params['id'] as string) },
    { method: 'GET', pattern: ['api', 'v1', 'content', ':id'], handler: ({ params }) => h.content(params['id'] as string) },
    { method: 'GET', pattern: ['api', 'v1', 'creators', 'breakouts'], handler: ({ query }) => h.breakouts(query) },
    { method: 'GET', pattern: ['api', 'v1', 'hashtags'], handler: ({ query }) => h.hashtags(query) },
    { method: 'GET', pattern: ['api', 'v1', 'sources'], handler: () => h.sources() },
    { method: 'POST', pattern: ['api', 'v1', 'sources', ':id', 'run'], handler: ({ params }) => h.runSource(params['id'] as string) },
    { method: 'GET', pattern: ['api', 'v1', 'system', 'health'], handler: () => h.health() },
    { method: 'GET', pattern: ['api', 'v1', 'system', 'interventions'], handler: () => h.interventions() },
    { method: 'POST', pattern: ['api', 'v1', 'system', 'interventions', ':id', 'resolve'], handler: ({ params }) => h.resolveIntervention(params['id'] as string) },
    { method: 'GET', pattern: ['api', 'v1', 'events'], handler: ({ query }) => h.events(query) },
    { method: 'GET', pattern: ['api', 'v1', 'reports'], handler: ({ query }) => h.reports(query) },
    // Raw: this one writes a file, not JSON.
    {
      method: 'GET',
      pattern: ['api', 'v1', 'export'],
      raw: true,
      handler: ({ query, res }) => {
        const file = h.exportContent(query);
        res.writeHead(200, {
          'Content-Type': file.type,
          // `attachment` so a browser saves it instead of rendering CSV as text.
          'Content-Disposition': `attachment; filename="${file.filename}"`,
          'Cache-Control': 'no-store',
        });
        res.end(file.body);
        return null;
      },
    },
    { method: 'GET', pattern: ['api', 'v1', 'missed'], handler: ({ query }) => h.missed(query) },
    {
      method: 'POST',
      pattern: ['api', 'v1', 'content', ':id', 'archive'],
      json: true,
      handler: ({ params, body }) => h.archive(params['id'] as string, body),
    },
    {
      method: 'DELETE',
      pattern: ['api', 'v1', 'content', ':id', 'archive'],
      handler: ({ params }) => h.unarchive(params['id'] as string),
    },
    { method: 'GET', pattern: ['api', 'v1', 'reports', 'formats'], handler: ({ query }) => h.formats(query) },
    { method: 'GET', pattern: ['api', 'v1', 'reports', 'timing'], handler: ({ query }) => h.timing(query) },
    { method: 'GET', pattern: ['api', 'v1', 'reports', 'terms'], handler: ({ query }) => h.terms(query) },
    { method: 'GET', pattern: ['api', 'v1', 'reports', 'thumbnails'], handler: ({ query }) => h.thumbnails(query) },
    { method: 'GET', pattern: ['api', 'v1', 'facets'], handler: () => h.facets() },
    { method: 'GET', pattern: ['api', 'v1', 'creators'], handler: ({ query }) => h.creators(query) },
    // Unlocked on purpose: the dashboard has to know whether to ask for a
    // password before it can ask for one. It reveals only that a gate exists.
    { method: 'GET', pattern: ['api', 'v1', 'system', 'settings', 'status'], handler: () => ({ protected: isSettingsProtected() }) },
    { method: 'GET', pattern: ['api', 'v1', 'system', 'settings'], gated: true, handler: () => h.settings() },
    { method: 'POST', pattern: ['api', 'v1', 'system', 'settings'], gated: true, json: true, handler: ({ body }) => h.saveSettings(body) },
    { method: 'POST', pattern: ['api', 'v1', 'system', 'analyze'], handler: () => h.triggerAnalyze() },
    { method: 'POST', pattern: ['api', 'v1', 'system', 'collect'], handler: () => h.triggerCollect() },
    { method: 'GET', pattern: ['api', 'v1', 'system', 'interests'], handler: () => h.interests() },
    { method: 'GET', pattern: ['api', 'v1', 'system', 'notify'], handler: () => h.notifyStatus() },
    { method: 'GET', pattern: ['api', 'v1', 'system', 'embedding'], handler: () => h.embeddingStatus() },
    // Gated: sending a test proves a credential works, so it is a settings action.
    { method: 'POST', pattern: ['api', 'v1', 'system', 'notify', 'test'], gated: true, handler: () => h.notifyTest() },
    { method: 'GET', pattern: ['api', 'v1', 'stream'], raw: true, handler: ({ req, res }) => streamEvents(req, res) },
  ];

  return createServer((req, res) => {
    const requestId = randomUUID().slice(0, 8);
    const started = Date.now();
    const ip = req.socket.remoteAddress ?? 'unknown';

    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const pathname = url.pathname;

        if (rateLimited(ip)) {
          json(res, 429, { error: 'rate limited', requestId });
          return;
        }

        // The dashboard is same-origin only: no CORS headers are emitted, so a
        // page on another origin cannot read any of this.
        if (req.method === 'OPTIONS') {
          res.writeHead(204, SECURITY_HEADERS);
          res.end();
          return;
        }

        if (pathname.startsWith('/api/')) {
          if (!authorised(req, url)) {
            json(res, 401, { error: 'invalid or missing API token', requestId });
            return;
          }
          const parts = pathname.split('/').filter((p) => p.length > 0);
          for (const route of routes) {
            if (route.method !== req.method) continue;
            const params = match(route.pattern, parts);
            if (params === null) continue;

            if (route.gated === true) {
              const header = req.headers['x-settings-password'];
              const supplied = (Array.isArray(header) ? header[0] : header) ?? null;
              const gate = checkSettingsPassword(supplied, ip);
              if (!gate.ok) {
                if (gate.retryAfterSec > 0) res.setHeader('Retry-After', gate.retryAfterSec);
                json(res, gate.retryAfterSec > 0 ? 429 : 401, {
                  error: gate.retryAfterSec > 0 ? 'too many attempts' : 'settings password required',
                  retryAfterSec: gate.retryAfterSec,
                  requestId,
                });
                return;
              }
            }

            const body = route.json === true ? await readJsonBody(req) : undefined;
            const result = await route.handler({ params, query: url.searchParams, body, req, res });
            if (route.raw === true) return;
            if (result === null) {
              json(res, 404, { error: 'not found', requestId });
              return;
            }
            json(res, 200, result);
            log.debug('request', { requestId, method: req.method, path: pathname, ms: Date.now() - started });
            return;
          }
          json(res, 404, { error: `no route for ${req.method} ${pathname}`, requestId });
          return;
        }

        if (req.method === 'GET') {
          if (serveStatic(pathname, res)) return;
          if (pathname === '/' || !pathname.includes('.')) {
            dashboardMissing(res);
            return;
          }
        }
        json(res, 404, { error: 'not found', requestId });
      } catch (e) {
        const status = isRadarError(e)
          ? e.kind === 'VALIDATION'
            ? 400
            : e.kind === 'AUTH_REQUIRED'
              ? 401
              : e.kind === 'RATE_LIMIT'
                ? 429
                : 500
          : 500;
        log.error('request failed', { requestId, path: req.url, ...errFields(e) });
        if (!res.headersSent) {
          json(res, status, {
            error: isRadarError(e) ? e.message : 'internal error',
            kind: isRadarError(e) ? e.kind : 'INTERNAL',
            requestId,
          });
        }
      }
    })();
  });
}

/**
 * Server-sent events. The event log is already durable in SQLite, so the stream
 * is a tail of that table rather than a second delivery mechanism that could
 * disagree with it.
 */
function streamEvents(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    ...SECURITY_HEADERS,
  });
  res.write(`retry: 5000\n\n`);

  let lastId = repo.latestEventId();
  const tick = setInterval(() => {
    try {
      const events = repo.eventsSince(lastId, 40);
      for (const event of events) {
        lastId = event.id;
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      if (events.length === 0) res.write(': keep-alive\n\n');
    } catch (e) {
      log.warn('stream tick failed', errFields(e));
    }
  }, 3000);

  req.on('close', () => clearInterval(tick));
}

export function assertServerConfigIsSafe(): void {
  const localOnly = config.server.host === '127.0.0.1' || config.server.host === 'localhost' || config.server.host === '::1';
  if (!localOnly && config.server.apiToken === '') {
    console.error(
      `\n  Refusing to start: HOST=${config.server.host} exposes the API beyond this machine and API_TOKEN is empty.\n` +
        '  Set API_TOKEN in .env, or leave HOST at 127.0.0.1.\n',
    );
    process.exit(1);
  }
}
