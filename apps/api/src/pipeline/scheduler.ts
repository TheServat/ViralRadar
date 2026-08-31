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
import { kvGet, kvSet } from '../db/repo.ts';

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

  /**
   * `runOnStart` is false when this is a reload rather than a launch: the jobs
   * marked to run immediately have already run, and firing a collection pass
   * every time somebody saves a setting would be its own kind of broken.
   */
  start(runOnStart = true): void {
    this.stopped = false;
    for (const entry of this.jobs.values()) {
      // A small random offset keeps every job from firing on the same second.
      const jitter = Math.floor(Math.random() * Math.min(entry.job.everyMs, 30_000));
      entry.timer = setInterval(() => this.trigger(entry.job.name), entry.job.everyMs + jitter);
      if (runOnStart && entry.job.onStart) this.trigger(entry.job.name);
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

  /**
   * Rebuilds the job list from the current configuration.
   *
   * In place rather than by replacement, because the HTTP handlers were given
   * this instance at startup and a new object would leave them triggering jobs
   * on a scheduler nobody is running. Whatever is mid-flight finishes: `stop`
   * only clears the timers, and the queue drains on its own.
   */
  reload(): void {
    const wasRunning = !this.stopped;
    this.stop();
    this.jobs.clear();
    addStandardJobs(this);
    if (wasRunning) this.start(false);
    log.info('reloaded', { jobs: [...this.jobs.keys()] });
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
  addStandardJobs(scheduler);
  return scheduler;
}

/**
 * Registers every job, reading the intervals from the configuration as it goes.
 *
 * Separate from `createScheduler` so a reload can run it again against changed
 * settings. Every `everyMs` below is read at call time, which is the whole
 * point: an interval edited in the settings screen takes effect when this runs
 * again rather than at the next restart.
 */
function addStandardJobs(scheduler: Scheduler): void {
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

  // Measures thumbnails. Independent of the embedding job because it needs a
  // download per item rather than a model, and fails differently.
  if (config.media.perRun > 0) {
    scheduler.add({
      name: 'media',
      everyMs: config.media.intervalMin * MINUTE,
      onStart: false,
      run: async () => {
        const { runMedia } = await import('./media.ts');
        await runMedia();
      },
    });
  }

  // Learns what is normal for creators discovery only ever saw once, which is
  // what makes a breakout verdict possible for them at all.
  if (config.schedule.backfillPerRun > 0) {
    scheduler.add({
      name: 'backfill',
      everyMs: config.schedule.backfillMin * MINUTE,
      onStart: false,
      run: async () => {
        const { backfillCreators } = await import('./backfill.ts');
        await backfillCreators();
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
    // Not `onStart: true` — that would sweep on every restart, which on a
    // laptop is several times a day. Overdue is the question, not fresh.
    onStart: overdueForCleanup(),
    run: () => {
      runCleanup();
      kvSet('last_cleanup', String(nowSec()));
    },
  });
}

/**
 * Whether a sweep has been missed, rather than whether one is due.
 *
 * The timer alone could not keep retention running on the machine this is
 * built for. It fires after 24 hours of uninterrupted uptime, `reload()`
 * recreates every timer from zero on each settings save, and the product
 * installs itself to start at login — a Startup `.cmd`, a launchd agent, a
 * systemd *user* unit, all bounded by the login session. A laptop that is
 * closed each evening never reaches 24 hours, and `RUN_ON_START`, which the
 * limitations doc names as the compensation, feeds discover, analyze and embed
 * but not this one: cleanup was literally `onStart: false`.
 *
 * There is no cleanup endpoint and no generic job trigger, and `DELETE FROM
 * content` appears once in the whole codebase. So on that deployment retention
 * simply never applied. Measured on the live database: 222 MB with the oldest
 * content four days old — about 53 MB a day, against a documented promise of
 * "low hundreds of megabytes".
 *
 * The last sweep is now recorded, and a start that finds one missing does it
 * immediately. Neither a restart nor a settings save can skip a sweep any more,
 * and a machine that is genuinely up all week still sweeps once a day.
 */
function overdueForCleanup(): boolean {
  const last = Number(kvGet('last_cleanup') ?? 0);
  if (!Number.isFinite(last) || last <= 0) {
    // Never run. On an established database that is the case that matters, and
    // on a new one the sweep finds nothing and costs nothing.
    return true;
  }
  return nowSec() - last >= 24 * 3600;
}
