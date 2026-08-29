/**
 * Assets carried inside a packaged build.
 *
 * Empty here on purpose. Running the radar normally, Node executes these
 * sources directly and everything is read from disk where it belongs — the
 * migrations from their folder, the dashboard from `apps/web/dist`.
 *
 * When packaging a single executable there is no folder to read from, so
 * `scripts/bundle.mjs` swaps this module for a generated one holding the same
 * files inline. Every consumer checks whether the map is empty and falls back
 * to disk, which means one code path serves both and neither needs to know
 * which build it is in.
 */

/** Filename to SQL, in the order they apply. */
export const MIGRATIONS: Readonly<Record<string, string>> = {};

/** Path inside the dashboard build, to base64 contents. */
export const WEB_FILES: Readonly<Record<string, string>> = {};

/** Whether this build carries its assets rather than reading them from disk. */
export function isPackaged(): boolean {
  return Object.keys(MIGRATIONS).length > 0;
}
