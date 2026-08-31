/**
 * SQLite access built on Node's built-in `node:sqlite`.
 *
 * No ORM: every statement in this project is hand-written SQL living in
 * `repo.ts` or in a migration file. Schema changes are numbered SQL migrations
 * applied in order and tracked with PRAGMA user_version.
 */
import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.ts';
import { createLogger } from '../logger.ts';
import { MIGRATIONS, isPackaged } from '../embedded.ts';

const log = createLogger('db');
/**
 * Computed on use, not at load.
 *
 * A packaged build has no `import.meta.url` — the bundler flattens the modules
 * into CommonJS and it becomes empty — so evaluating this at the top level
 * threw before the program reached its first line. It is only ever needed when
 * reading migrations from disk, which a packaged build never does.
 */
function migrationsDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), 'migrations');
}

export type Row = Record<string, unknown>;

let instance: DatabaseSync | null = null;
const stmtCache = new Map<string, StatementSync>();

function open(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // WAL keeps the reader (API) from ever blocking the writer (collector).
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA temp_store = MEMORY');
  return db;
}

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/**
 * The migrations, from wherever this build keeps them.
 *
 * A packaged build carries them inline because it has no folder to read; a
 * normal run reads the folder because that is where they are edited. The
 * version still comes from the filename in both cases, so the ordering rule is
 * the same thing in both builds rather than two rules that could drift.
 */
function loadMigrations(): Migration[] {
  const files = isPackaged()
    ? Object.entries(MIGRATIONS)
    : readdirSync(migrationsDir())
        .filter((f) => f.endsWith('.sql'))
        .map((f) => [f, readFileSync(join(migrationsDir(), f), 'utf8')] as const);

  return files
    .map(([name, sql]) => {
      const version = Number.parseInt(name.slice(0, 3), 10);
      if (!Number.isInteger(version)) {
        throw new Error(`Migration "${name}" must start with a 3-digit version, e.g. 002_add_x.sql`);
      }
      return { version, name, sql };
    })
    .sort((a, b) => a.version - b.version);
}

/**
 * Makes sure SQLite has statistics to plan with.
 *
 * Without them the planner guesses from index shape alone, and one of those
 * guesses was costing thirty seconds of every ten minutes. The creator history
 * query filters `(source, author_id)` and orders by `first_seen_at`; given only
 * `(source, first_seen_at)` the planner used it for the ordering and tested
 * `author_id` on every row of the source, roughly fifteen hundred times per
 * analysis pass. Measured on the live 198 MB database: 28,340 ms per pass
 * before, 180 ms after. The pass runs synchronously on the thread serving HTTP
 * and the live stream, inside a write transaction, so that time is not spent
 * quietly in the background — everything stops.
 *
 * Run once when the table is absent rather than on a schedule, because it is
 * only the *absence* of statistics that is catastrophic; stale ones are a
 * rounding error next to none at all. `PRAGMA optimize` keeps them current
 * from then on, at shutdown and on the daily sweep, which is what it is for.
 *
 * On the live file this took under a second.
 */
function ensureStats(db: DatabaseSync): void {
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_stat1'").get();
  if (has !== undefined) return;
  log.info('gathering query statistics for the first time');
  db.exec('ANALYZE');
}

function migrate(db: DatabaseSync): void {
  const current = Number((db.prepare('PRAGMA user_version').get() as Row)['user_version'] ?? 0);
  const pending = loadMigrations().filter((m) => m.version > current);
  if (pending.length === 0) {
    ensureStats(db);
    return;
  }

  for (const m of pending) {
    log.info('applying migration', { version: m.version, name: m.name });
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${m.name} failed: ${(e as Error).message}`, { cause: e });
    }
  }
  log.info('database up to date', { version: pending[pending.length - 1]?.version });

  // After, not before: a new index has no statistics until it is analysed, and
  // a migration that adds one is exactly when the old numbers stop describing
  // the database.
  db.exec('ANALYZE');
}

/** Lazily opened, migrated singleton. */
export function db(): DatabaseSync {
  if (instance === null) {
    instance = open(config.db.path);
    migrate(instance);
  }
  return instance;
}

/** Prepared-statement cache; SQLite parsing is cheap but not free. */
export function prep(sql: string): StatementSync {
  let s = stmtCache.get(sql);
  if (s === undefined) {
    s = db().prepare(sql);
    stmtCache.set(sql, s);
  }
  return s;
}

export function all<T = Row>(sql: string, ...params: unknown[]): T[] {
  return prep(sql).all(...(params as never[])) as T[];
}

export function get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
  return prep(sql).get(...(params as never[])) as T | undefined;
}

export function run(sql: string, ...params: unknown[]): void {
  prep(sql).run(...(params as never[]));
}

/**
 * Runs `fn` inside a transaction. Nested calls join the outer transaction
 * instead of failing, which keeps repository methods composable.
 */
let txDepth = 0;
export function tx<T>(fn: () => T): T {
  if (txDepth > 0) return fn();
  const handle = db();
  handle.exec('BEGIN IMMEDIATE');
  txDepth++;
  try {
    const result = fn();
    handle.exec('COMMIT');
    return result;
  } catch (e) {
    handle.exec('ROLLBACK');
    throw e;
  } finally {
    txDepth--;
  }
}

/**
 * Lets SQLite refresh whatever statistics have gone stale.
 *
 * Separate from `closeDb` so the daily sweep can call it too: a long-running
 * install may not close for weeks, and the sweep is when the database changes
 * most.
 */
export function optimizeDb(): void {
  try {
    instance?.exec('PRAGMA optimize');
  } catch (e) {
    log.warn('could not optimize', { error: (e as Error).message });
  }
}

export function closeDb(): void {
  stmtCache.clear();
  optimizeDb();
  instance?.close();
  instance = null;
}

/** SQLite has no boolean type; be explicit at the boundary. */
export function toInt(v: number | null | undefined): number | null {
  return v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v);
}

export function toReal(v: number | null | undefined): number | null {
  return v === null || v === undefined || !Number.isFinite(v) ? null : v;
}

export function toJson(v: unknown): string | null {
  return v === null || v === undefined ? null : JSON.stringify(v);
}

export function fromJson<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string' || v.length === 0) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}
