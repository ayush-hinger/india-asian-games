const env = (k: string, fallback?: string): string => {
  const v = process.env[k];
  if (v === undefined || v === "") {
    if (fallback === undefined)
      throw new Error(`Missing required env var ${k}`);
    return fallback;
  }
  return v;
};

export const config = {
  /** Upstream results backend. Scope is appended per request (ALL or a discipline code). */
  sourceRoot: env(
    "AG_SOURCE_ROOT",
    "https://back.results.asiangames2026.org/s/AG2026/en",
  ),
  /** The origin lock upstream enforces; requests without it are rejected. */
  sourceOrigin: "https://results.asiangames2026.org",
  contact: env("AG_CONTACT", "unset@example.com"),

  country: env("COUNTRY", "IND"),

  port: Number(env("PORT", "3000")),

  store: env("STORE", "sqlite") as "sqlite" | "postgres",
  sqlitePath: env("SQLITE_PATH", "./data/tracker.db"),
  databaseUrl: process.env.DATABASE_URL,

  redisUrl: process.env.REDIS_URL,

  pollerEnabled: env("POLLER_ENABLED", "1") !== "0",

  /**
   * Measured CDN behaviour: the `age` header climbs to ~27s then resets on a ~30s
   * cycle, so anything faster than this returns byte-identical cached data.
   * See docs/api-notes.md section 1.
   */
  cacheTtlSeconds: 30,

  reddit: {
    enabled: env("REDDIT_ENABLED", "1") !== "0",
    subreddit: env("REDDIT_SUBREDDIT", "IndianSports"),
    /** Matches the community's daily Asian Games megathread slug. */
    threadPattern: new RegExp(
      env("REDDIT_THREAD_PATTERN", "asian_games_2026_day_\\d+"),
      "i",
    ),
    /** Pin a specific thread instead of auto-discovering one. */
    threadUrl: process.env.REDDIT_THREAD_URL,
    /** The megathread changes once a day; discovery does not need to be frequent. */
    refreshMs: 15 * 60_000,
  },

  tiers: {
    /** Units currently RUNNING. One ALL/schedule/live-now call covers every live unit. */
    liveMs: 30_000,
    /** Units starting within `imminentWindowMs`. */
    imminentMs: 5 * 60_000,
    imminentWindowMs: 60 * 60_000,
    /** Everything else: the full India day schedule, twice a day. */
    backgroundMs: 12 * 60 * 60_000,
    /** Medal tally refresh. */
    medalsMs: 5 * 60_000,
  },
} as const;

export const userAgent = `IndiaAG2026Tracker/0.1 (+contact: ${config.contact})`;
