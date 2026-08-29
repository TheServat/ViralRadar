#!/usr/bin/env node
/**
 * Entry point and CLI.
 *
 *   radar serve            start the dashboard and the background scheduler
 *   radar collect [source] run discovery once, optionally for one source
 *   radar refresh [tier]   re-read metrics for known items (HOT | NORMAL)
 *   radar analyze          recompute scores, clusters and baselines
 *   radar top [n]          print the current top items to the terminal
 *   radar sources          list plugins with their configuration status
 *   radar doctor           check configuration, database and connectivity
 *   radar cleanup          apply the retention policy now
 *   radar reclassify       re-run language and keyword detection over stored items
 *   radar mcp              expose the radar to an AI assistant over MCP (stdio)
 *   radar install          run in the background from now on, and add a shortcut
 *   radar uninstall        stop doing that; settings and data are left alone
 *   radar open             open the dashboard in a browser
 */
import { spawnSync } from 'node:child_process';
import { config } from './config.ts';
import { createLogger } from './logger.ts';
import { closeDb, db } from './db/db.ts';
import * as repo from './db/repo.ts';
import { analyze, runCleanup } from './pipeline/analyze.ts';
import { collectAll, collectOne, reclassifyAll, refreshMetrics } from './pipeline/collect.ts';
import { createScheduler } from './pipeline/scheduler.ts';
import { assertServerConfigIsSafe, createApiServer } from './api/server.ts';
import { allPlugins, statusOf } from './sources/registry.ts';
import { nowSec } from './core/types.ts';
import { isPackaged } from './embedded.ts';

const log = createLogger('main');

// ── Outbound routing ───────────────────────────────────────────────────────

/**
 * Node applies proxy settings at startup, before any of this code runs, so a
 * proxy configured in .env needs one re-exec with the flag enabled. Done once,
 * visibly, rather than by asking the user to remember a flag.
 */
function applyNetworkMode(): void {
  if (config.net.mode === 'DIRECT') return;

  if (config.net.mode === 'SOCKS5') {
    console.error(
      '\n  NETWORK_MODE=SOCKS5 needs a SOCKS-capable dispatcher that Node does not ship with.\n' +
        '  Point PROXY_URL at your client HTTP port instead and set NETWORK_MODE=HTTP_PROXY:\n' +
        '    - Xray / V2Ray: the http inbound, usually http://127.0.0.1:10809\n' +
        '    - Tor: add "HTTPTunnelPort 9080" to torrc, then http://127.0.0.1:9080\n',
    );
    process.exit(1);
  }

  if (process.env['NODE_USE_ENV_PROXY'] === '1') return;

  log.info('restarting with proxy routing enabled', { proxy: config.net.proxyUrl.replace(/:[^:@/]+@/, ':***@') });
  const result = spawnSync(
    process.execPath,
    ['--use-env-proxy', ...process.argv.slice(1)],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_USE_ENV_PROXY: '1',
        HTTP_PROXY: config.net.proxyUrl,
        HTTPS_PROXY: config.net.proxyUrl,
        // Never send local traffic through the proxy.
        NO_PROXY: 'localhost,127.0.0.1,::1',
      },
    },
  );
  process.exit(result.status ?? 0);
}

// ── Commands ───────────────────────────────────────────────────────────────

async function serve(): Promise<void> {
  assertServerConfigIsSafe();
  db();

  const scheduler = createScheduler();
  const server = createApiServer(scheduler);

  // Starting it twice is an ordinary mistake, not a crash worth a stack trace.
  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') {
      console.error(
        `\n  Port ${config.server.port} is already in use.\n\n` +
          `  Viral Radar is probably already running - open http://${config.server.host}:${config.server.port}\n` +
          `  Otherwise change PORT in .env, or stop the other process.\n`,
      );
      process.exit(1);
    }
    log.error('server error', { error: e.message, code: e.code });
    process.exit(1);
  });

  server.listen(config.server.port, config.server.host, () => {
    const url = `http://${config.server.host}:${config.server.port}`;
    console.log(`\n  Viral Radar is running\n`);
    console.log(`   dashboard   ${url}`);
    console.log(`   api         ${url}/api/v1/dashboard`);
    console.log(`   sources     ${activeSummary()}`);
    console.log(`   auth        ${config.server.apiToken === '' ? 'none (local only)' : 'API token required'}\n`);
    scheduler.start();
  });

  const shutdown = (signal: string): void => {
    log.info('shutting down', { signal });
    scheduler.stop();
    server.close(() => {
      closeDb();
      process.exit(0);
    });
    // Do not hang forever on a client holding an SSE connection open.
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function activeSummary(): string {
  const ready = allPlugins().filter((p) => config.sourcesEnabled.includes(p.id) && statusOf(p).ok);
  return ready.length === 0 ? 'none ready - run: node src/main.ts doctor' : ready.map((p) => p.id).join(', ');
}

async function collect(sourceId: string | undefined): Promise<void> {
  db();
  const results = sourceId === undefined ? await collectAll() : [await collectOne(sourceId)];
  for (const r of results) {
    const status = r.ok ? 'ok' : 'FAILED';
    console.log(
      `  ${r.source.padEnd(14)} ${status.padEnd(7)} items=${String(r.items).padStart(4)} new=${String(r.newItems).padStart(4)} ${Math.round(r.durationMs)}ms${r.error === null ? '' : `\n      ${r.error}`}`,
    );
  }
}

function printTop(limit: number): void {
  db();
  const rows = repo.rankedContent({ limit, offset: 0, orderBy: 'score' });
  if (rows.length === 0) {
    console.log('\n  Nothing scored yet. Run: node src/main.ts collect && node src/main.ts analyze\n');
    return;
  }
  console.log('');
  for (const [i, row] of rows.entries()) {
    const value = row.primary_value === null ? '-' : compact(row.primary_value);
    const velocity = row.velocity === null ? '-' : `${compact(row.velocity)}/h`;
    console.log(
      `  ${String(i + 1).padStart(2)}. [${String(Math.round(row.score)).padStart(3)}] ${row.state.padEnd(9)} ${row.source.padEnd(12)} ${value.padStart(7)} ${velocity.padStart(9)}  ${row.title.slice(0, 70)}`,
    );
  }
  console.log('');
}

function compact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

function listSources(): void {
  console.log('');
  for (const plugin of allPlugins()) {
    const validation = statusOf(plugin);
    const mark = validation.ok && validation.status === 'UP' ? 'ready' : validation.status.toLowerCase();
    console.log(`  ${plugin.id.padEnd(14)} ${mark.padEnd(24)} ${plugin.name}`);
    if (validation.status !== 'UP') console.log(`      ${validation.message}`);
    if (validation.helpUrl !== undefined) console.log(`      -> ${validation.helpUrl}`);
  }
  console.log('');
}

async function doctor(): Promise<void> {
  console.log('\n  Viral Radar - diagnostics\n');
  console.log(`  node            ${process.version}`);
  console.log(`  database        ${config.db.path}`);

  try {
    db();
    const stats = repo.dbStats();
    console.log(`  schema          ok (content=${stats.content}, metrics=${stats.metrics}, clusters=${stats.clusters})`);
  } catch (e) {
    console.log(`  schema          FAILED: ${(e as Error).message}`);
  }

  console.log(`  regions         ${config.regions.join(', ')}`);
  console.log(`  languages       ${config.languages.length === 0 ? 'all' : config.languages.join(', ')}`);
  console.log(`  network         ${config.net.mode}${config.net.proxyUrl === '' ? '' : ' via proxy'}`);
  console.log(`  ai              ${config.ai.provider === '' ? 'AI_DISABLED (core detection does not need it)' : config.ai.provider}`);
  console.log('\n  sources');

  for (const plugin of allPlugins()) {
    const validation = statusOf(plugin);
    console.log(`    ${plugin.id.padEnd(14)} ${validation.ok ? 'ready' : validation.status}`);
    if (!validation.ok) console.log(`        ${validation.message}`);
  }

  console.log('\n  connectivity');
  const probes: readonly [string, string][] = [
    ['google trends', 'https://trends.google.com/trending/rss?geo=US'],
    ['hacker news', 'https://hacker-news.firebaseio.com/v0/maxitem.json'],
  ];
  const { request } = await import('./net/fetcher.ts');
  for (const [name, url] of probes) {
    try {
      const started = Date.now();
      const res = await request(url, { retries: 0, timeoutMs: 10_000 });
      console.log(`    ${name.padEnd(14)} ${res.status} in ${Date.now() - started}ms`);
    } catch (e) {
      console.log(`    ${name.padEnd(14)} FAILED: ${(e as Error).message}`);
    }
  }

  const open = repo.listInterventions('OPEN');
  if (open.length > 0) {
    console.log('\n  manual action required');
    for (const item of open) console.log(`    [${item.source}] ${item.type}: ${item.message.slice(0, 120)}`);
  }
  console.log('');
}

// ── Dispatch ───────────────────────────────────────────────────────────────

/**
 * What a double-click should do.
 *
 * Someone who installed this and then clicked the icon wants to see the
 * dashboard. If the background service already holds the port, starting a
 * second copy would fail on EADDRINUSE and look broken — so the running one is
 * detected first and the browser is simply pointed at it.
 *
 * Only for packaged builds. From a clone, a bare `serve` should serve, because
 * that is what a developer typing it means.
 */
async function alreadyRunning(): Promise<boolean> {
  const { dashboardUrl } = await import('./desktop.ts');
  try {
    const res = await fetch(`${dashboardUrl()}/api/v1/system/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const [command = 'serve', argument] = process.argv.slice(2);

  // A packaged build launched with no arguments at all: the desktop case.
  if (isPackaged() && process.argv.length <= 2) {
    const { openDashboard, dashboardUrl } = await import('./desktop.ts');
    if (await alreadyRunning()) {
      console.log(`  Viral Radar is already running. Opening ${dashboardUrl()}`);
      openDashboard();
      return;
    }
    console.log(`  Starting Viral Radar. The dashboard will be at ${dashboardUrl()}`);
    // Opened a moment after the server binds, so the browser does not race it.
    setTimeout(() => openDashboard(), 2500).unref();
    await serve();
    return;
  }

  if (command !== 'doctor' && command !== 'sources') applyNetworkMode();

  switch (command) {
    case 'serve':
      await serve();
      return;
    case 'collect':
      await collect(argument);
      break;
    case 'refresh':
      await refreshMetrics((argument ?? '').toUpperCase() === 'NORMAL' ? 'NORMAL' : 'HOT');
      break;
    case 'analyze': {
      db();
      const result = analyze(nowSec());
      console.log(`\n  scored=${result.scored} clusters=${result.clusters} cross-source=${result.crossSourceClusters} viral=${result.viral} emerging=${result.emerging} breakouts=${result.breakouts} in ${result.durationMs}ms\n`);
      break;
    }
    case 'top':
      printTop(Number(argument ?? 20) || 20);
      break;
    case 'sources':
      listSources();
      break;
    case 'doctor':
      await doctor();
      break;
    case 'cleanup':
      db();
      runCleanup();
      break;
    case 'reclassify': {
      db();
      const result = reclassifyAll();
      console.log(`
  examined=${result.examined} language corrected on ${result.languageChanged}
`);
      break;
    }
    case 'install': {
      const { install } = await import('./desktop.ts');
      for (const line of install()) console.log(line === '' ? '' : '  ' + line);
      return;
    }

    case 'uninstall': {
      const { uninstall } = await import('./desktop.ts');
      for (const line of uninstall()) console.log('  ' + line);
      return;
    }

    case 'open': {
      const { openDashboard, dashboardUrl } = await import('./desktop.ts');
      console.log('  ' + dashboardUrl());
      openDashboard();
      return;
    }

    case 'mcp': {
      // Nothing may be written to stdout but the protocol itself, so the
      // logger is silenced before the server starts rather than trusted not
      // to speak. A stray line here corrupts the stream and the client sees a
      // parse error instead of an answer.
      process.env['LOG_LEVEL'] = 'silent';
      const [{ serveMcp }, { createRadarMcpServer }] = await Promise.all([
        import('./mcp/protocol.ts'),
        import('./mcp/tools.ts'),
      ]);
      await serveMcp(createRadarMcpServer());
      return;
    }

    case 'help':
    case '--help':
    case '-h':
      console.log(
        [
          '',
          '  radar serve            start the dashboard and the background scheduler',
          '  radar collect [source] run discovery once, optionally for one source',
          '  radar refresh [tier]   re-read metrics for known items (HOT | NORMAL)',
          '  radar analyze          recompute scores, clusters and baselines',
          '  radar top [n]          print the current top items',
          '  radar sources          list plugins with their configuration status',
          '  radar doctor           check configuration, database and connectivity',
          '  radar cleanup          apply the retention policy now',
          '  radar reclassify       re-run language detection over stored items',
          '  radar mcp              answer an AI assistant over MCP (stdio)',
          '',
          '  radar install          run in the background from now on, with a shortcut',
          '  radar uninstall        stop that; settings and data are left alone',
          '  radar open             open the dashboard in a browser',
          '',
        ].join('\n'),
      );
      break;
    default:
      console.error(`Unknown command "${command}". Try: radar help`);
      process.exitCode = 1;
  }

  closeDb();
}

main().catch((e: unknown) => {
  log.error('fatal', { error: (e as Error).message, stack: (e as Error).stack });
  process.exitCode = 1;
});
