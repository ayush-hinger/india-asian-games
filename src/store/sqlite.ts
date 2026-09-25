import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.ts";
import { hashRecord } from "../domain/hash.ts";
import { competitionDate } from "../domain/time.ts";
import type {
  MedalTallyRow, MedalWin, Participant, ResultEntry, Session, Sport,
} from "../domain/types.ts";
import type { SessionQuery, Store } from "./types.ts";

/**
 * SQLite-backed store using Node's built-in driver - no external database process.
 *
 * Normalized records are persisted as a JSON `payload` alongside the scalar columns
 * that are actually queried. Queries never depend on the shape inside `payload`, so
 * adding a field to the domain model needs no migration.
 */
export class SqliteStore implements Store {
  private db!: DatabaseSync;

  async init(): Promise<void> {
    mkdirSync(dirname(config.sqlitePath), { recursive: true });
    this.db = new DatabaseSync(config.sqlitePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  async close(): Promise<void> {
    this.db?.close();
  }

  async upsertSports(sports: Sport[]): Promise<void> {
    const stmt = this.db.prepare(
      `INSERT INTO sports (code, name, tracked, payload) VALUES (?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET name = excluded.name,
         tracked = excluded.tracked, payload = excluded.payload`,
    );
    for (const s of sports) stmt.run(s.code, s.name, s.tracked ? 1 : 0, JSON.stringify(s));
  }

  async getSports(): Promise<Sport[]> {
    return this.db.prepare("SELECT payload FROM sports ORDER BY name").all()
      .map((r) => JSON.parse(String((r as { payload: string }).payload)) as Sport);
  }

  async upsertSessions(sessions: Session[]): Promise<Session[]> {
    const read = this.db.prepare("SELECT hash FROM sessions WHERE id = ?");
    const write = this.db.prepare(
      `INSERT INTO sessions
         (id, sport_code, competition_date, starts_at, status, is_live,
          has_tracked, is_medal_session, hash, payload, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         sport_code = excluded.sport_code, competition_date = excluded.competition_date,
         starts_at = excluded.starts_at, status = excluded.status,
         is_live = excluded.is_live, has_tracked = excluded.has_tracked,
         is_medal_session = excluded.is_medal_session, hash = excluded.hash,
         payload = excluded.payload, updated_at = excluded.updated_at`,
    );

    const changed: Session[] = [];
    const now = new Date().toISOString();

    this.db.exec("BEGIN");
    try {
      for (const s of sessions) {
        const hash = hashRecord(s);
        const existing = read.get(s.id) as { hash?: string } | undefined;
        if (existing?.hash === hash) continue;

        write.run(
          s.id, s.sportCode, competitionDate(s.startsAt), s.startsAt, s.status,
          s.isLive ? 1 : 0, s.hasTrackedCountry ? 1 : 0, s.isMedalSession ? 1 : 0,
          hash, JSON.stringify(s), now,
        );
        changed.push(s);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return changed;
  }

  async getSessions(q: SessionQuery): Promise<Session[]> {
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (q.competitionDate) { where.push("competition_date = ?"); params.push(q.competitionDate); }
    if (q.sportCode) { where.push("sport_code = ?"); params.push(q.sportCode); }
    if (q.onlyTracked) where.push("has_tracked = 1");
    if (q.onlyLive) where.push("is_live = 1");
    if (q.startingWithinMs !== undefined) {
      where.push("starts_at BETWEEN ? AND ?");
      params.push(new Date().toISOString(), new Date(Date.now() + q.startingWithinMs).toISOString());
    }

    const sql = `SELECT payload FROM sessions
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY starts_at ASC ${q.limit ? "LIMIT ?" : ""}`;
    if (q.limit) params.push(q.limit);

    return this.db.prepare(sql).all(...params)
      .map((r) => JSON.parse(String((r as { payload: string }).payload)) as Session);
  }

  async getSession(id: string): Promise<Session | null> {
    const row = this.db.prepare("SELECT payload FROM sessions WHERE id = ?").get(id) as
      { payload?: string } | undefined;
    return row?.payload ? (JSON.parse(String(row.payload)) as Session) : null;
  }

  async upsertParticipants(participants: Participant[]): Promise<void> {
    const stmt = this.db.prepare(
      `INSERT INTO participants (reg_id, sport_code, event_key, org_code, name, payload)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(reg_id, sport_code, event_key) DO UPDATE SET
         org_code = excluded.org_code, name = excluded.name, payload = excluded.payload`,
    );
    this.db.exec("BEGIN");
    try {
      for (const p of participants) {
        stmt.run(p.regId, p.sportCode, p.eventKey, p.orgCode, p.name, JSON.stringify(p));
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async getParticipants(sportCode?: string): Promise<Participant[]> {
    const sql = sportCode
      ? "SELECT payload FROM participants WHERE sport_code = ? ORDER BY name"
      : "SELECT payload FROM participants ORDER BY name";
    const rows = sportCode ? this.db.prepare(sql).all(sportCode) : this.db.prepare(sql).all();
    return rows.map((r) => JSON.parse(String((r as { payload: string }).payload)) as Participant);
  }

  async upsertResults(sessionId: string, results: ResultEntry[]): Promise<ResultEntry[]> {
    const read = this.db.prepare("SELECT hash FROM results WHERE session_id = ? AND reg_id = ?");
    const write = this.db.prepare(
      `INSERT INTO results (session_id, reg_id, org_code, rank_sort, hash, payload, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, reg_id) DO UPDATE SET
         org_code = excluded.org_code, rank_sort = excluded.rank_sort,
         hash = excluded.hash, payload = excluded.payload, updated_at = excluded.updated_at`,
    );
    // Append-only history, so a result that is corrected after going UNOFFICIAL
    // leaves a trail rather than being silently overwritten.
    const history = this.db.prepare(
      `INSERT INTO result_history (session_id, reg_id, hash, payload, recorded_at)
       VALUES (?, ?, ?, ?, ?)`,
    );

    const changed: ResultEntry[] = [];
    const now = new Date().toISOString();

    this.db.exec("BEGIN");
    try {
      for (const r of results) {
        const hash = hashRecord(r);
        const existing = read.get(sessionId, r.regId) as { hash?: string } | undefined;
        if (existing?.hash === hash) continue;

        write.run(sessionId, r.regId, r.orgCode, r.rankSort, hash, JSON.stringify(r), now);
        history.run(sessionId, r.regId, hash, JSON.stringify(r), now);
        changed.push(r);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return changed;
  }

  async getResults(sessionId: string): Promise<ResultEntry[]> {
    return this.db
      .prepare("SELECT payload FROM results WHERE session_id = ? ORDER BY rank_sort ASC, reg_id ASC")
      .all(sessionId)
      .map((r) => JSON.parse(String((r as { payload: string }).payload)) as ResultEntry);
  }

  async upsertTally(rows: MedalTallyRow[]): Promise<MedalTallyRow[]> {
    const read = this.db.prepare("SELECT hash FROM medal_tally WHERE org_code = ?");
    const write = this.db.prepare(
      `INSERT INTO medal_tally (org_code, rank_by_gold, hash, payload, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(org_code) DO UPDATE SET rank_by_gold = excluded.rank_by_gold,
         hash = excluded.hash, payload = excluded.payload, updated_at = excluded.updated_at`,
    );
    const changed: MedalTallyRow[] = [];
    const now = new Date().toISOString();
    for (const row of rows) {
      const hash = hashRecord(row);
      const existing = read.get(row.orgCode) as { hash?: string } | undefined;
      if (existing?.hash === hash) continue;
      write.run(row.orgCode, row.rankByGold, hash, JSON.stringify(row), now);
      changed.push(row);
    }
    return changed;
  }

  async getTally(): Promise<MedalTallyRow[]> {
    return this.db.prepare("SELECT payload FROM medal_tally ORDER BY rank_by_gold ASC").all()
      .map((r) => JSON.parse(String((r as { payload: string }).payload)) as MedalTallyRow);
  }

  async upsertMedalWins(wins: MedalWin[]): Promise<MedalWin[]> {
    const read = this.db.prepare("SELECT hash FROM medal_wins WHERE id = ?");
    const write = this.db.prepare(
      `INSERT INTO medal_wins (id, org_code, won_at, hash, payload)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET hash = excluded.hash, payload = excluded.payload`,
    );
    const changed: MedalWin[] = [];
    for (const w of wins) {
      // No upstream id on medal records, so identity is the event + medal + country.
      const id = hashRecord([w.orgCode, w.sportCode, w.eventName, w.medal, w.name]);
      const hash = hashRecord(w);
      const existing = read.get(id) as { hash?: string } | undefined;
      if (existing?.hash === hash) continue;
      write.run(id, w.orgCode, w.wonAt, hash, JSON.stringify(w));
      changed.push(w);
    }
    return changed;
  }

  async getMedalWins(orgCode?: string): Promise<MedalWin[]> {
    const sql = orgCode
      ? "SELECT payload FROM medal_wins WHERE org_code = ? ORDER BY won_at DESC"
      : "SELECT payload FROM medal_wins ORDER BY won_at DESC";
    const rows = orgCode ? this.db.prepare(sql).all(orgCode) : this.db.prepare(sql).all();
    return rows.map((r) => JSON.parse(String((r as { payload: string }).payload)) as MedalWin);
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, value);
  }

  async getMeta(key: string): Promise<string | null> {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      { value?: string } | undefined;
    return row?.value ?? null;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sports (
  code TEXT PRIMARY KEY, name TEXT NOT NULL,
  tracked INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  -- "sportCode:resCode" composite, NOT the bare upstream ResCode - see
  -- src/domain/types.ts Session.id for why that alone is not a safe key.
  id TEXT PRIMARY KEY,
  sport_code TEXT NOT NULL, competition_date TEXT NOT NULL, starts_at TEXT NOT NULL,
  status TEXT NOT NULL, is_live INTEGER NOT NULL DEFAULT 0,
  has_tracked INTEGER NOT NULL DEFAULT 0, is_medal_session INTEGER NOT NULL DEFAULT 0,
  hash TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions (competition_date, starts_at);
CREATE INDEX IF NOT EXISTS idx_sessions_live ON sessions (is_live, has_tracked);
-- The sessions-of-interest set from the brief: every session with a tracked
-- participant. Kept as an index rather than a copied table so it cannot drift.
CREATE INDEX IF NOT EXISTS idx_sessions_tracked ON sessions (has_tracked, starts_at);

CREATE TABLE IF NOT EXISTS participants (
  reg_id TEXT NOT NULL, sport_code TEXT NOT NULL, event_key TEXT NOT NULL,
  org_code TEXT NOT NULL, name TEXT NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY (reg_id, sport_code, event_key)
);
CREATE INDEX IF NOT EXISTS idx_participants_org ON participants (org_code, sport_code);

CREATE TABLE IF NOT EXISTS results (
  session_id TEXT NOT NULL, reg_id TEXT NOT NULL, org_code TEXT NOT NULL,
  rank_sort INTEGER NOT NULL DEFAULT 0, hash TEXT NOT NULL,
  payload TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, reg_id)
);

CREATE TABLE IF NOT EXISTS result_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL, reg_id TEXT NOT NULL, hash TEXT NOT NULL,
  payload TEXT NOT NULL, recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_session ON result_history (session_id, recorded_at);

CREATE TABLE IF NOT EXISTS medal_tally (
  org_code TEXT PRIMARY KEY, rank_by_gold INTEGER NOT NULL DEFAULT 0,
  hash TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS medal_wins (
  id TEXT PRIMARY KEY, org_code TEXT NOT NULL, won_at TEXT NOT NULL,
  hash TEXT NOT NULL, payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wins_org ON medal_wins (org_code, won_at DESC);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;
