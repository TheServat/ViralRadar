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

const log = createLogger('db');
const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'migrations');

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

function loadMigrations(): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => {
      const version = Number.parseInt(f.slice(0, 3), 10);
      if (!Number.isInteger(version)) {
        throw new Error(`Migration "${f}" must start with a 3-digit version, e.g. 002_add_x.sql`);
      }
      return { version, name: f, sql: readFileSync(join(MIGRATIONS_DIR, f), 'utf8') };
    })
    .sort((a, b) => a.version - b.version);
}

function migrate(db: DatabaseSync): void {
  const current = Number((db.prepare('PRAGMA user_version').get() as Row)['user_version'] ?? 0);
  const pending = loadMigrations().filter((m) => m.version > current);
  if (pending.length === 0) return;

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

export function closeDb(): void {
  stmtCache.clear();
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
