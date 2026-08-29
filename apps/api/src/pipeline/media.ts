/**
 * Measuring thumbnails.
 *
 * Two levels, and the difference is what keeps this from becoming a hard
 * dependency. The file header alone gives dimensions and compressed density —
 * how hard the image resisted compression, which reads as visual busyness — and
 * that needs nothing installed. Brightness, contrast, colour and skin tone need
 * actual pixels, which means a decoder, and `ffmpeg` is used when it happens to
 * be present.
 *
 * Without it the analysis simply has fewer columns and says so. That is the
 * same promise every other optional integration here makes: never required,
 * never silently degraded into something that looks complete but is not.
 */
import { spawn } from 'node:child_process';
import { config } from '../config.ts';
import { createLogger } from '../logger.ts';
import * as repo from '../db/repo.ts';
import { nowSec } from '../core/types.ts';
import { request } from '../net/fetcher.ts';
import { featuresOfRgb, readJpegInfo } from '../core/image.ts';
import type { ImageFeatures } from '../core/image.ts';

const log = createLogger('media');

/**
 * The grid the image is reduced to before measuring.
 *
 * Sixteen squared is 256 pixels, which is plenty for an average and a spread
 * and small enough that the decode is the cost rather than the arithmetic.
 * Nothing here is about detail — a thumbnail's brightness does not become more
 * accurate at full resolution.
 */
const GRID = 16;

let ffmpegChecked = false;
let ffmpegPath: string | null = null;

/**
 * Whether a decoder is available, decided once.
 *
 * Spawning it to ask is the only reliable answer on Windows, where a command
 * can be on PATH as a shim that fails when actually run.
 */
async function findFfmpeg(): Promise<string | null> {
  if (ffmpegChecked) return ffmpegPath;
  ffmpegChecked = true;

  const found = await new Promise<string | null>((resolve) => {
    const probe = spawn('ffmpeg', ['-version'], { stdio: 'ignore', shell: process.platform === 'win32' });
    probe.on('error', () => resolve(null));
    probe.on('close', (code) => resolve(code === 0 ? 'ffmpeg' : null));
  });

  ffmpegPath = found;
  log.info(
    found === null
      ? 'no ffmpeg: thumbnails will be measured by size and density only'
      : 'ffmpeg found: thumbnails will be measured in full',
  );
  return ffmpegPath;
}

/**
 * Reduces an image to a small raw RGB grid.
 *
 * Returns null rather than throwing on any failure — a thumbnail that will not
 * decode is one item measured less thoroughly, never a failed run.
 */
async function toRgb(jpeg: Uint8Array): Promise<Uint8Array | null> {
  const bin = await findFfmpeg();
  if (bin === null) return null;

  return new Promise<Uint8Array | null>((resolve) => {
    const child = spawn(
      bin,
      ['-v', 'error', '-i', 'pipe:0', '-vf', `scale=${GRID}:${GRID}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
      { stdio: ['pipe', 'pipe', 'ignore'], shell: process.platform === 'win32' },
    );

    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (value: Uint8Array | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', () => finish(null));
    child.on('close', () => {
      const out = Buffer.concat(chunks);
      finish(out.length >= 3 ? new Uint8Array(out) : null);
    });

    // A decoder that hangs must not hold the whole run.
    setTimeout(() => {
      child.kill();
      finish(null);
    }, 10_000);

    child.stdin.on('error', () => finish(null));
    child.stdin.end(Buffer.from(jpeg));
  });
}

export interface MediaRunResult {
  readonly considered: number;
  readonly measured: number;
  readonly withPixels: number;
  readonly skipped: boolean;
}

/**
 * Measures thumbnails that have not been measured yet.
 *
 * Capped per run and newest first, for the same reason every other backfill
 * here is: coverage should climb steadily rather than arrive in one stall, and
 * the items on screen are the recent ones.
 */
export async function runMedia(now = nowSec()): Promise<MediaRunResult> {
  const budget = config.media.perRun;
  if (budget === 0) return { considered: 0, measured: 0, withPixels: 0, skipped: true };

  const pending = repo.contentNeedingMedia(budget);
  if (pending.length === 0) return { considered: 0, measured: 0, withPixels: 0, skipped: false };

  let measured = 0;
  let withPixels = 0;
  const rows: repo.MediaRow[] = [];

  for (const item of pending) {
    let bytes: Uint8Array;
    try {
      const res = await request(item.thumbnailUrl, {
        context: 'thumbnail',
        rps: 4,
        retries: 0,
        timeoutMs: 15_000,
        binary: true,
      });
      bytes = res.bytes ?? new Uint8Array(0);
    } catch {
      // A thumbnail that will not download is not worth a log line each time;
      // it is recorded as attempted so the job moves on to the next item.
      rows.push({ contentId: item.id, sourceUrl: item.thumbnailUrl, fetchedAt: now });
      continue;
    }

    const info = readJpegInfo(bytes);
    let features: ImageFeatures | null = null;
    const rgb = await toRgb(bytes);
    if (rgb !== null) features = featuresOfRgb(rgb);

    rows.push({
      contentId: item.id,
      sourceUrl: item.thumbnailUrl,
      fetchedAt: now,
      ...(info === null ? {} : { width: info.width, height: info.height, bytes: info.bytes, density: info.density }),
      ...(features === null ? {} : features),
    });

    if (info !== null || features !== null) measured++;
    if (features !== null) withPixels++;
  }

  repo.saveMedia(rows);
  const coverage = repo.mediaCoverage();
  log.info('thumbnails measured', {
    considered: pending.length,
    measured,
    withPixels,
    coverage: `${coverage.measured}/${coverage.total}`,
  });

  return { considered: pending.length, measured, withPixels, skipped: false };
}
