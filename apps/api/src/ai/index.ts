/**
 * The narrative plugin: cluster names and one-line explanations.
 *
 * Strictly cosmetic. If the provider is unreachable, slow, or returns nonsense,
 * the keyword-derived label that was already computed stays exactly as it was.
 */
import { createLogger } from '../logger.ts';
import { config } from '../config.ts';
import * as repo from '../db/repo.ts';
import { nowSec } from '../core/types.ts';
import { createProvider } from './providers.ts';
import { AI_DISABLED, type ClusterNaming, type NarrativePlugin } from './types.ts';

const log = createLogger('ai');

const SYSTEM = [
  'You name clusters of trending internet posts.',
  'Reply with exactly two lines and nothing else:',
  'LABEL: a specific noun phrase of at most six words naming what this is about',
  'WHY: one sentence, at most 25 words, on why it is spreading right now',
  'Use only the information given. If it is unclear, say so in WHY rather than inventing detail.',
].join('\n');

function parse(text: string): ClusterNaming | null {
  const label = /^LABEL:\s*(.+)$/im.exec(text)?.[1]?.trim();
  const why = /^WHY:\s*(.+)$/im.exec(text)?.[1]?.trim();
  if (label === undefined || label.length === 0 || label.length > 120) return null;
  return { label, explanation: why ?? '' };
}

export function createNarrativePlugin(): NarrativePlugin {
  const provider = createProvider();
  if (provider === null) return AI_DISABLED;

  return {
    available: true,
    describe: `${provider.id}:${provider.model}`,

    async nameCluster(input) {
      const user = [
        `Keywords: ${input.keywords.slice(0, 8).join(', ')}`,
        `Platforms: ${input.sources.join(', ')}`,
        `Languages: ${input.languages.join(', ') || 'unknown'}`,
        'Post titles:',
        ...input.titles.slice(0, 8).map((t) => `- ${t.slice(0, 160)}`),
      ].join('\n');

      try {
        return parse(await provider.complete({ system: SYSTEM, user, maxTokens: 160 }));
      } catch (e) {
        log.warn('naming failed, keeping the keyword label', { error: (e as Error).message });
        return null;
      }
    },
  };
}

/**
 * Names the top clusters that still carry a keyword-derived label.
 *
 * Runs as its own scheduled job rather than inside `analyze`, so the analysis
 * pass stays synchronous, deterministic and free of network calls.
 */
export async function enrichClusterNarratives(limit = 8): Promise<number> {
  const plugin = createNarrativePlugin();
  if (!plugin.available) return 0;

  const clusters = repo
    .listClusters({ limit, minSources: 2, minScore: 40 })
    .filter((c) => c.label_source === 'keywords');
  let named = 0;

  for (const cluster of clusters) {
    const members = repo.clusterMembers(cluster.id, 8);
    const naming = await plugin.nameCluster({
      keywords: JSON.parse(cluster.keywords) as string[],
      titles: members.map((m) => m.title),
      sources: JSON.parse(cluster.sources) as string[],
      languages: members.map((m) => m.lang).filter((l): l is string => l !== null),
    });
    if (naming === null) continue;
    repo.setClusterNarrative(cluster.id, naming.label, naming.explanation, nowSec());
    named++;
  }

  if (named > 0) log.info('clusters named', { named, provider: config.ai.provider });
  return named;
}

export { AI_DISABLED } from './types.ts';
export type { NarrativePlugin } from './types.ts';
