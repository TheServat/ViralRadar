/**
 * SSRF protection.
 *
 * This system reads URLs that strangers on the internet chose. Any one of them
 * could point at 169.254.169.254 or at a service on the loopback interface, so
 * every outbound URL is checked before a socket is opened - including redirect
 * targets, which are the usual way this gets bypassed.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { err } from '../errors.ts';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** Hostnames that are never resolved, whatever DNS might claim. */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

interface Range {
  readonly base: number;
  readonly bits: number;
  readonly label: string;
}

function cidr(notation: string, label: string): Range {
  const [ip = '', bitsRaw = '32'] = notation.split('/');
  return { base: ipv4ToInt(ip) ?? 0, bits: Number(bitsRaw), label };
}

const BLOCKED_V4: readonly Range[] = [
  cidr('0.0.0.0/8', 'this-network'),
  cidr('10.0.0.0/8', 'private'),
  cidr('100.64.0.0/10', 'carrier-grade-nat'),
  cidr('127.0.0.0/8', 'loopback'),
  cidr('169.254.0.0/16', 'link-local / cloud metadata'),
  cidr('172.16.0.0/12', 'private'),
  cidr('192.0.0.0/24', 'ietf-protocol'),
  cidr('192.168.0.0/16', 'private'),
  cidr('198.18.0.0/15', 'benchmark'),
  cidr('224.0.0.0/4', 'multicast'),
  cidr('240.0.0.0/4', 'reserved'),
];

export function isBlockedIPv4(ip: string): string | null {
  const value = ipv4ToInt(ip);
  if (value === null) return 'unparseable IPv4 address';
  for (const range of BLOCKED_V4) {
    const mask = range.bits === 0 ? 0 : (0xffffffff << (32 - range.bits)) >>> 0;
    if ((value & mask) >>> 0 === (range.base & mask) >>> 0) return range.label;
  }
  return null;
}

export function isBlockedIPv6(ip: string): string | null {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (v === '::1' || v === '::') return 'loopback';
  if (v.startsWith('fe80')) return 'link-local';
  if (/^f[cd]/.test(v)) return 'unique-local';
  if (v.startsWith('::ffff:')) {
    const mapped = v.slice(7);
    return isIP(mapped) === 4 ? isBlockedIPv4(mapped) : 'ipv4-mapped';
  }
  return null;
}

export interface UrlGuardOptions {
  /** Hosts explicitly permitted despite resolving privately (e.g. a local Ollama). */
  readonly allowHosts?: readonly string[];
  /** Skip DNS resolution. Only for hosts this application itself configured. */
  readonly skipDnsCheck?: boolean;
}

/**
 * Validates a URL and resolves it, throwing a typed error if anything about it
 * points inward. Returns the parsed URL so callers cannot accidentally use an
 * unvalidated string afterwards.
 */
export async function assertSafeUrl(raw: string, opts: UrlGuardOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw err.validation(`Not a valid URL: ${raw.slice(0, 120)}`);
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw err.validation(`Blocked protocol "${url.protocol}" - only http and https are allowed`);
  }

  const host = url.hostname.toLowerCase();
  if (opts.allowHosts?.includes(host)) return url;

  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw err.validation(`Blocked hostname "${host}"`);
  }

  const literal = isIP(host);
  if (literal === 4) {
    const reason = isBlockedIPv4(host);
    if (reason !== null) throw err.validation(`Blocked address ${host} (${reason})`);
    return url;
  }
  if (literal === 6) {
    const reason = isBlockedIPv6(host);
    if (reason !== null) throw err.validation(`Blocked address ${host} (${reason})`);
    return url;
  }

  if (opts.skipDnsCheck === true) return url;

  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch (e) {
    throw err.network(`DNS lookup failed for ${host}`, e);
  }
  if (addresses.length === 0) throw err.network(`No address for ${host}`);

  for (const { address, family } of addresses) {
    const reason = family === 6 ? isBlockedIPv6(address) : isBlockedIPv4(address);
    if (reason !== null) {
      throw err.validation(`${host} resolves to a blocked address ${address} (${reason})`);
    }
  }
  return url;
}
