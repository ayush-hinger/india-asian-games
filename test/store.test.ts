import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

// The store reads its path from config at construction, so point it at a scratch
// database before the module is imported.
const dir = mkdtempSync(join(tmpdir(), "ag2026-test-"));
process.env.SQLITE_PATH = join(dir, "test.db");
process.env.STORE = "sqlite";

const { SqliteStore } = await import("../src/store/sqlite.ts");
const { toSessions } = await import("../src/adapters/schedule.ts");
const { toResultEntries } = await import("../src/adapters/results.ts");
const { toTally } = await import("../src/adapters/medals.ts");
const { toMedalWins } = await import("../src/adapters/medals.ts");
const { fixture } = await import("./helpers.ts");

const store = new SqliteStore();

before(async () => { await store.init(); });
after(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("sessions: first write reports every row as changed", async () => {
  const sessions = toSessions(fixture("schedule-daily-sho"));
  const changed = await store.upsertSessions(sessions);
  assert.equal(changed.length, sessions.length);
});

test("sessions: rewriting identical data changes nothing", async () => {
  // This is what keeps the poller quiet: an unchanged poll must not write or emit.
  const sessions = toSessions(fixture("schedule-daily-sho"));
  const changed = await store.upsertSessions(sessions);
  assert.deepEqual(changed, []);
});

test("sessions: only the genuinely modified row is reported", async () => {
  const sessions = toSessions(fixture("schedule-daily-sho"));
  const [first, ...rest] = sessions;
  assert.ok(first);
  // Flip to a status the record does not already hold, so the edit is real.
  const flipped = first.status === "official" ? "scheduled" : "official";
  const changed = await store.upsertSessions([{ ...first, status: flipped }, ...rest]);
  assert.equal(changed.length, 1);
  assert.equal(changed[0]?.id, first.id);
});

test("sessions: queries filter by date, country and live state", async () => {
  const byDate = await store.getSessions({ competitionDate: "2026-09-20", onlyTracked: true });
  assert.ok(byDate.length > 0);
  assert.equal(byDate.every((s) => s.hasTrackedCountry), true);

  const bySport = await store.getSessions({ sportCode: "SHO" });
  assert.ok(bySport.length > 0);

  const none = await store.getSessions({ competitionDate: "2026-10-04", onlyTracked: true });
  assert.deepEqual(none, []);
});

test("sessions: results are ordered by start time", async () => {
  const rows = await store.getSessions({ competitionDate: "2026-09-20" });
  const times = rows.map((r) => r.startsAt);
  assert.deepEqual(times, [...times].sort());
});

test("results: change detection works per competitor", async () => {
  const id = "W.TEAM--------------.SFNL.000200--";
  const entries = toResultEntries(id, fixture("results-ckt-wsf2"));

  assert.equal((await store.upsertResults(id, entries)).length, entries.length);
  assert.deepEqual(await store.upsertResults(id, entries), []);

  const [first, ...rest] = entries;
  assert.ok(first);
  const changed = await store.upsertResults(id, [{ ...first, result: "120 - 4" }, ...rest]);
  assert.equal(changed.length, 1);

  const stored = await store.getResults(id);
  assert.equal(stored.length, entries.length);
  assert.equal(stored.find((r) => r.regId === first.regId)?.result, "120 - 4");
});

test("medals: tally and wins round-trip and dedupe", async () => {
  const tally = toTally(fixture("medals-standings"));
  assert.equal((await store.upsertTally(tally)).length, tally.length);
  assert.deepEqual(await store.upsertTally(tally), []);

  const read = await store.getTally();
  assert.equal(read.length, tally.length);
  assert.equal(read[0]?.rankByGold, 1);

  const wins = toMedalWins(fixture("medals-org-ind"));
  assert.equal((await store.upsertMedalWins(wins)).length, 1);
  assert.deepEqual(await store.upsertMedalWins(wins), []);
  assert.equal((await store.getMedalWins("IND")).length, 1);
  assert.deepEqual(await store.getMedalWins("CHN"), []);
});

test("meta: round-trips and returns null for unknown keys", async () => {
  await store.setMeta("catalogue.syncedAt", "2026-09-20T00:00:00.000Z");
  assert.equal(await store.getMeta("catalogue.syncedAt"), "2026-09-20T00:00:00.000Z");
  assert.equal(await store.getMeta("nope"), null);
});

test("sessions: two different sports sharing an upstream ResCode do not clobber each other", async () => {
  // Regression test for the exact bug reported live: on 2026-09-23, Badminton's
  // Men's Team Semifinal Tie 2 (India vs China) and Table Tennis's Men's Team
  // Semifinal Match 2 (Korea vs Japan) both used the identical upstream ResCode
  // "M.TEAM--------------.SFNL.00020000" - it is a generic event/phase/unit
  // template, not a globally unique id. Storing sessions keyed on the bare
  // ResCode let whichever sport's poll ran last silently overwrite the other's
  // row, which is how India's scheduled badminton match disappeared from the
  // schedule entirely. The fix scopes the storage key by sport
  // (compositeSessionId), so both rows must survive side by side.
  const sharedResCode = "M.TEAM--------------.SFNL.00020000";
  const badminton = toSessions([{
    ResCode: sharedResCode, Disc: "BDM", DiscDesc: "Badminton",
    DateTimeRaw: "2026-09-23T15:00:00+09:00", Status: "SCHEDULED",
    Orgs: ["IND", "CHN"], UnitDesc: "Men's Team Semifinals Tie 2",
  }] as never);
  const tableTennis = toSessions([{
    ResCode: sharedResCode, Disc: "TTE", DiscDesc: "Table Tennis",
    DateTimeRaw: "2026-09-23T06:00:00+09:00", Status: "RUNNING",
    Orgs: ["KOR", "JPN"], UnitDesc: "Men's Team Semifinals Match 2",
  }] as never);

  assert.notEqual(badminton[0]?.id, tableTennis[0]?.id, "ids must not collide");

  // Badminton's sweep, then table tennis's - the write order that triggered the
  // bug, since whichever discipline's tier ran last used to win the shared row.
  await store.upsertSessions(badminton);
  await store.upsertSessions(tableTennis);

  const bdm = await store.getSession(badminton[0]!.id);
  const tte = await store.getSession(tableTennis[0]!.id);

  assert.ok(bdm, "the badminton session must still exist");
  assert.equal(bdm.sportCode, "BDM");
  assert.deepEqual(bdm.orgs, ["IND", "CHN"]);
  assert.equal(bdm.hasTrackedCountry, true, "India's badminton tie must be tracked");

  assert.ok(tte, "the table tennis session must still exist");
  assert.equal(tte.sportCode, "TTE");
  assert.deepEqual(tte.orgs, ["KOR", "JPN"]);

  // Both must appear in a same-day query, not just one survivor.
  const day = await store.getSessions({ competitionDate: "2026-09-23" });
  const ids = day.map((s) => s.id);
  assert.ok(ids.includes(badminton[0]!.id));
  assert.ok(ids.includes(tableTennis[0]!.id));
});
