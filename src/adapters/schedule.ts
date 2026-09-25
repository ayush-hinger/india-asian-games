import { config } from "../config.ts";
import { log } from "../log.ts";
import { competitionDate, toUtc } from "../domain/time.ts";
import type { ScheduleSlot, Session } from "../domain/types.ts";
import type { RawScheduleUnit } from "../source/types.ts";
import { bool, compositeSessionId, mapSafe, num, str, toParticipantType, toStatus } from "./common.ts";

/**
 * Map an upstream schedule unit to a Session.
 *
 * Returns null for records with no usable identity or start time - those cannot be
 * scheduled, stored or displayed, so they are dropped rather than half-persisted.
 */
export function toSession(raw: RawScheduleUnit): Session | null {
  // ResCode is the per-sport key; Key is the same value on most routes. It is
  // NOT globally unique - see the Session.id doc comment - so the id we store is
  // always sportCode + resCode together, never the bare code.
  const resCode = str(raw.ResCode) || str(raw.Key);
  if (!resCode) return null;

  const startsAt = toUtc(raw.DateTimeRaw);
  if (!startsAt) return null;

  const sportCode = str(raw.Disc);
  if (!sportCode) {
    // Every route this adapter is fed from is discipline-scoped and always sends
    // Disc, so this should not happen - but without it there is no safe way to
    // scope the id, so drop the record rather than risk a cross-sport collision.
    log.drift("schedule.missingDisc", { resCode });
    return null;
  }

  const orgs = Array.isArray(raw.Orgs) ? raw.Orgs.map((o) => str(o)).filter(Boolean) : [];
  const status = toStatus(raw.Status, "schedule.Status");

  return {
    id: compositeSessionId(sportCode, resCode),
    resCode,
    sportCode,
    sportName: str(raw.DiscDesc),
    eventKey: str(raw.Event),
    eventName: str(raw.EventDesc),
    phaseKey: str(raw.Phase),
    phaseName: str(raw.PhaseDesc),
    title: str(raw.UnitDesc) || str(raw.EventDesc),
    titleShort: str(raw.UnitDescS) || str(raw.UnitDescA) || str(raw.UnitDesc),
    startsAt,
    startEstimated: bool(raw.Estimated),
    venueCode: str(raw.Venue),
    venueName: str(raw.VenueDesc) || str(raw.LocDesc),
    status,
    statusLabel: str(raw.StatusDesc),
    // IsLive and RUNNING agree upstream; trust either so one missing field is survivable.
    isLive: bool(raw.IsLive) || status === "running",
    // Medal is "0" for none, "1"/"2" when medals are decided here. Also seen empty.
    isMedalSession: num(raw.Medal, 0) > 0,
    isHeadToHead: bool(raw.isH2H),
    participantType: toParticipantType(raw.Type, "schedule.Type"),
    orgs,
    hasTrackedCountry: orgs.includes(config.country),
  };
}

export function toSessions(raw: RawScheduleUnit[] | undefined): Session[] {
  return mapSafe(raw, "schedule", toSession);
}

/** Sessions involving the tracked country. Units with no `Orgs` can never match. */
export function filterTracked(sessions: Session[]): Session[] {
  return sessions.filter((s) => s.hasTrackedCountry);
}

export function toScheduleSlot(session: Session): ScheduleSlot {
  return {
    sessionId: session.id,
    competitionDate: competitionDate(session.startsAt),
    startsAt: session.startsAt,
  };
}
