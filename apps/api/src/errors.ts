/**
 * Typed errors. Every failure in the system is one of these, so callers can
 * decide *by type* whether to retry, back off, or ask the user for help.
 */
export const ERROR_KINDS = [
  'VALIDATION',
  'CONFIGURATION_REQUIRED',
  'NETWORK',
  'RATE_LIMIT',
  'AUTH_REQUIRED',
  'CAPTCHA_REQUIRED',
  'SOURCE_UNAVAILABLE',
  'PARSING',
  'DUPLICATE',
  'INTERNAL',
] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

export class RadarError extends Error {
  readonly kind: ErrorKind;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>>;
  /** Seconds to wait before retrying, when the remote told us. */
  readonly retryAfterSec: number | null;

  constructor(
    kind: ErrorKind,
    message: string,
    opts: { retryable?: boolean; details?: Record<string, unknown>; retryAfterSec?: number | null; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = `RadarError(${kind})`;
    this.kind = kind;
    this.details = Object.freeze(opts.details ?? {});
    this.retryAfterSec = opts.retryAfterSec ?? null;
    this.retryable = opts.retryable ?? DEFAULT_RETRYABLE[kind];
  }
}

/**
 * Retry policy by kind. CAPTCHA / auth / configuration problems are never
 * retried: hammering them is both useless and abusive.
 */
const DEFAULT_RETRYABLE: Record<ErrorKind, boolean> = {
  VALIDATION: false,
  CONFIGURATION_REQUIRED: false,
  NETWORK: true,
  RATE_LIMIT: false,
  AUTH_REQUIRED: false,
  CAPTCHA_REQUIRED: false,
  SOURCE_UNAVAILABLE: true,
  PARSING: false,
  DUPLICATE: false,
  INTERNAL: false,
};

export const err = {
  validation: (m: string, d?: Record<string, unknown>) => new RadarError('VALIDATION', m, { details: d }),
  configRequired: (m: string, d?: Record<string, unknown>) => new RadarError('CONFIGURATION_REQUIRED', m, { details: d }),
  network: (m: string, cause?: unknown) => new RadarError('NETWORK', m, { cause }),
  rateLimit: (m: string, retryAfterSec: number | null) => new RadarError('RATE_LIMIT', m, { retryAfterSec }),
  authRequired: (m: string, d?: Record<string, unknown>) => new RadarError('AUTH_REQUIRED', m, { details: d }),
  captcha: (m: string, d?: Record<string, unknown>) => new RadarError('CAPTCHA_REQUIRED', m, { details: d }),
  unavailable: (m: string, d?: Record<string, unknown>) => new RadarError('SOURCE_UNAVAILABLE', m, { details: d }),
  parsing: (m: string, cause?: unknown) => new RadarError('PARSING', m, { cause }),
  internal: (m: string, cause?: unknown) => new RadarError('INTERNAL', m, { cause }),
};

export function isRadarError(e: unknown): e is RadarError {
  return e instanceof RadarError;
}

/** Kinds that mean "a human has to do something before this source can work again". */
export function needsHuman(kind: ErrorKind): boolean {
  return kind === 'CAPTCHA_REQUIRED' || kind === 'AUTH_REQUIRED' || kind === 'CONFIGURATION_REQUIRED';
}
