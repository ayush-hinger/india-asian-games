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

  const codes = res.sports.map((s) => s.code).sort();
  assert.deepEqual(codes, ["CKT", "SHO"]);
  // Counts must add up to the day's total, or a sport filter would mislead.
  assert.equal(res.sports.reduce((n, s) => n + s.count, 0), res.totalForDay);
  assert.equal(res.sports.every((s) => s.name !== ""), true);
});

test("sport filter narrows to one discipline", async () => {
  const res = await call(`date=${day}&sport=SHO`);
  assert.ok(res.count > 0);
  assert.equal(res.sessions.every((s) => s.sportCode === "SHO"), true);
  assert.equal(res.sport, "SHO");
  // totalForDay reflects the sport-scoped set, so "n of m" stays coherent.
  assert.equal(res.totalForDay, res.count);
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
  const res = await call(`date=${day}&sport=CKT&live=1`);
  assert.equal(
    res.sessions.every((s) => s.sportCode === "CKT" && (s.isLive || s.status === "intermediate")),
    true,
  );
});

test("an unmatched filter returns an empty list, not an error", async () => {
  const res = await call(`date=${day}&sport=NOPE`);
  assert.deepEqual(res.sessions, []);
  assert.equal(res.count, 0);

  const bogus = await call(`date=${day}&status=not_a_status`);
  assert.deepEqual(bogus.sessions, []);
});

test("live route accepts the same sport filter", async () => {
  const all = await routes.live(ctx, new URLSearchParams(""));
  const scoped = await routes.live(ctx, new URLSearchParams("sport=CKT"));
  assert.equal(scoped.live.every((item) => item.session.sportCode === "CKT"), true);
  assert.ok(scoped.count <= all.count);
});
