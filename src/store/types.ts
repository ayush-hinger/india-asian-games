import type {
  MedalTallyRow, MedalWin, Participant, ResultEntry, Session, Sport,
} from "../domain/types.ts";

export interface SessionQuery {
  competitionDate?: string;
  sportCode?: string;
  onlyTracked?: boolean;
  onlyLive?: boolean;
  /** Sessions starting between now and now + this many ms. */
  startingWithinMs?: number;
  limit?: number;
}

/**
 * Persistence boundary.
 *
 * Every `upsert*` returns only the records whose content hash actually changed.
 * Callers use that to drive SSE emission and result history, so an unchanged poll
 * costs one read and produces no writes and no pushes.
 */
export interface Store {
  init(): Promise<void>;
  close(): Promise<void>;

  upsertSports(sports: Sport[]): Promise<void>;
  getSports(): Promise<Sport[]>;

  upsertSessions(sessions: Session[]): Promise<Session[]>;
  getSessions(query: SessionQuery): Promise<Session[]>;
  getSession(id: string): Promise<Session | null>;

  upsertParticipants(participants: Participant[]): Promise<void>;
  getParticipants(sportCode?: string): Promise<Participant[]>;

  /** Replaces the session's scoreboard; returns the entries that changed. */
  upsertResults(sessionId: string, results: ResultEntry[]): Promise<ResultEntry[]>;
  getResults(sessionId: string): Promise<ResultEntry[]>;

  upsertTally(rows: MedalTallyRow[]): Promise<MedalTallyRow[]>;
  getTally(): Promise<MedalTallyRow[]>;

  upsertMedalWins(wins: MedalWin[]): Promise<MedalWin[]>;
  getMedalWins(orgCode?: string): Promise<MedalWin[]>;

  setMeta(key: string, value: string): Promise<void>;
  getMeta(key: string): Promise<string | null>;
}
