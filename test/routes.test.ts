import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "ag2026-routes-"));
process.env.SQLITE_PATH = join(dir, "routes.db");
process.env.STORE = "sqlite";

const { SqliteStore } = await import("../src/store/sqlite.ts");
const { routes } = await import("../src/api/routes.ts");
const { competitionDate } = await import("../src/domain/time.ts");
const { toSessions } = await import("../src/adapters/schedule.ts");
const { fixture } = await import("./helpers.ts");

const store = new SqliteStore();
// Only `sseClients` on /api/health reads this, so a stub is enough.
const ctx = { store, sse: { clientCount: 0 } } as never;

let day: string;

before(async () => {
  await store.init();
  // Two sports on one day, with a spread of statuses to filter across.
  const sessions = [
    ...toSessions(fixture("schedule-daily-sho")),
    ...toSessions(fixture("schedule-daily-ckt")),
  ].filter((s) => s.hasTrackedCountry);
  assert.ok(sessions.length >= 4, "fixtures should yield several India sessions");
  await store.upsertSessions(sessions);
  day = competitionDate(sessions[0]!.startsAt);
});

after(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = (qs: string) => routes.schedule(ctx, new URLSearchParams(qs));

test("unfiltered: returns the whole day and reports the sports on it", async () => {
  const res = await call(`date=${day}`);
  assert.equal(res.count, res.totalForDay);
  assert.ok(res.count >= 4);
  assert.deepEqual(res.sports, []);

  const codes = res.sportOptions.map((s) => s.code).sort();
  assert.deepEqual(codes, ["CKT", "SHO"]);
  // Counts must add up to the day's total, or a sport filter would mislead.
  assert.equal(res.sportOptions.reduce((n, s) => n + s.count, 0), res.totalForDay);
  assert.equal(res.sportOptions.every((s) => s.name !== ""), true);
});

test("sport filter narrows to one discipline", async () => {
  const res = await call(`date=${day}&sport=SHO`);
  assert.ok(res.count > 0);
  assert.equal(res.sessions.every((s) => s.sportCode === "SHO"), true);
  assert.deepEqual(res.sports, ["SHO"]);
  // totalForDay stays the whole day now, so "n of m" reflects the filter's effect.
  assert.equal(res.totalForDay, res.sportOptions.reduce((n, s) => n + s.count, 0));
});

test("sports filter (plural, comma-separated) selects several disciplines", async () => {
  const res = await call(`date=${day}&sports=SHO,CKT`);
  assert.equal(res.count, res.totalForDay, "the fixtures only contain these two sports");
  assert.deepEqual(new Set(res.sports), new Set(["SHO", "CKT"]));
  assert.equal(res.sessions.every((s) => ["SHO", "CKT"].includes(s.sportCode)), true);

  const narrowed = await call(`date=${day}&sports=SHO`);
  assert.ok(narrowed.count < res.count, "a single sport should be a strict subset");
});

test("live=1 keeps only sessions in progress", async () => {
  const res = await call(`date=${day}&live=1`);
  assert.equal(
    res.sessions.every((s) => s.isLive || s.status === "intermediate"),
    true,
  );
  // The filter narrows without changing the day total it is measured against.
  assert.equal(res.totalForDay >= res.count, true);
});

test("status filter accepts a comma-separated list", async () => {
  const res = await call(`date=${day}&status=official,running`);
  assert.ok(res.count > 0, "the captured day has official and running sessions");
  assert.equal(res.sessions.every((s) => ["official", "running"].includes(s.status)), true);

  const single = await call(`date=${day}&status=official`);
  assert.equal(single.sessions.every((s) => s.status === "official"), true);
  assert.ok(single.count <= res.count);
});

test("filters compose", async () => {
  const res = await call(`date=${day}&sports=CKT&live=1`);
  assert.equal(
    res.sessions.every((s) => s.sportCode === "CKT" && (s.isLive || s.status === "intermediate")),
    true,
  );

  const multi = await call(`date=${day}&sports=CKT,SHO&status=official`);
  assert.equal(
    multi.sessions.every((s) => ["CKT", "SHO"].includes(s.sportCode) && s.status === "official"),
    true,
  );
});

test("an unmatched filter returns an empty list, not an error", async () => {
  const res = await call(`date=${day}&sports=NOPE`);
  assert.deepEqual(res.sessions, []);
  assert.equal(res.count, 0);

  const partial = await call(`date=${day}&sports=SHO,NOPE`);
  assert.ok(partial.count > 0, "a real code in the list still matches");
  assert.equal(partial.sessions.every((s) => s.sportCode === "SHO"), true);

  const bogus = await call(`date=${day}&status=not_a_status`);
  assert.deepEqual(bogus.sessions, []);
});

test("legacy singular ?sport= still works for old links", async () => {
  const res = await call(`date=${day}&sport=SHO`);
  assert.equal(res.sessions.every((s) => s.sportCode === "SHO"), true);
  assert.deepEqual(res.sports, ["SHO"]);
});

test("live route accepts the same multi-sport filter", async () => {
  const all = await routes.live(ctx, new URLSearchParams(""));
  const scoped = await routes.live(ctx, new URLSearchParams("sports=CKT"));
  assert.equal(scoped.live.every((item) => item.session.sportCode === "CKT"), true);
  assert.ok(scoped.count <= all.count);

  const multi = await routes.live(ctx, new URLSearchParams("sports=CKT,SHO"));
  assert.equal(multi.live.every((item) => ["CKT", "SHO"].includes(item.session.sportCode)), true);
  assert.ok(multi.count >= scoped.count);
});

test("every session links to its own page on the official site", async () => {
  const { eventPageUrl } = await import("../src/source/site.ts");

  const res = await call(`date=${day}`);
  assert.ok(res.sessions.length > 0);
  for (const s of res.sessions) {
    // Built from the upstream ResCode, never our composite `${sport}:${resCode}` id.
    assert.equal(s.officialUrl, eventPageUrl(s.sportCode, s.resCode));
  }

  const live = await routes.live(ctx, new URLSearchParams(""));
  assert.equal(live.live.every((item) => item.session.officialUrl.includes("/#/discipline/")), true);
});
