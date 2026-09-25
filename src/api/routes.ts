import { config } from "../config.ts";
import { todayJst } from "../domain/time.ts";
import type { Session } from "../domain/types.ts";
import type { Store } from "../store/index.ts";
import type { SseHub } from "./sse.ts";

export interface RouteContext {
  store: Store;
  sse: SseHub;
}

/**
 * Read models for the dashboard. All instants stay UTC here; the browser converts
 * to IST for display, so the API has exactly one time convention.
 */
export const routes = {
  async health(ctx: RouteContext) {
    return {
      ok: true,
      country: config.country,
      store: config.store,
      sseClients: ctx.sse.clientCount,
      catalogueSyncedAt: await ctx.store.getMeta("catalogue.syncedAt"),
      now: new Date().toISOString(),
    };
  },

  /**
   * The tracked country's schedule for one competition day (JST calendar).
   *
   * Filters: `sport` (a discipline code), `status` (one or more normalized status
   * values, comma-separated) and `live=1`. They compose, so
   * `?sport=HOC&live=1` is "hockey, in progress".
   */
  async schedule(ctx: RouteContext, params: URLSearchParams) {
    const date = params.get("date") ?? todayJst();
    const sport = params.get("sport") ?? undefined;

    const all = await ctx.store.getSessions({
      competitionDate: date,
      onlyTracked: true,
      sportCode: sport,
    });

    const sessions = applyFilters(all, params);

    return {
      date,
      sport: sport ?? null,
      count: sessions.length,
      /** Total before `status`/`live` were applied, so a UI can show "3 of 20". */
      totalForDay: all.length,
      /** Sports actually on the schedule that day, for populating a filter. */
      sports: summarizeSports(all),
      sessions,
    };
  },

  /** Sessions in progress right now, each with its current scoreboard. */
  async live(ctx: RouteContext, params: URLSearchParams) {
    const sessions = await ctx.store.getSessions({
      onlyTracked: true,
      onlyLive: true,
      sportCode: params.get("sport") ?? undefined,
    });
    const withResults = await Promise.all(
      sessions.map(async (session) => ({
        session,
        results: await ctx.store.getResults(session.id),
      })),
    );
    return { count: withResults.length, live: withResults };
  },

  /** Sessions starting soon - what the dashboard counts down to. */
  async upcoming(ctx: RouteContext, params: URLSearchParams) {
    const withinMs = Number(params.get("withinMinutes") ?? "240") * 60_000;
    const sessions = await ctx.store.getSessions({
      onlyTracked: true,
      startingWithinMs: Number.isFinite(withinMs) ? withinMs : 4 * 60 * 60_000,
      limit: 25,
    });
    return { count: sessions.length, sessions };
  },

  async medals(ctx: RouteContext) {
    const [tally, wins] = await Promise.all([
      ctx.store.getTally(),
      ctx.store.getMedalWins(config.country),
    ]);
    const own = tally.find((row) => row.orgCode === config.country) ?? null;
    return { country: config.country, own, wins, tally };
  },

  async sports(ctx: RouteContext) {
    const sports = await ctx.store.getSports();
    return { count: sports.length, sports: sports.filter((s) => s.tracked) };
  },

  /** Per-sport drill-down: every tracked session in that sport, newest day first. */
  async sport(ctx: RouteContext, params: URLSearchParams) {
    const code = params.get("code");
    if (!code) return { error: "code is required" };
    const sessions = await ctx.store.getSessions({ sportCode: code, onlyTracked: true });
    const participants = await ctx.store.getParticipants(code);
    return { code, sessions, participants };
  },

  async session(ctx: RouteContext, params: URLSearchParams) {
    const id = params.get("id");
    if (!id) return { error: "id is required" };
    const session = await ctx.store.getSession(id);
    if (!session) return { error: "not found" };
    return { session, results: await ctx.store.getResults(id) };
  },

  /**
   * The community megathread. `embedUrl` is frameable; `permalink` is where the
   * actual conversation happens, since the embed renders the post and not its
   * comment tree.
   */
  async discussion(ctx: RouteContext) {
    if (!config.reddit.enabled) return { enabled: false, thread: null };
    const raw = await ctx.store.getMeta("discussion.thread");
    if (!raw) return { enabled: true, thread: null };
    try {
      return { enabled: true, thread: JSON.parse(raw) };
    } catch {
      return { enabled: true, thread: null };
    }
  },

  async contingent(ctx: RouteContext) {
    const participants = await ctx.store.getParticipants();
    const bySport = new Map<string, number>();
    for (const p of participants) {
      bySport.set(p.sportCode, (bySport.get(p.sportCode) ?? 0) + 1);
    }
    return {
      country: config.country,
      total: participants.length,
      bySport: [...bySport].map(([sportCode, count]) => ({ sportCode, count }))
        .sort((a, b) => b.count - a.count),
    };
  },
};

/**
 * Group sessions by sport with counts, so a client can build a sport filter that
 * only offers sports which actually have something on that day.
 */
function summarizeSports(sessions: Session[]): { code: string; name: string; count: number }[] {
  const seen = new Map<string, { code: string; name: string; count: number }>();
  for (const s of sessions) {
    const entry = seen.get(s.sportCode);
    if (entry) entry.count += 1;
    else seen.set(s.sportCode, { code: s.sportCode, name: s.sportName || s.sportCode, count: 1 });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function applyFilters(sessions: Session[], params: URLSearchParams): Session[] {
  let out = sessions;

  if (params.get("live") === "1") {
    // `intermediate` means partial results posted mid-session, so it counts as
    // in progress even when the upstream IsLive flag has not been set.
    out = out.filter((s) => s.isLive || s.status === "intermediate");
  }

  const status = params.get("status");
  if (status) {
    const wanted = new Set(status.split(",").map((v) => v.trim()).filter(Boolean));
    out = out.filter((s) => wanted.has(s.status));
  }

  return out;
}
