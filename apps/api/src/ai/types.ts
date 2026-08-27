/**
 * Optional AI.
 *
 * Nothing in the detection path may import this. AI here does exactly two
 * cosmetic jobs - giving a cluster a nicer name and writing a sentence about
 * why it might be spreading - and the system is fully functional with
 * AI_PROVIDER empty, which is the default.
 *
 * The core never depends on a vendor: it depends on this interface.
 */

export interface CompletionRequest {
  readonly system: string;
  readonly user: string;
  readonly maxTokens: number;
}

/** One vendor adapter. Adding a provider means implementing this and nothing else. */
export interface AiProvider {
  readonly id: string;
  readonly model: string;
  complete(request: CompletionRequest): Promise<string>;
}

export interface ClusterNaming {
  readonly label: string;
  readonly explanation: string;
}

/** What the application asks of AI, stated in its own vocabulary. */
export interface NarrativePlugin {
  readonly available: boolean;
  readonly describe: string;
  nameCluster(input: {
    keywords: readonly string[];
    titles: readonly string[];
    sources: readonly string[];
    languages: readonly string[];
  }): Promise<ClusterNaming | null>;
}

/** The no-op used whenever no provider is configured. */
export const AI_DISABLED: NarrativePlugin = {
  available: false,
  describe: 'AI_DISABLED',
  async nameCluster() {
    return null;
  },
};
