/**
 * Learning what is normal for a creator.
 *
 * A breakout verdict — "this got forty times what this account usually gets" —
 * is the most useful signal the system produces, because it finds a small
 * account mid-explosion rather than a big one being big. It needs the
 * account's own history, and open discovery does not provide it: discovery
 * finds one strong video from a channel and never returns.
 *
 * On the database this was written against that left 2,189 of 2,770 creators
 * with exactly one measured item, so 90% of creators could never be judged
 * against themselves at all. The fix is not a lower threshold — the median of
 * two numbers is not a baseline — it is going and fetching the history.
 *
 * The fetched posts are stored apart from `content`. They are reference
 * observations, not candidates: never scored, never refreshed, never clustered
 * and never shown as trends. Mixing them in would fill the feed with old
 * uploads that are not trending, which is the obvious way to get this wrong.
 */
import { config } from '../config.ts';
import { createLogger, errFields } from '../logger.ts';
import * as repo from '../db/repo.ts';
import { nowSec } from '../core/types.ts';
import { allPlugins, createContext } from '../sources/registry.ts';

const log = createLogger('backfill');

/**
 * How many samples a creator needs before they are left alone.
 *
 * Above the five a breakout verdict requires, so that a creator sitting exactly
 * at the line is not re-fetched every run for one more sample.
 */
const TARGET_SAMPLES = 8;

/** A creator looked at recently is not looked at again. */
const RESTING_SEC = 7 * 24 * 3600;

export interface BackfillResult {
  readonly asked: number;
  readonly creators: number;
  readonly samples: number;
  readonly bySource: Readonly<Record<string, number>>;
}

/**
 * Fetches history for the creators most worth knowing about.
 *
 * Only sources that implement `creatorHistory` take part, and each is asked
 * for a bounded number of creators — the point is a steady climb in coverage,
 * not one enormous run that exhausts an API quota in a single pass.
 */
export async function backfillCreators(now = nowSec()): Promise<BackfillResult> {
  const budget = config.schedule.backfillPerRun;
  if (budget === 0) return { asked: 0, creators: 0, samples: 0, bySource: {} };

  const bySource: Record<string, number> = {};
  let asked = 0;
  let creators = 0;
  let samples = 0;

  for (const plugin of allPlugins()) {
    if (plugin.creatorHistory === undefined) continue;
    if (!config.sourcesEnabled.includes(plugin.id)) continue;

    const wanted = repo.creatorsNeedingHistory(
      plugin.id,
      TARGET_SAMPLES,
      now - RESTING_SEC,
      budget,
    );
    if (wanted.length === 0) continue;
    asked += wanted.length;

    // A backfill never needs a human, so an intervention here would be noise;
    // anything worth reporting comes back as a thrown error instead.
    const ctx = createContext(plugin.id, () => {}, () => now);
    let fetched: readonly {
      creatorExternalId: string;
      itemExternalId: string;
      metric: string;
      value: number;
      publishedAt: number | null;
    }[] = [];

    try {
      fetched = await plugin.creatorHistory(ctx, wanted.map((w) => w.externalId));
    } catch (e) {
      // One source failing must not stop the others, and a backfill is never
      // urgent enough to be worth failing a scheduled run over.
      log.warn('creator history failed', { source: plugin.id, ...errFields(e) });
      continue;
    }

    // Marked whether or not anything came back: a channel that is deleted or
    // silent should not be retried every single run for ever.
    repo.markHistoryFetched(wanted.map((w) => w.creatorId), now);

    if (fetched.length === 0) continue;

    repo.saveCreatorHistory(
      fetched.map((s) => ({
        creatorId: repo.creatorIdOf(plugin.id, s.creatorExternalId),
        externalId: s.itemExternalId,
        metric: s.metric,
        value: s.value,
        publishedAt: s.publishedAt,
      })),
      now,
    );

    const distinct = new Set(fetched.map((s) => s.creatorExternalId)).size;
    creators += distinct;
    samples += fetched.length;
    bySource[plugin.id] = fetched.length;

    const coverage = repo.creatorHistoryCoverage(plugin.id);
    log.info('creator history', {
      source: plugin.id,
      asked: wanted.length,
      creators: distinct,
      samples: fetched.length,
      coverage: `${coverage.withHistory}/${coverage.total}`,
    });
  }

  return { asked, creators, samples, bySource };
}
