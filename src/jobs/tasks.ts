import { toParticipants, toSports, toTrackedSportCodes } from "../adapters/entries.ts";
import { toMedalWins, toTally } from "../adapters/medals.ts";
import { sidesToResultEntries, toLiveState, toResultEntries } from "../adapters/results.ts";
import { toSessions } from "../adapters/schedule.ts";
import type { Bus } from "../bus/index.ts";
import { config } from "../config.ts";
import { todayJst } from "../domain/time.ts";
import { PENDING_STATUSES, type Session } from "../domain/types.ts";
import { log } from "../log.ts";
import * as api from "../source/endpoints.ts";
import { fetchDiscussionThread, selectThread, type DiscussionThread } from "../source/reddit.ts";
import type { Store } from "../store/index.ts";
import { runPooled } from "./pool.ts";

export interface TaskContext {
  store: Store;
  bus: Bus;
}

/**
 * Sports catalogue plus the tracked country's roster.
 *
 * Establishes the polling allow-list: the country is entered in 37 of 59
 * disciplines, so the other 22 never need a schedule request at all.
 */
export async function syncCatalogue({ store, bus: _bus }: TaskContext): Promise<string[]> {
  const contingent = await api.contingent(config.country);
  const trackedCodes = toTrackedSportCodes(contingent.data);
  const tracked = new Set(trackedCodes);

  const discs = await api.disciplines();
  const sports = toSports(discs.data, tracked);
  await store.upsertSports(sports);

  const rosters = await runPooled(trackedCodes, async (code) => {
    const roster = await api.rosterForSport(code, config.country);
    const participants = toParticipants(roster ?? undefined);
    if (participants.length > 0) await store.upsertParticipants(participants);
    return participants.length;
  }, { concurrency: 3, gapMs: 150 });

  const athletes = rosters.reduce((sum, r) => sum + (r.status === "fulfilled" ? r.value : 0), 0);
  await store.setMeta("catalogue.syncedAt", new Date().toISOString());
  await store.setMeta("catalogue.trackedSports", JSON.stringify(trackedCodes));

  log.info("catalogue synced", { sports: sports.length, trackedSports: trackedCodes.length, athletes });
  return trackedCodes;
}

async function trackedSportCodes(store: Store): Promise<string[]> {
  const cached = await store.getMeta("catalogue.trackedSports");
  if (cached) {
    try {
      return JSON.parse(cached) as string[];
    } catch {
      log.warn("catalogue cache unreadable, falling back to sports table");
    }
  }
  return (await store.getSports()).filter((s) => s.tracked).map((s) => s.code);
}

/**
 * Build the sessions-of-interest set for a date.
 *
 * Uses the per-discipline route, which is the only one carrying participant
 * countries - the all-sports day route has none and cannot be filtered.
 * See docs/api-notes.md section 3.
 */
export async function syncScheduleForDate(ctx: TaskContext, date: string): Promise<number> {
  const codes = await trackedSportCodes(ctx.store);
  if (codes.length === 0) {
    log.warn("no tracked sports known; run the catalogue sync first");
    return 0;
  }

  let stored = 0;
  let tracked = 0;

  const outcomes = await runPooled(codes, async (code) => {
    const { data } = await api.disciplineDay(code, date);
    const sessions = toSessions(data);
    if (sessions.length === 0) return 0;

    const changed = await ctx.store.upsertSessions(sessions);
    stored += sessions.length;
    tracked += sessions.filter((s) => s.hasTrackedCountry).length;
    for (const session of changed) {
      if (session.hasTrackedCountry) ctx.bus.publish({ type: "session.updated", session });
    }
    return changed.length;
  }, { concurrency: 4, gapMs: 120 });

  const failed = outcomes.filter((o) => o.status === "rejected").length;
  log.info("schedule synced", { date, sports: codes.length, units: stored, tracked, failed });
  return tracked;
}

/**
 * Refresh every currently-running session.
 *
 * One ALL/schedule/live-now call covers the whole Games, so the live tier costs a
 * single request regardless of how many sessions are in progress. Head-to-head
 * sports carry their score inline; field sports need a per-session results call,
 * and only tracked sessions are worth that.
 */
export async function syncLive(ctx: TaskContext): Promise<number> {
  const { data, age } = await api.liveNow();
  const sessions = toSessions(data);
  await ctx.store.upsertSessions(sessions);

  const relevant = (data ?? []).filter((raw) =>
    Array.isArray(raw.Orgs) && raw.Orgs.includes(config.country));

  for (const raw of relevant) {
    const live = toLiveState(raw);
    if (!live) continue;

    if (live.sides.length > 0) {
      // Head-to-head: the score is already inline, so no extra request is needed.
      const entries = sidesToResultEntries(raw);
      const changed = await ctx.store.upsertResults(live.sessionId, entries);
      live.standings = entries;
      if (changed.length > 0) {
        ctx.bus.publish({ type: "results.updated", sessionId: live.sessionId, results: entries });
      }
    } else if (raw.Disc && live.sessionId) {
      // Field sports (heats, finals) carry no Home/Away, so the scoreboard is only
      // available from the separate results payload - one request per session.
      // The upstream call needs the raw ResCode, not our composite storage id.
      const resCode = raw.ResCode || raw.Key || "";
      try {
        const payload = await api.results(raw.Disc, resCode);
        const entries = toResultEntries(live.sessionId, payload.data);
        const changed = await ctx.store.upsertResults(live.sessionId, entries);
        live.standings = entries;
        if (changed.length > 0) {
          ctx.bus.publish({ type: "results.updated", sessionId: live.sessionId, results: entries });
        }
      } catch (err) {
        log.warn("live results fetch failed", { sessionId: live.sessionId, err });
      }
    }
    ctx.bus.publish({ type: "live.updated", live });
  }

  log.debug("live synced", { live: sessions.length, tracked: relevant.length, cacheAge: age });
  return relevant.length;
}

/** Pull the full result payload for one session and emit what changed. */
export async function syncResultsFor(ctx: TaskContext, session: Session): Promise<number> {
  if (!session.sportCode) return 0;
  try {
    // resCode is the raw upstream code the source expects; session.id is our own
    // sportCode-scoped storage key and would 404 if sent here.
    const { data } = await api.results(session.sportCode, session.resCode);
    const entries = toResultEntries(session.id, data);
    const changed = await ctx.store.upsertResults(session.id, entries);
    if (changed.length > 0) {
      ctx.bus.publish({ type: "results.updated", sessionId: session.id, results: entries });
    }
    return changed.length;
  } catch (err) {
    log.warn("results sync failed", { sessionId: session.id, err });
    return 0;
  }
}

export async function syncMedals(ctx: TaskContext): Promise<void> {
  const [standings, own] = await Promise.all([
    api.medalStandings(),
    api.medalsForOrg(config.country),
  ]);

  const tally = toTally(standings.data);
  const changedTally = await ctx.store.upsertTally(tally);
  if (changedTally.length > 0) ctx.bus.publish({ type: "medals.updated", tally });

  const wins = toMedalWins(own.data);
  const newWins = await ctx.store.upsertMedalWins(wins);
  for (const win of newWins) ctx.bus.publish({ type: "medal.won", win });

  if (changedTally.length > 0 || newWins.length > 0) {
    log.info("medals updated", { tallyRows: changedTally.length, newWins: newWins.length });
  }
}

/**
 * Sessions that are under way or finished but not yet OFFICIAL. Provisional and
 * unofficial results can still be corrected, so they stay in rotation until confirmed.
 */
export async function syncPending(ctx: TaskContext): Promise<number> {
  const today = todayJst();
  const sessions = await ctx.store.getSessions({ competitionDate: today, onlyTracked: true });
  const pending = sessions.filter((s) => PENDING_STATUSES.has(s.status));

  const outcomes = await runPooled(pending, (s) => syncResultsFor(ctx, s), {
    concurrency: 3,
    gapMs: 150,
  });
  return outcomes.filter((o) => o.status === "fulfilled" && o.value > 0).length;
}

/**
 * Refresh the community discussion thread shown alongside the tracker.
 *
 * Entirely optional: a Reddit failure logs and leaves the previous thread in
 * place rather than blanking the panel or failing the tick.
 */
export async function syncDiscussion(ctx: TaskContext): Promise<DiscussionThread | null> {
  if (!config.reddit.enabled) return null;

  // An explicitly pinned thread wins over discovery.
  if (config.reddit.threadUrl) {
    const m = config.reddit.threadUrl.match(/\/r\/([^/]+)\/comments\/([a-z0-9]+)\/([a-z0-9_]+)/i);
    if (m?.[1] && m[2] && m[3]) {
      const pinned = selectThread([{ id: m[2], slug: m[3] }], m[1], /.*/);
      if (pinned) {
        await ctx.store.setMeta("discussion.thread", JSON.stringify(pinned));
        return pinned;
      }
    }
    log.warn("REDDIT_THREAD_URL is not a recognisable thread link; falling back to discovery");
  }

  const thread = await fetchDiscussionThread();
  if (!thread) return null;

  const previous = await ctx.store.getMeta("discussion.thread");
  await ctx.store.setMeta("discussion.thread", JSON.stringify(thread));

  // Only announce a genuinely different thread - the daily rollover.
  if (previous) {
    try {
      if ((JSON.parse(previous) as DiscussionThread).id !== thread.id) {
        ctx.bus.publish({ type: "discussion.updated", thread });
      }
    } catch {
      ctx.bus.publish({ type: "discussion.updated", thread });
    }
  }
  return thread;
}
