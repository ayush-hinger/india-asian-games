import { config } from "../config.ts";
import { todayJst } from "../domain/time.ts";
import { log } from "../log.ts";
import type { TaskContext } from "./tasks.ts";
import {
  syncCatalogue, syncDiscussion, syncLive, syncMedals, syncPending, syncScheduleForDate,
} from "./tasks.ts";

interface Tier {
  name: string;
  everyMs: number;
  run: () => Promise<void>;
  /** Skip a tick entirely when this returns false - the cheapest possible poll. */
  when?: () => Promise<boolean>;
}

/**
 * Adaptive tiered poller.
 *
 * Each tier runs on its own interval and re-arms only after its previous run has
 * finished, so a slow upstream stretches the cadence instead of piling up requests.
 * No tier ticks faster than the measured 30s CDN TTL, below which the edge returns
 * byte-identical data (docs/api-notes.md section 1).
 *
 * The tiers, cheapest first:
 *  - background  every 12h  catalogue + the full tracked schedule
 *  - medals      every 5m   tally and the tracked country's wins
 *  - imminent    every 5m   results for sessions starting within the hour, and any
 *                           session still UNOFFICIAL
 *  - live        every 30s  one live-now call, plus per-session results for the
 *                           field sports that do not carry a score inline
 */
export class Poller {
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;

  private readonly ctx: TaskContext;

  constructor(ctx: TaskContext) {
    this.ctx = ctx;
  }

  async start(): Promise<void> {
    const floorMs = config.cacheTtlSeconds * 1000;

    const tiers: Tier[] = [
      {
        name: "background",
        everyMs: config.tiers.backgroundMs,
        run: async () => {
          await syncCatalogue(this.ctx);
          await this.syncScheduleWindow();
        },
      },
      {
        name: "discussion",
        everyMs: config.reddit.refreshMs,
        run: async () => { await syncDiscussion(this.ctx); },
      },
      {
        name: "medals",
        everyMs: config.tiers.medalsMs,
        run: () => syncMedals(this.ctx),
      },
      {
        name: "imminent",
        everyMs: config.tiers.imminentMs,
        run: async () => {
          // Refresh today's schedule so status transitions (SCHEDULED -> START_LIST
          // -> RUNNING) are picked up before the live tier needs them.
          await syncScheduleForDate(this.ctx, todayJst());
          await syncPending(this.ctx);
        },
        when: async () => {
          const soon = await this.ctx.store.getSessions({
            onlyTracked: true,
            startingWithinMs: config.tiers.imminentWindowMs,
            limit: 1,
          });
          if (soon.length > 0) return true;
          const live = await this.ctx.store.getSessions({ onlyTracked: true, onlyLive: true, limit: 1 });
          return live.length > 0;
        },
      },
      {
        name: "live",
        everyMs: Math.max(config.tiers.liveMs, floorMs),
        run: async () => { await syncLive(this.ctx); },
        // Only poll live when something of ours is actually in progress or about
        // to be; overnight this tier costs nothing.
        when: async () => {
          const live = await this.ctx.store.getSessions({ onlyTracked: true, onlyLive: true, limit: 1 });
          if (live.length > 0) return true;
          const soon = await this.ctx.store.getSessions({
            onlyTracked: true,
            startingWithinMs: 15 * 60_000,
            limit: 1,
          });
          return soon.length > 0;
        },
      },
    ];

    // Prime the store before the fast tiers start, so `when` guards have data to
    // read and the API can serve immediately on a cold start.
    log.info("poller priming");
    await this.safeRun("bootstrap", async () => {
      await syncCatalogue(this.ctx);
      await this.syncScheduleWindow();
      await syncMedals(this.ctx);
      await syncLive(this.ctx);
      await syncDiscussion(this.ctx);
    });
    log.info("poller primed");

    for (const tier of tiers) this.schedule(tier);
  }

  /** Today plus the next two days - enough lead time for the imminent tier. */
  private async syncScheduleWindow(): Promise<void> {
    const base = Date.parse(`${todayJst()}T00:00:00Z`);
    for (let i = 0; i < 3; i++) {
      const date = new Date(base + i * 86_400_000).toISOString().slice(0, 10);
      await syncScheduleForDate(this.ctx, date);
    }
  }

  private schedule(tier: Tier): void {
    const tick = async () => {
      if (this.stopped) return;
      try {
        if (!tier.when || (await tier.when())) {
          await this.safeRun(tier.name, tier.run);
        } else {
          log.debug("tier idle", { tier: tier.name });
        }
      } finally {
        if (!this.stopped) {
          // Re-arm only after the run settles, so slow upstream responses stretch
          // the interval rather than overlapping requests.
          this.timers.push(setTimeout(tick, tier.everyMs));
        }
      }
    };
    this.timers.push(setTimeout(tick, tier.everyMs));
    log.info("tier scheduled", { tier: tier.name, everyMs: tier.everyMs });
  }

  /** A failing tier must never take down the process or stop future ticks. */
  private async safeRun(name: string, fn: () => Promise<void>): Promise<void> {
    const started = Date.now();
    try {
      await fn();
      log.debug("tier ok", { tier: name, ms: Date.now() - started });
    } catch (err) {
      log.error("tier failed", { tier: name, ms: Date.now() - started, err });
    }
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}
