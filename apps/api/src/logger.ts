/**
 * Structured logging with secret redaction.
 * Pretty lines on a TTY, one JSON object per line when piped to a file.
 */
/**
 * `silent` exists for the MCP transport, which owns stdout: the protocol is
 * newline-delimited JSON on that stream, so a single log line corrupts it and
 * the client sees a parse error rather than an answer. Above `error` on
 * purpose, so nothing at all clears the threshold.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
export type LogLevel = keyof typeof LEVELS;

const threshold = LEVELS[(process.env['LOG_LEVEL'] as LogLevel) ?? 'info'] ?? LEVELS.info;
const pretty = process.stdout.isTTY === true && process.env['LOG_FORMAT'] !== 'json';

/** Keys whose values are never written to a log, at any depth. */
const SECRET_KEYS =
  /(pass|secret|token|api[_-]?key|apikey|cookie|authorization|auth|credential|session)/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[deep]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

/** Only the levels that can actually be emitted; `silent` never reaches here. */
const COLORS: Record<Exclude<LogLevel, 'silent'>, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};

export interface LogFields {
  readonly [key: string]: unknown;
}

/** `silent` is a threshold, never something a caller emits at. */
type EmitLevel = Exclude<LogLevel, 'silent'>;

function emit(level: EmitLevel, scope: string, msg: string, fields?: LogFields): void {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString();
  const safe = fields ? (redact(fields) as Record<string, unknown>) : undefined;

  if (pretty) {
    const head = `${COLORS[level]}${level.toUpperCase().padEnd(5)}\x1b[0m \x1b[90m${ts.slice(11, 19)}\x1b[0m \x1b[1m${scope}\x1b[0m`;
    let tail = '';
    if (safe) {
      tail = Object.entries(safe)
        .map(([k, v]) => ` \x1b[90m${k}=\x1b[0m${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
        .join('');
    }
    process.stdout.write(`${head} ${msg}${tail}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({ ts, level, scope, msg, ...safe })}\n`);
  }
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, f) => emit('debug', scope, m, f),
    info: (m, f) => emit('info', scope, m, f),
    warn: (m, f) => emit('warn', scope, m, f),
    error: (m, f) => emit('error', scope, m, f),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

export const log = createLogger('radar');

/** Turn an unknown throwable into loggable fields without leaking secrets. */
export function errFields(e: unknown): LogFields {
  if (e instanceof Error) {
    return { error: e.message, errorType: e.name, ...(('code' in e) ? { code: (e as { code: unknown }).code } : {}) };
  }
  return { error: String(e) };
}
