/**
 * Adapters for platforms with no lawful, free, unattended read path today.
 *
 * These are real registered plugins, not placeholders that pretend to work.
 * They appear in the dashboard with an exact reason and an exact next step, and
 * they return no data until that step is taken. Nothing here fabricates a
 * response to make a demo look complete.
 *
 * Each one is also the seam where a working adapter drops in later: implement
 * `discover` against whatever access the user actually obtains, and the rest of
 * the system - scoring, clustering, the API, the dashboard - needs no change.
 */
import { err } from '../errors.ts';
import {
  configurationRequired,
  type PluginContext,
  type SourceCapabilities,
  type SourcePlugin,
  type ValidationResult,
} from './types.ts';
import type { RawContent } from '../core/types.ts';

interface UnavailableSpec {
  readonly id: string;
  readonly name: string;
  /** Exactly what is missing, in plain words. */
  readonly reason: string;
  /** Exactly what the user would have to do. */
  readonly nextStep: string;
  readonly helpUrl: string;
  readonly capabilities: SourceCapabilities;
}

function baseCapabilities(overrides: Partial<SourceCapabilities>): SourceCapabilities {
  return {
    contentTypes: ['video'],
    metrics: ['views', 'likes', 'comments', 'shares'],
    primaryMetric: 'views',
    engagementReference: 0.1,
    hasAuthor: true,
    hasHashtags: true,
    hasCountry: true,
    supportsRefresh: false,
    supportsTrending: false,
    supportsSearch: false,
    supportsHistoricalMetrics: false,
    baseReliability: 0,
    ...overrides,
  };
}

function createUnavailableSource(spec: UnavailableSpec): SourcePlugin {
  return {
    id: spec.id,
    name: spec.name,
    version: '1.0.0',
    capabilities: spec.capabilities,

    validate(): ValidationResult {
      return configurationRequired(`${spec.reason} ${spec.nextStep}`, spec.helpUrl);
    },

    async discover(_ctx: PluginContext): Promise<readonly RawContent[]> {
      throw err.configRequired(`${spec.name}: ${spec.reason}`, { nextStep: spec.nextStep, helpUrl: spec.helpUrl });
    },
  };
}

export const TIKTOK_SPEC: UnavailableSpec = {
  id: 'tiktok',
  name: 'TikTok',
  reason:
    'TikTok has no public trending endpoint. The Research API that exposes one is gated behind an application, and scraping the site would breach its terms.',
  nextStep:
    'Apply for TikTok Research API access, then implement discover() in src/sources/tiktok.ts against the granted credentials.',
  helpUrl: 'https://developers.tiktok.com/products/research-api/',
  capabilities: baseCapabilities({ contentTypes: ['short_video'] }),
};

export const X_SPEC: UnavailableSpec = {
  id: 'x',
  name: 'X (Twitter)',
  reason:
    'X removed free read access to its API. Trend and timeline reads now require a paid tier, and the site itself blocks unauthenticated reading.',
  nextStep:
    'Subscribe to an X API tier that includes recent search, then implement discover() in src/sources/x.ts with the bearer token.',
  helpUrl: 'https://developer.x.com/en/portal/products',
  capabilities: baseCapabilities({
    contentTypes: ['text', 'image', 'video'],
    metrics: ['views', 'likes', 'comments', 'shares'],
  }),
};

export const INSTAGRAM_SPEC: UnavailableSpec = {
  id: 'instagram',
  name: 'Instagram',
  reason:
    'Instagram exposes no public discovery API. The Graph API only reads accounts you own or manage, after a business review.',
  nextStep:
    'Connect a business account through the Meta Graph API if you want your own reach data; broad discovery is not available on any lawful path.',
  helpUrl: 'https://developers.facebook.com/docs/instagram-api/',
  capabilities: baseCapabilities({ contentTypes: ['image', 'short_video'] }),
};

export function createUnavailableSources(): SourcePlugin[] {
  return [TIKTOK_SPEC, X_SPEC, INSTAGRAM_SPEC].map(createUnavailableSource);
}
