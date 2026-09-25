import { fetchSource, tryFetchSource } from "./client.ts";
import type {
  RawDiscipline, RawEntriesByOrg, RawContingent, RawMedalEvent,
  RawMedalStanding, RawResultPayload, RawScheduleUnit,
} from "./types.ts";

/**
 * Every unit scheduled on a date, across all sports. Carries NO participant data,
 * so it cannot be filtered by country - use `disciplineDay` for that.
 */
export const allDay = (date: string) =>
  fetchSource<RawScheduleUnit[]>(`/schedule/day/${date}`, "ALL");

/**
 * One sport's units on a date, each carrying `Orgs` - this is the country filter.
 * Note the route name differs from `allDay`: `daily` here, `day` there, and each
 * 404s or returns [] under the other's scope.
 */
export const disciplineDay = (disc: string, date: string) =>
  fetchSource<RawScheduleUnit[]>(`/schedule/daily/${date}`, disc);

/** Currently-running units with full live state. One call covers the whole Games. */
export const liveNow = () =>
  fetchSource<RawScheduleUnit[]>("/schedule/live-now", "ALL");

export const upNext = () =>
  fetchSource<RawScheduleUnit[]>("/schedule/up-next", "ALL");

export const results = (disc: string, resCode: string) =>
  fetchSource<RawResultPayload>(`/results/${resCode}`, disc);

export const medalStandings = () =>
  fetchSource<RawMedalStanding[]>("/medals/standings", "ALL");

export const medalsForOrg = (org: string) =>
  fetchSource<RawMedalEvent[]>(`/medals/org/${org}`, "ALL");

export const latestMedals = () =>
  fetchSource<RawMedalEvent[]>("/medals/latest", "ALL");

/** All 59 disciplines with their competition days, venues and events. */
export const disciplines = () =>
  fetchSource<RawDiscipline[]>("/disc/data", "ALL");

/** Contingent summary: per-discipline head counts for one country. */
export const contingent = (org: string) =>
  fetchSource<RawContingent>(`/entries/org/${org}`, "ALL");

/** One country's roster within one sport, grouped by event. */
export const rosterForSport = (disc: string, org: string) =>
  tryFetchSource<RawEntriesByOrg>(`/entries/org/${org}`, disc);
