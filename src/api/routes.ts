import { config } from "../config.ts";
import { todayJst } from "../domain/time.ts";
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

  /** The tracked country's schedule for one competition day (JST calendar). */
  async schedule(ctx: RouteContext, params: URLSearchParams) {
    const date = params.get("date") ?? todayJst();
    const sessions = await ctx.store.getSessions({
      competitionDate: date,
      onlyTracked: true,
      sportCode: params.get("sport") ?? undefined,
    });
    return { date, count: sessions.length, sessions };
  },

  /** Sessions in progress right now, each with its current scoreboard. */
  async live(ctx: RouteContext) {
    const sessions = await ctx.store.getSessions({ onlyTracked: true, onlyLive: true });
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
