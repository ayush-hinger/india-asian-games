import type { LiveState, ResultEntry, Session } from "../domain/types.ts";
import type { RawCompetitor, RawResultPayload, RawScheduleUnit, RawSide } from "../source/types.ts";
import { bool, compositeSessionId, mapSafe, num, str, toMedal, toStatus } from "./common.ts";
import { toSession } from "./schedule.ts";

export function toResultEntry(sessionId: string, raw: RawCompetitor): ResultEntry | null {
  const regId = str(raw.Reg);
  if (!regId) return null;

  return {
    sessionId,
    regId,
    orgCode: str(raw.Org),
    orgName: str(raw.OrgDesc),
    name: str(raw.Name) || str(raw.OrgDesc),
    rank: str(raw.Rk),
    rankSort: num(raw.RkPo),
    rankTied: bool(raw.RkEq),
    result: str(raw.Result),
    resultDetail: str(raw.ResDetail) || str(raw.Result),
    irm: str(raw.IRM),
    qualified: str(raw.Qualified),
    lane: str(raw.Lane),
    medal: toMedal(raw.Medal, "results.Medal"),
    isWinner: false,
    // Sport-specific keys; kept opaque so a new sport needs no code change.
    stats: isStringMap(raw.Stats) ? raw.Stats : {},
    members: mapSafe(raw.Members, "results.Members", (m) => ({
      name: str(m.Name),
      bib: str(m.Bib),
      position: str(m.PosDesc),
    })),
  };
}

function isStringMap(v: unknown): v is Record<string, string> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function toResultEntries(sessionId: string, payload: RawResultPayload | undefined): ResultEntry[] {
  return mapSafe(payload?.Competitors, "results.Competitors", (c) => toResultEntry(sessionId, c));
}

/** The Session echoed back inside a result payload's `Info` block. */
export function sessionFromResult(payload: RawResultPayload | undefined): Session | null {
  if (!payload?.Info) return null;
  return toSession(payload.Info);
}

function toSide(raw: RawSide | undefined) {
  if (!raw) return null;
  const orgCode = str(raw.Org);
  if (!orgCode) return null;
  return {
    orgCode,
    name: str(raw.Name) || orgCode,
    score: str(raw.Result),
    isWinner: bool(raw.Winner),
  };
}

/**
 * Project a head-to-head unit's Home/Away sides onto ResultEntry rows.
 *
 * Head-to-head sports carry their score inline on the schedule unit and are absent
 * from the results payload while a match is in progress. Normalizing them onto the
 * same row type means storage, the API and the UI need only one scoreboard shape.
 */
export function sidesToResultEntries(unit: RawScheduleUnit): ResultEntry[] {
  const resCode = str(unit.ResCode) || str(unit.Key);
  if (!resCode) return [];
  // ResCode alone collides across sports (see Session.id's doc comment); always
  // scope it by discipline before using it as a key.
  const sessionId = compositeSessionId(str(unit.Disc), resCode);

  const raw = [unit.Home, unit.Away].filter((s): s is RawSide => Boolean(s));

  return raw.map((side, index) => ({
    sessionId,
    // Teams always carry a Reg; fall back to the country code so a missing one
    // still produces a stable primary key rather than colliding on "".
    regId: str(side.Reg) || `${sessionId}:${str(side.Org) || index}`,
    orgCode: str(side.Org),
    orgName: str(side.Name),
    name: str(side.Name) || str(side.Org),
    rank: "",
    rankSort: index + 1,
    rankTied: false,
    result: str(side.Result),
    resultDetail: str(side.Result),
    irm: "",
    qualified: "",
    lane: "",
    medal: toMedal(side.Medal, "live.sideMedal"),
    isWinner: bool(side.Winner),
    stats: {},
    members: mapSafe(side.Members, "live.sideMembers", (m) => ({
      name: str(m.Name),
      bib: str(m.Bib),
      position: str(m.PosDesc),
    })),
  }));
}

/**
 * Build the live scoreboard for a session.
 *
 * The source has two shapes and the sport decides which: head-to-head sports carry
 * `Home`/`Away` inline on the schedule unit, while field sports (heats, finals)
 * carry nothing there and need the separate results payload. Both are normalized
 * onto one LiveState so the API and UI stay sport-agnostic.
 */
export function toLiveState(
  unit: RawScheduleUnit,
  results?: RawResultPayload,
): LiveState | null {
  const resCode = str(unit.ResCode) || str(unit.Key);
  if (!resCode) return null;
  // Same scoping requirement as sidesToResultEntries - see that comment.
  const sessionId = compositeSessionId(str(unit.Disc), resCode);

  const sides = [toSide(unit.Home), toSide(unit.Away)].filter((s) => s !== null);
  const status = toStatus(unit.Status, "live.Status");

  return {
    sessionId,
    status,
    isLive: bool(unit.IsLive) || status === "running",
    sides,
    standings: results ? toResultEntries(sessionId, results) : [],
    periods: mapSafe(unit.Periods, "live.Periods", (p) => ({
      order: num(p.Order),
      name: str(p.Desc),
      shortName: str(p.DescS),
    })),
    updatedAt: new Date().toISOString(),
  };
}
