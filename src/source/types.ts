/**
 * Shapes of the upstream payloads, transcribed from real responses captured on
 * 2026-09-20 (see fixtures/ and docs/api-notes.md).
 *
 * Two rules apply throughout:
 *  - Upstream sends every scalar as a string, including ranks, scores and flags.
 *  - The source can change shape mid-Games, so every field here is optional at the
 *    adapter boundary. These types describe what we have seen, not a guarantee.
 */

export interface RawExtension {
  Type?: string;
  Code?: string;
  Pos?: number;
  Value?: string;
  Extensions?: RawExtension[];
}

export interface RawMember {
  Reg?: string;
  Bib?: string;
  Org?: string;
  OrgDesc?: string;
  Name?: string;
  NameS?: string;
  Order?: number;
  BirthDate?: string;
  FuncDesc?: string;
  PosDesc?: string;
}

/** A schedulable session. `ResCode` is the primary key across every other endpoint. */
export interface RawScheduleUnit {
  /** Country codes taking part. Present on discipline-scoped and live routes only. */
  Orgs?: string[];
  ResCode?: string;
  Key?: string;
  Disc?: string;
  DiscDesc?: string;
  Type?: string;
  isH2H?: boolean;
  /** "0" | "1" | "2" | "" - flags that medals are decided here, not which was won. */
  Medal?: string;
  Status?: string;
  StatusDesc?: string;
  IsLive?: boolean;
  IsPhase?: boolean;
  /** ISO-8601 with a +09:00 (JST) offset, never UTC. */
  DateTimeRaw?: string;
  Estimated?: boolean;
  EstText?: string;
  Venue?: string;
  VenueDesc?: string;
  Loc?: string;
  LocDesc?: string;
  Event?: string;
  EventDesc?: string;
  Phase?: string;
  PhaseOrder?: number;
  PhaseDesc?: string;
  UnitDesc?: string;
  UnitDescS?: string;
  UnitDescA?: string;
  UnitNum?: string;
  ShowResults?: boolean;
  ShowLink?: boolean;
  Periods?: { Order?: number; Desc?: string; DescS?: string }[];
  /** Head-to-head sides. Present only when isH2H is true. */
  Home?: RawSide;
  Away?: RawSide;
}

export interface RawSide {
  Org?: string;
  Reg?: string;
  Name?: string;
  NameS?: string;
  Result?: string;
  Winner?: boolean;
  HasData?: boolean;
  Medal?: string;
  Members?: RawMember[];
}

export interface RawCompetitor {
  Reg?: string;
  Bib?: string;
  Org?: string;
  OrgDesc?: string;
  Name?: string;
  NameS?: string;
  StartOrder?: string;
  StartSortOrder?: number;
  /** Display rank as a string; ties flagged by RkEq. Sort on RkPo. */
  Rk?: string;
  RkEq?: boolean;
  RkPo?: number;
  Result?: string;
  ResDetail?: string;
  ResInfo?: string;
  /** Irregular-result marker: "OK", or a DNS/DNF/DSQ variant. */
  IRM?: string;
  Qualified?: string;
  Lane?: string;
  Diff?: string;
  Medal?: string;
  /** Sport-specific keys (ST_TEAM_WICKETS, ...). Opaque - store as a blob. */
  Stats?: Record<string, string>;
  Splits?: unknown[];
  Members?: RawMember[];
  Extensions?: RawExtension[];
}

export interface RawResultPayload {
  Info?: RawScheduleUnit;
  Results?: unknown;
  Competitors?: RawCompetitor[];
  Legends?: unknown;
}

export interface RawMedalCount {
  M?: number;
  W?: number;
  X?: number;
  total?: number;
}

export interface RawMedalStanding {
  Org?: string;
  OrgDesc?: string;
  Enabled?: boolean;
  Count?: {
    ME_GOLD?: RawMedalCount;
    ME_SILVER?: RawMedalCount;
    ME_BRONZE?: RawMedalCount;
    total?: RawMedalCount;
  };
  /** Rank by gold-first precedence. */
  Rk?: string;
  RkPo?: number;
  RkEq?: boolean;
  /** Rank by total medals - diverges from Rk, do not mix the two. */
  RkTotal?: string;
  RkPoTotal?: number;
  RkEqTotal?: boolean;
}

export interface RawMedalEvent {
  /** ME_GOLD | ME_SILVER | ME_BRONZE */
  Medal?: string;
  Order?: number;
  Org?: string;
  OrgDesc?: string;
  Reg?: string;
  Type?: string;
  DateRaw?: string;
  Name?: string;
  Bib?: string;
  Gender?: string;
  Disc?: string;
  DiscDesc?: string;
  Event?: string;
  EventDesc?: string;
  Members?: RawMember[];
}

export interface RawDiscipline {
  Disc?: string;
  DiscDesc?: string;
  Days?: { raw?: string; day?: string; month?: string; weekDay?: string; title?: string }[];
  Locations?: { Key?: string; Venue?: string; Desc?: string; DescS?: string }[];
  Events?: { EvKey?: string; Desc?: string; DescS?: string; Order?: number; IsTeam?: boolean; IsPara?: boolean }[];
  Config?: Record<string, unknown>;
}

export interface RawContingent {
  Org?: string;
  OrgDesc?: string;
  Totals?: { M?: number; W?: number; X?: number; Total?: number };
  Count?: { Disc?: string; DiscDesc?: string; M?: number; W?: number; X?: number; Total?: number }[];
}

export interface RawPartic {
  Reg?: string;
  Org?: string;
  OrgDesc?: string;
  Type?: string;
  Gender?: string;
  Name?: string;
  NameS?: string;
  GivenName?: string;
  FamilyName?: string;
  BirthDateRaw?: string;
  IFId?: string;
  Bib?: string;
  hasMembers?: boolean;
  Members?: RawMember[];
  Extensions?: RawExtension[];
}

export interface RawEntriesByOrg {
  Org?: string;
  OrgDesc?: string;
  Disc?: string;
  DiscDesc?: string;
  Events?: { Disc?: string; EvKey?: string; EvDesc?: string; Order?: number; Partics?: RawPartic[] }[];
}
