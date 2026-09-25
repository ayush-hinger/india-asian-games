/**
 * The internal model. Deliberately independent of upstream field names so that
 * source drift is absorbed in src/adapters/ and never reaches storage or the API.
 *
 * Conventions that differ from the source:
 *  - All instants are ISO-8601 UTC strings. The source sends +09:00 (JST).
 *  - Numbers are numbers. The source sends every scalar as a string.
 *  - Enums are lower-case unions with an explicit "unknown" arm, so an unrecognised
 *    upstream value degrades instead of throwing.
 */

export type SessionStatus =
  | "scheduled"
  | "start_list"
  /** Start time pushed back; the session has not begun. */
  | "delayed"
  | "getting_ready"
  | "running"
  /** Partial results posted while the session is still under way. */
  | "intermediate"
  | "unofficial"
  /** Result posted but not yet confirmed - can still be corrected. */
  | "provisional"
  | "official"
  | "unknown";

/** Only `official` is final. Everything else can still change. */
export const FINAL_STATUSES: ReadonlySet<SessionStatus> = new Set(["official"]);

/** Statuses that mean "finished or under way, but not yet confirmed". */
export const PENDING_STATUSES: ReadonlySet<SessionStatus> = new Set([
  "running", "intermediate", "unofficial", "provisional",
]);

export type ParticipantType = "athlete" | "team" | "pair" | "unknown";

export type MedalKind = "gold" | "silver" | "bronze";

export interface Sport {
  code: string;
  name: string;
  /** True when the tracked country has entries in this sport. */
  tracked: boolean;
  competitionDays: string[];
}

export interface EventRef {
  sportCode: string;
  key: string;
  name: string;
  isTeam: boolean;
}

/** A schedulable session - the unit of polling and display. */
export interface Session {
  /**
   * Internal primary key: `${sportCode}:${resCode}`.
   *
   * The upstream ResCode alone is NOT a safe key - it is only unique within one
   * sport. Its format is a generic event/phase/unit template
   * (e.g. "M.TEAM--------------.SFNL.00020000"), and different sports
   * independently produce the identical string for their own, unrelated sessions
   * (confirmed: Badminton and Table Tennis both used this exact code for their own
   * Men's Team semifinal on the same day). Keying storage on ResCode alone let one
   * sport's poll silently overwrite another's row. Always build and compare this
   * id through `compositeSessionId()`, never construct it ad hoc.
   */
  id: string;
  /** The raw upstream ResCode, needed verbatim when calling back into the source
   * (e.g. `/results/<resCode>`) - opaque, never parse or trim it. */
  resCode: string;
  sportCode: string;
  sportName: string;
  eventKey: string;
  eventName: string;
  phaseKey: string;
  phaseName: string;
  title: string;
  titleShort: string;
  /** ISO-8601 UTC. */
  startsAt: string;
  /** Upstream flags the start time as an estimate. */
  startEstimated: boolean;
  venueCode: string;
  venueName: string;
  status: SessionStatus;
  statusLabel: string;
  isLive: boolean;
  /** Medals are decided in this session. */
  isMedalSession: boolean;
  isHeadToHead: boolean;
  participantType: ParticipantType;
  /** Country codes taking part. Empty when the source did not supply them. */
  orgs: string[];
  /** True when the tracked country appears in `orgs`. */
  hasTrackedCountry: boolean;
}

export interface ScheduleSlot {
  sessionId: string;
  /** Local competition date (JST) the session belongs to, YYYY-MM-DD. */
  competitionDate: string;
  startsAt: string;
}

export interface Participant {
  /** Upstream Reg. Numeric-looking for individuals, a composite code for teams. */
  regId: string;
  orgCode: string;
  orgName: string;
  sportCode: string;
  eventKey: string;
  name: string;
  shortName: string;
  givenName: string;
  familyName: string;
  gender: string;
  birthDate: string | null;
  type: ParticipantType;
  bib: string;
}

export interface ResultEntry {
  sessionId: string;
  regId: string;
  orgCode: string;
  orgName: string;
  name: string;
  /** Display rank, as sent. Empty when not yet ranked. */
  rank: string;
  /** Numeric sort position; 0 when unranked. Sort on this, display `rank`. */
  rankSort: number;
  rankTied: boolean;
  result: string;
  resultDetail: string;
  /** Irregular-result marker. Anything other than "OK"/"" invalidates `result`. */
  irm: string;
  qualified: string;
  lane: string;
  medal: MedalKind | null;
  isWinner: boolean;
  /** Sport-specific, open-ended. Persisted as an opaque blob. */
  stats: Record<string, string>;
  members: { name: string; bib: string; position: string }[];
}

/** The live scoreboard for one session, from whichever shape the sport provides. */
export interface LiveState {
  sessionId: string;
  status: SessionStatus;
  isLive: boolean;
  /** Present for head-to-head sports. */
  sides: { orgCode: string; name: string; score: string; isWinner: boolean }[];
  /** Present for field-style sports (heats, finals). */
  standings: ResultEntry[];
  periods: { order: number; name: string; shortName: string }[];
  updatedAt: string;
}

export interface MedalTallyRow {
  orgCode: string;
  orgName: string;
  gold: number;
  silver: number;
  bronze: number;
  total: number;
  /** Rank by gold-first precedence. */
  rankByGold: number;
  /** Rank by total medals. Diverges from rankByGold; never mix them in one table. */
  rankByTotal: number;
}

export interface MedalWin {
  orgCode: string;
  orgName: string;
  medal: MedalKind;
  sportCode: string;
  sportName: string;
  eventName: string;
  /** ISO-8601 UTC. */
  wonAt: string;
  /** Athlete name, or the country name for team events. */
  name: string;
  gender: string;
  isTeam: boolean;
  members: { regId: string; name: string; bib: string }[];
}
