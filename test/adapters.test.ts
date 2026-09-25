import assert from "node:assert/strict";
import { test } from "node:test";
import { toContingentTotals, toParticipants, toSports, toTrackedSportCodes } from "../src/adapters/entries.ts";
import { toMedalWins, toTally } from "../src/adapters/medals.ts";
import { toLiveState, toResultEntries } from "../src/adapters/results.ts";
import { filterTracked, toSession, toSessions } from "../src/adapters/schedule.ts";
import { hashRecord } from "../src/domain/hash.ts";
import { competitionDate, toIstTime, toUtc } from "../src/domain/time.ts";
import type {
  RawContingent, RawDiscipline, RawEntriesByOrg, RawMedalEvent,
  RawMedalStanding, RawResultPayload, RawScheduleUnit,
} from "../src/source/types.ts";
import { fixture } from "./helpers.ts";

// ------------------------------------------------------------------ schedule

test("schedule: maps a real unit onto the normalized session", () => {
  const sessions = toSessions(fixture<RawScheduleUnit[]>("schedule-daily-ckt"));
  const match = sessions.find((s) => s.resCode === "W.TEAM--------------.SFNL.000200--");
  assert.ok(match, "expected the captured cricket semifinal");
  // id is scoped by sport: the bare ResCode is not unique across disciplines
  // (confirmed collision between Badminton and Table Tennis - see Session.id).
  assert.equal(match.id, "CKT:W.TEAM--------------.SFNL.000200--");

  assert.equal(match.sportCode, "CKT");
  assert.equal(match.sportName, "Cricket");
  assert.equal(match.title, "Women's Semifinal 2");
  assert.equal(match.status, "running");
  assert.equal(match.isLive, true);
  assert.equal(match.isHeadToHead, true);
  assert.equal(match.participantType, "team");
  assert.deepEqual(match.orgs, ["BAN", "IND"]);
  assert.equal(match.hasTrackedCountry, true);
  // Source sends 14:00+09:00; storage is UTC.
  assert.equal(match.startsAt, "2026-09-20T05:00:00.000Z");
});

test("schedule: the all-sports day route carries no country data, so nothing matches", () => {
  // The finding that drives sessions_of_interest - see docs/api-notes.md section 3.
  const sessions = toSessions(fixture<RawScheduleUnit[]>("schedule-day-all"));
  assert.ok(sessions.length > 200, "expected a full day of units");
  assert.equal(sessions.every((s) => s.orgs.length === 0), true);
  assert.equal(filterTracked(sessions).length, 0);
});

test("schedule: the per-discipline route does carry country data", () => {
  const sessions = toSessions(fixture<RawScheduleUnit[]>("schedule-daily-sho"));
  assert.ok(sessions.length > 0);
  assert.equal(sessions.every((s) => s.orgs.length > 0), true);
  assert.equal(filterTracked(sessions).length, 3);
});

test("schedule: medal sessions are flagged from the string Medal field", () => {
  const sessions = toSessions(fixture<RawScheduleUnit[]>("schedule-daily-sho"));
  const medalSession = sessions.find((s) => s.isMedalSession);
  assert.ok(medalSession, "shooting finals decide medals");
});

test("schedule: drops records with no id or no start time", () => {
  assert.equal(toSession({ DateTimeRaw: "2026-09-20T10:00:00+09:00" }), null);
  assert.equal(toSession({ ResCode: "X" }), null);
});

test("schedule: drops a record with no Disc, rather than risk an unscoped id", () => {
  // Every real route this feeds from always sends Disc; if it were ever missing,
  // storing the bare ResCode would risk exactly the cross-sport collision that
  // motivated the composite id in the first place.
  assert.equal(
    toSession({ ResCode: "X", DateTimeRaw: "2026-09-20T10:00:00+09:00" }),
    null,
  );
});

test("schedule: survives a malformed record inside a good batch", () => {
  const raw = [
    { ResCode: "A", Disc: "HOC", DateTimeRaw: "2026-09-20T10:00:00+09:00", Orgs: ["IND"] },
    { ResCode: "B", Disc: "HOC" },
    { ResCode: "C", Disc: "HOC", DateTimeRaw: "bogus" },
    { ResCode: "D", Disc: "HOC", DateTimeRaw: "2026-09-20T11:00:00+09:00", Orgs: null as never },
  ] as RawScheduleUnit[];
  const sessions = toSessions(raw);
  assert.deepEqual(sessions.map((s) => s.id), ["HOC:A", "HOC:D"]);
  assert.deepEqual(sessions[1]?.orgs, []);
});

test("schedule: an unknown status degrades instead of throwing", () => {
  const session = toSession({
    ResCode: "Z", Disc: "HOC", DateTimeRaw: "2026-09-20T10:00:00+09:00", Status: "SOMETHING_NEW",
  });
  assert.equal(session?.status, "unknown");
});

// ------------------------------------------------------------------- results

test("results: maps competitors from a real payload", () => {
  const payload = fixture<RawResultPayload>("results-ckt-wsf2");
  const entries = toResultEntries("W.TEAM--------------.SFNL.000200--", payload);

  assert.equal(entries.length, 2);
  const india = entries.find((e) => e.orgCode === "IND");
  assert.ok(india, "expected India among the competitors");
  assert.equal(india.name, "India");
  assert.equal(typeof india.rank, "string");
  assert.equal(typeof india.rankSort, "number");
  // Sport-specific stats are kept opaque rather than modelled per sport.
  assert.ok("ST_TEAM_WICKETS" in india.stats);
});

test("results: tolerates a missing Competitors block", () => {
  assert.deepEqual(toResultEntries("X", {}), []);
  assert.deepEqual(toResultEntries("X", undefined), []);
  assert.deepEqual(toResultEntries("X", { Competitors: "nope" as never }), []);
});

test("live: head-to-head units expose both sides inline", () => {
  const units = fixture<RawScheduleUnit[]>("schedule-live-now");
  const h2h = units.find((u) => u.isH2H && u.Home && u.Away);
  assert.ok(h2h, "expected a head-to-head unit in the live capture");

  const live = toLiveState(h2h);
  assert.ok(live);
  assert.equal(live.sides.length, 2);
  assert.equal(live.isLive, true);
  assert.ok(live.periods.length > 0);
});

test("live: field sports have no sides and fall back to standings", () => {
  const units = fixture<RawScheduleUnit[]>("schedule-live-now");
  const field = units.find((u) => !u.isH2H);
  assert.ok(field, "expected a non-head-to-head unit");

  const live = toLiveState(field);
  assert.ok(live);
  assert.equal(live.sides.length, 0);
  assert.deepEqual(live.standings, []);

  const withResults = toLiveState(field, fixture<RawResultPayload>("results-ckt-wsf2"));
  assert.ok(withResults!.standings.length > 0, "results payload supplies the scoreboard");
});

// -------------------------------------------------------------------- medals

test("medals: builds the tally and keeps both ranking schemes apart", () => {
  const tally = toTally(fixture<RawMedalStanding[]>("medals-standings"));
  assert.ok(tally.length > 0);

  const leader = tally[0];
  assert.ok(leader);
  assert.equal(leader.rankByGold, 1);
  assert.equal(leader.total, leader.gold + leader.silver + leader.bronze);

  // Gold-first and total-medal ranks genuinely diverge in the captured data.
  assert.ok(tally.some((row) => row.rankByGold !== row.rankByTotal));
});

test("medals: maps India's captured silver, including team members", () => {
  const wins = toMedalWins(fixture<RawMedalEvent[]>("medals-org-ind"));
  assert.equal(wins.length, 1);

  const win = wins[0];
  assert.ok(win);
  assert.equal(win.medal, "silver");
  assert.equal(win.orgCode, "IND");
  assert.equal(win.sportCode, "SHO");
  assert.equal(win.eventName, "10m Air Rifle Women Team");
  assert.equal(win.isTeam, true);
  assert.equal(win.members.length, 3);
  assert.equal(win.wonAt, "2026-09-20T04:18:00.000Z");
});

test("medals: the latest feed maps every medal kind", () => {
  const wins = toMedalWins(fixture<RawMedalEvent[]>("medals-latest"));
  const kinds = new Set(wins.map((w) => w.medal));
  assert.ok(kinds.size >= 2);
  assert.equal([...kinds].every((k) => ["gold", "silver", "bronze"].includes(k)), true);
  // Sorted newest first.
  const sorted = [...wins].sort((a, b) => b.wonAt.localeCompare(a.wonAt));
  assert.deepEqual(wins.map((w) => w.wonAt), sorted.map((w) => w.wonAt));
});

// ------------------------------------------------------------------- entries

test("entries: the contingent summary yields the polling allow-list", () => {
  const raw = fixture<RawContingent>("entries-org-ind-all");
  const codes = toTrackedSportCodes(raw);
  const totals = toContingentTotals(raw);

  assert.equal(codes.length, 37);
  assert.ok(codes.includes("SHO") && codes.includes("HOC"));
  assert.equal(totals.total, 499);
  assert.equal(totals.men + totals.women, totals.total);
});

test("entries: flattens a sport roster into participants", () => {
  const participants = toParticipants(fixture<RawEntriesByOrg>("entries-org-ind-sho"));
  assert.ok(participants.length > 0);
  assert.equal(participants.every((p) => p.orgCode === "IND"), true);
  assert.equal(participants.every((p) => p.sportCode === "SHO"), true);
  assert.equal(participants.every((p) => p.regId !== ""), true);

  const rudrankksh = participants.find((p) => p.name.startsWith("PATIL Rudrankksh"));
  assert.ok(rudrankksh);
  assert.equal(rudrankksh.regId, "12403803");
  assert.equal(rudrankksh.type, "athlete");
  assert.equal(rudrankksh.birthDate, "2003-12-16");
});

test("entries: marks tracked sports in the discipline catalogue", () => {
  const tracked = new Set(toTrackedSportCodes(fixture<RawContingent>("entries-org-ind-all")));
  const sports = toSports(fixture<RawDiscipline[]>("disc-data"), tracked);

  assert.equal(sports.length, 59);
  assert.equal(sports.filter((s) => s.tracked).length, 37);
  assert.equal(sports.find((s) => s.code === "SHO")?.tracked, true);
  assert.ok((sports.find((s) => s.code === "HOC")?.competitionDays.length ?? 0) > 0);
});

// ---------------------------------------------------------------- time + hash

test("time: JST timestamps convert to UTC and back to IST", () => {
  const utc = toUtc("2026-09-20T14:00:00+09:00");
  assert.equal(utc, "2026-09-20T05:00:00.000Z");
  assert.equal(toIstTime(utc!), "10:30");
  assert.equal(competitionDate(utc!), "2026-09-20");
});

test("time: a late-evening JST session keeps its own competition date", () => {
  // 21:30 JST is 12:00 UTC on the same day - a naive UTC slice would be right here,
  // but 00:30 JST the next day is 15:30 UTC the day before, which it would get wrong.
  const late = toUtc("2026-09-21T00:30:00+09:00");
  assert.equal(late, "2026-09-20T15:30:00.000Z");
  assert.equal(competitionDate(late!), "2026-09-21");
});

test("time: a bad timestamp yields null rather than throwing", () => {
  assert.equal(toUtc("not a date"), null);
  assert.equal(toUtc(undefined), null);
  assert.equal(toUtc(""), null);
});

test("hash: stable across key order, sensitive to values", () => {
  assert.equal(hashRecord({ a: 1, b: [2, 3] }), hashRecord({ b: [2, 3], a: 1 }));
  assert.notEqual(hashRecord({ a: 1 }), hashRecord({ a: 2 }));
  // Array order is meaningful and must not be normalized away.
  assert.notEqual(hashRecord([1, 2]), hashRecord([2, 1]));
});

test("hash: an unchanged session hashes identically across adapter runs", () => {
  const raw = fixture<RawScheduleUnit[]>("schedule-daily-sho");
  assert.equal(hashRecord(toSessions(raw)), hashRecord(toSessions(raw)));
});

// ------------------------------------------- head-to-head scoreboard projection

test("live: head-to-head sides project onto the shared result row shape", async () => {
  const { sidesToResultEntries } = await import("../src/adapters/results.ts");
  const units = fixture<RawScheduleUnit[]>("schedule-live-now");
  const h2h = units.find((u) => u.isH2H && u.Home && u.Away);
  assert.ok(h2h);

  const entries = sidesToResultEntries(h2h);
  assert.equal(entries.length, 2);
  // Scoped by sport, not the bare ResCode - see Session.id for why that matters.
  assert.equal(entries[0]?.sessionId, `${h2h.Disc}:${h2h.ResCode}`);
  assert.ok(entries[0]?.regId, "a stable key is always produced");
  assert.ok(entries.every((e) => e.orgCode !== ""));
  // Start order is preserved so Home renders above Away.
  assert.deepEqual(entries.map((e) => e.rankSort), [1, 2]);
});

test("live: a side missing its Reg still gets a unique key", async () => {
  const { sidesToResultEntries } = await import("../src/adapters/results.ts");
  const entries = sidesToResultEntries({
    ResCode: "UNIT-1",
    Home: { Org: "IND", Name: "India", Result: "2" },
    Away: { Org: "PAK", Name: "Pakistan", Result: "1" },
  });
  assert.equal(entries.length, 2);
  assert.equal(new Set(entries.map((e) => e.regId)).size, 2);
});

test("status: the values discovered after Phase 0 now map cleanly", async () => {
  // PROVISIONAL and INTERMEDIATE only appeared once the Games were under way.
  const provisional = toSession({
    ResCode: "P", Disc: "SHO", DateTimeRaw: "2026-09-20T10:00:00+09:00", Status: "PROVISIONAL",
  });
  const intermediate = toSession({
    ResCode: "I", Disc: "SHO", DateTimeRaw: "2026-09-20T10:00:00+09:00", Status: "INTERMEDIATE",
  });
  assert.equal(provisional?.status, "provisional");
  assert.equal(intermediate?.status, "intermediate");

  const { PENDING_STATUSES, FINAL_STATUSES } = await import("../src/domain/types.ts");
  assert.equal(PENDING_STATUSES.has("provisional"), true);
  assert.equal(PENDING_STATUSES.has("intermediate"), true);
  assert.equal(FINAL_STATUSES.has("provisional"), false);
});

test("status: DELAYED maps to a pre-event status, not a pending one", async () => {
  // Turned up on 23 Sep, days after PROVISIONAL and INTERMEDIATE.
  const delayed = toSession({
    ResCode: "D", Disc: "BDM", DateTimeRaw: "2026-09-23T10:00:00+09:00", Status: "DELAYED",
  });
  assert.equal(delayed?.status, "delayed");
  assert.equal(delayed?.isLive, false);

  const { PENDING_STATUSES } = await import("../src/domain/types.ts");
  // Nothing has happened yet, so it must not enter the results-polling rotation.
  assert.equal(PENDING_STATUSES.has("delayed"), false);
});
