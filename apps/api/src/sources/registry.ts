/**
 * Plugin registry and lifecycle.
 *
 * The core resolves sources through this module only. Nothing outside
 * `src/sources/` imports a concrete adapter, so the trend engine has no idea
 * that YouTube or Reddit exist - it only ever sees `SourcePlugin`.
 *
 * A plugin that throws during discovery is recorded as unhealthy and skipped.
 * One broken source never takes the application down with it.
 */
import { config, isSourceEnabled } from '../config.ts';
import { createLogger } from '../logger.ts';
import { createBlueskySource } from './bluesky.ts';
import { createChartsSource } from './charts.ts';
import { createGiphySource } from './giphy.ts';
import { createGitHubSource } from './github.ts';
import { createGoogleNewsSource } from './googlenews.ts';
import { createGoogleTrendsSource } from './googletrends.ts';
import { createImgurSource } from './imgur.ts';
import { createMastodonSource } from './mastodon.ts';
import { createProductHuntSource } from './producthunt.ts';
import { createTmdbSource } from './tmdb.ts';
import { createTwitchSource } from './twitch.ts';
import { createWikipediaSource } from './wikipedia.ts';
import { createHackerNewsSource } from './hackernews.ts';
import { createRedditSource } from './reddit.ts';
import { createRssSource } from './rss.ts';
import { createTelegramSource } from './telegram.ts';
import { createYouTubeSource } from './youtube.ts';
import { createUnavailableSources } from './unavailable.ts';
import { knownExternalIds, kvGet, kvSet, provenCreators, termYield } from '../db/repo.ts';
import { disabled, type PluginContext, type PluginState, type SourcePlugin, type ValidationResult } from './types.ts';
import type { InterventionType } from '../core/types.ts';

const log = createLogger('plugins');

/**
 * Every adapter that exists. Adding a source is one line here plus one file;
 * the pipeline, API and dashboard pick it up automatically.
 */
function createAll(): SourcePlugin[] {
  return [
    createGoogleTrendsSource(),
    createGoogleNewsSource(),
    createWikipediaSource(),
    createHackerNewsSource(),
    createRssSource(),
    createYouTubeSource(),
    createRedditSource(),
    createTelegramSource(),
    createMastodonSource(),
    createBlueskySource(),
    createGitHubSource(),
    createChartsSource(),
    createImgurSource(),
    createTwitchSource(),
    createTmdbSource(),
    createProductHuntSource(),
    createGiphySource(),
    ...createUnavailableSources(),
  ];
}

let plugins: SourcePlugin[] | null = null;

export function allPlugins(): readonly SourcePlugin[] {
  if (plugins === null) {
    plugins = createAll();
    const duplicate = plugins.map((p) => p.id).find((id, i, arr) => arr.indexOf(id) !== i);
    if (duplicate !== undefined) throw new Error(`Duplicate source plugin id: ${duplicate}`);
  }
  return plugins;
}

export function pluginById(id: string): SourcePlugin | undefined {
  return allPlugins().find((p) => p.id === id);
}

/** Enabled in configuration *and* passing its own validation. */
export function activePlugins(): SourcePlugin[] {
  return allPlugins().filter((p) => isSourceEnabled(p.id) && p.validate().ok);
}

export function statusOf(plugin: SourcePlugin): ValidationResult {
  if (!isSourceEnabled(plugin.id)) return disabled();
  return plugin.validate();
}

export interface InterventionRequest {
  readonly source: string;
  readonly type: InterventionType;
  readonly message: string;
  readonly url: string | null;
}

/**
 * Builds the sandbox a plugin runs inside. Plugins receive capabilities, not
 * the application: no database handle, no configuration object, no way to
 * reach another source's state.
 */
export function createContext(
  pluginId: string,
  onIntervention: (request: InterventionRequest) => void,
  now: () => number = () => Math.floor(Date.now() / 1000),
): PluginContext {
  // Namespaced so one plugin cannot read or overwrite another's state.
  const prefix = `plugin:${pluginId}:`;
  const state: PluginState = {
    get: (key) => kvGet(prefix + key),
    set: (key, value) => kvSet(prefix + key, value),
    getNumber: (key, fallback) => {
      const raw = kvGet(prefix + key);
      if (raw === null) return fallback;
      const n = Number(raw);
      return Number.isFinite(n) ? n : fallback;
    },
    setNumber: (key, value) => kvSet(prefix + key, String(value)),
  };

  return {
    logger: log.child(pluginId),
    now,
    regions: config.regions,
    languages: config.languages,
    state,
    provenCreators: (limit) =>
      provenCreators(pluginId, config.discovery.watchMinItems, config.discovery.watchMinScore, limit),
    knownIds: (externalIds) => knownExternalIds(pluginId, externalIds),
    // A day old, so a word is judged on items that have had time to prove
    // themselves rather than on ones found minutes ago.
    termYield: () => termYield(pluginId, now() - 86_400),
    requireHuman: (type, message, url) => {
      log.warn('manual intervention required', { source: pluginId, type, message });
      onIntervention({ source: pluginId, type, message, url: url ?? null });
    },
  };
}
