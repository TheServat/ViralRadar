/**
 * The scheduler.
 *
 * A single-threaded job runner: timers enqueue work, one job executes at a
 * time. That is not a compromise at this scale - it is the correct shape.
 * Collection is almost entirely waiting on the network, and serialising the
 * jobs removes a whole category of concurrent-write problems for free.
 *
 * Priorities are expressed as intervals rather than as a queue: HOT items are
 * measured every few minutes, everything else hourly, cleanup daily.
 */
import { config } from '../config.ts';
import { createLogger } from '../logger.ts';
import { errFields } from '../logger.ts';
import { analyze, runCleanup } from './analyze.ts';
import { collectAll, refreshMetrics } from './collect.ts';
import { nowSec } from '../core/types.ts';
import { kvSet } from '../db/repo.ts';

const log = createLogger('scheduler');

export interface Job {
  readonly name: string;
  readonly everyMs: number;
  readonly run: () => Promise<void> | void;
  /** Run once at startup, before the first interval elapses. */
  readonly onStart: boolean;
}

interface Scheduled {
  readonly job: Job;
  timer: NodeJS.Timeout | null;
  lastRunAt: number | null;
  lastDurationMs: number | null;
  lastError: string | null;
  runs: number;
}

const MINUTE = 60_000;

export class Scheduler {
  private readonly jobs = new Map<string, Scheduled>();
  private readonly queue: Job[] = [];
  private running = false;
  private stopped = false;

  add(job: Job): void {
    this.jobs.set(job.name, { job, timer: null, lastRunAt: null, lastDurationMs: null, lastError: null, runs: 0 });
  }

  /** Queue a job by name; ignored if unknown or already queued. */
  trigger(name: string): boolean {
    const entry = this.jobs.get(name);
    if (entry === undefined) return false;
    if (this.queue.some((j) => j.name === name)) return true;
    this.queue.push(entry.job);
    void this.drain();
    return true;
  }

  start(): void {
    this.stopped = false;
    for (const entry of this.jobs.values()) {
      // A small random offset keeps every job from firing on the same second.
      const jitter = Math.floor(Math.random() * Math.min(entry.job.everyMs, 30_000));
      entry.timer = setInterval(() => this.trigger(entry.job.name), entry.job.everyMs + jitter);
      if (entry.job.onStart) this.trigger(entry.job.name);
    }
    log.info('started', { jobs: [...this.jobs.keys()] });
  }

  stop(): void {
    this.stopped = true;
    for (const entry of this.jobs.values()) {
      if (entry.timer !== null) clearInterval(entry.timer);
      entry.timer = null;
    }
    log.info('stopped');
  }

  private async drain(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      while (this.queue.length > 0 && !this.stopped) {
        const job = this.queue.shift() as Job;
        const entry = this.jobs.get(job.name);
        const started = Date.now();
        try {
          await job.run();
          if (entry !== undefined) entry.lastError = null;
        } catch (e) {
          // A failing job must never stop the scheduler.
          log.error('job failed', { job: job.name, ...errFields(e) });
          if (entry !== undefined) entry.lastError = (e as Error).message.slice(0, 300);
        } finally {
          if (entry !== undefined) {
            entry.lastRunAt = nowSec();
            entry.lastDurationMs = Date.now() - started;
            entry.runs++;
          }
        }
      }
    } finally {
      this.running = false;
    }
  }

  status(): { name: string; everyMs: number; lastRunAt: number | null; lastDurationMs: number | null; lastError: string | null; runs: number; queued: boolean }[] {
    return [...this.jobs.values()].map((e) => ({
      name: e.job.name,
      everyMs: e.job.everyMs,
      lastRunAt: e.lastRunAt,
      lastDurationMs: e.lastDurationMs,
      lastError: e.lastError,
      runs: e.runs,
      queued: this.queue.some((j) => j.name === e.job.name),
    }));
  }

  get isBusy(): boolean {
    return this.running;
  }
}

/** The standard job set. */
export function createScheduler(): Scheduler {
  const scheduler = new Scheduler();

  scheduler.add({
    name: 'discover',
    everyMs: config.schedule.discoveryMin * MINUTE,
    onStart: config.schedule.runOnStart,
    run: async () => {
      const results = await collectAll();
      const items = results.reduce((a, r) => a + r.items, 0);
      kvSet('last_discovery', String(nowSec()));
      log.info('discovery complete', { sources: results.length, items });
    },
  });

  scheduler.add({
    name: 'refresh-hot',
    everyMs: config.schedule.hotRefreshMin * MINUTE,
    onStart: false,
    run: async () => {
      await refreshMetrics('HOT');
    },
  });

  scheduler.add({
    name: 'refresh-normal',
    everyMs: config.schedule.normalRefreshMin * MINUTE,
    onStart: false,
    run: async () => {
      await refreshMetrics('NORMAL');
    },
  });

  scheduler.add({
    name: 'analyze',
    everyMs: config.schedule.analyzeMin * MINUTE,
    onStart: config.schedule.runOnStart,
    run: () => {
      analyze();
      kvSet('last_analysis', String(nowSec()));
    },
  });

  // Registered only when a provider is configured. With AI_PROVIDER empty this
  // job does not exist, and nothing else changes.
  if (config.ai.provider !== '') {
    scheduler.add({
      name: 'name-clusters',
      everyMs: Math.max(config.schedule.analyzeMin, 15) * MINUTE,
      onStart: false,
      run: async () => {
        const { enrichClusterNarratives } = await import('../ai/index.ts');
        await enrichClusterNarratives();
      },
    });
  }

  // Registered only when a model is configured. Runs slightly ahead of the
  // analysis it feeds, so a newly collected item usually has its vector by the
  // time clustering looks for one.
  if (config.embed.model !== '') {
    scheduler.add({
      name: 'embed',
      everyMs: config.embed.intervalMin * MINUTE,
      onStart: config.schedule.runOnStart,
      run: async () => {
        const { runEmbedding } = await import('./embed.ts');
        await runEmbedding();
      },
    });
  }

  // Registered only when a channel is configured. With NOTIFY_CHANNELS empty
  // this job does not exist and nothing else changes.
  if (config.notify.channels.length > 0) {
    scheduler.add({
      name: 'notify',
      everyMs: config.notify.intervalMin * MINUTE,
      onStart: false,
      run: async () => {
        const { dispatch } = await import('../notify/index.ts');
        await dispatch();
      },
    });
  }

  scheduler.add({
    name: 'cleanup',
    everyMs: 24 * 60 * MINUTE,
    onStart: false,
    run: () => {
      runCleanup();
    },
  });

  return scheduler;
}
