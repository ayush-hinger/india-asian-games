import { readFileSync } from "node:fs";
import { config } from "../config.ts";
import { hashRecord } from "../domain/hash.ts";
import { competitionDate } from "../domain/time.ts";
import type {
  MedalTallyRow, MedalWin, Participant, ResultEntry, Session, Sport,
} from "../domain/types.ts";
import type { SessionQuery, Store } from "./types.ts";

/**
 * Postgres-backed store, per the project brief.
 *
 * The `pg` driver is imported lazily so the rest of the tracker keeps its
 * zero-dependency install when STORE=sqlite (the default). To use this:
 *
 *   npm install pg
 *   psql "$DATABASE_URL" -f sql/schema.sql
 *   STORE=postgres DATABASE_URL=postgres://... npm start
 */
export class PostgresStore implements Store {
  private pool!: { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> };

  async init(): Promise<void> {
    if (!config.databaseUrl) {
      throw new Error("STORE=postgres requires DATABASE_URL");
    }
    let pg: any;
    try {
      // Indirect specifier: `pg` is an optional peer, so it must not be a static
      // import that typechecking or bundling would try to resolve when absent.
      const driver = "pg";
      pg = await import(driver);
    } catch {
      throw new Error("STORE=postgres requires the 'pg' package: npm install pg");
    }
    const Pool = pg.default?.Pool ?? pg.Pool;
    this.pool = new Pool({ connectionString: config.databaseUrl, max: 8 });
    await this.pool.query(readFileSync(new URL("../../sql/schema.sql", import.meta.url), "utf8"));
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }

  async upsertSports(sports: Sport[]): Promise<void> {
    for (const s of sports) {
      await this.pool.query(
        `INSERT INTO sports (code, name, tracked, payload) VALUES ($1, $2, $3, $4)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name,
           tracked = EXCLUDED.tracked, payload = EXCLUDED.payload`,
        [s.code, s.name, s.tracked, JSON.stringify(s)],
      );
    }
  }

  async getSports(): Promise<Sport[]> {
    const { rows } = await this.pool.query("SELECT payload FROM sports ORDER BY name");
    return rows.map((r) => r.payload as Sport);
  }

  async upsertSessions(sessions: Session[]): Promise<Session[]> {
    const changed: Session[] = [];
    const now = new Date().toISOString();
    for (const s of sessions) {
      const hash = hashRecord(s);
      // Returns a row only when the hash actually moved, so unchanged polls write nothing.
      const { rows } = await this.pool.query(
        `INSERT INTO sessions (id, sport_code, competition_date, starts_at, status,
           is_live, has_tracked, is_medal_session, hash, payload, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (id) DO UPDATE SET
           sport_code = EXCLUDED.sport_code, competition_date = EXCLUDED.competition_date,
           starts_at = EXCLUDED.starts_at, status = EXCLUDED.status,
           is_live = EXCLUDED.is_live, has_tracked = EXCLUDED.has_tracked,
           is_medal_session = EXCLUDED.is_medal_session, hash = EXCLUDED.hash,
           payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at
         WHERE sessions.hash IS DISTINCT FROM EXCLUDED.hash
         RETURNING id`,
        [s.id, s.sportCode, competitionDate(s.startsAt), s.startsAt, s.status,
         s.isLive, s.hasTrackedCountry, s.isMedalSession, hash, JSON.stringify(s), now],
      );
      if (rows.length > 0) changed.push(s);
    }
    return changed;
  }

  async getSessions(q: SessionQuery): Promise<Session[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const p = () => `$${params.length}`;

    if (q.competitionDate) { params.push(q.competitionDate); where.push(`competition_date = ${p()}`); }
    if (q.sportCode) { params.push(q.sportCode); where.push(`sport_code = ${p()}`); }
    if (q.onlyTracked) where.push("has_tracked");
    if (q.onlyLive) where.push("is_live");
    if (q.startingWithinMs !== undefined) {
      params.push(new Date().toISOString());
      const lo = p();
      params.push(new Date(Date.now() + q.startingWithinMs).toISOString());
      where.push(`starts_at BETWEEN ${lo} AND ${p()}`);
    }
    let sql = `SELECT payload FROM sessions
      ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY starts_at ASC`;
    if (q.limit) { params.push(q.limit); sql += ` LIMIT ${p()}`; }

    const { rows } = await this.pool.query(sql, params);
    return rows.map((r) => r.payload as Session);
  }

  async getSession(id: string): Promise<Session | null> {
    const { rows } = await this.pool.query("SELECT payload FROM sessions WHERE id = $1", [id]);
    return rows[0]?.payload ?? null;
  }

  async upsertParticipants(participants: Participant[]): Promise<void> {
    for (const pt of participants) {
      await this.pool.query(
        `INSERT INTO participants (reg_id, sport_code, event_key, org_code, name, payload)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (reg_id, sport_code, event_key) DO UPDATE SET
           org_code = EXCLUDED.org_code, name = EXCLUDED.name, payload = EXCLUDED.payload`,
        [pt.regId, pt.sportCode, pt.eventKey, pt.orgCode, pt.name, JSON.stringify(pt)],
      );
    }
  }

  async getParticipants(sportCode?: string): Promise<Participant[]> {
    const { rows } = sportCode
      ? await this.pool.query("SELECT payload FROM participants WHERE sport_code = $1 ORDER BY name", [sportCode])
      : await this.pool.query("SELECT payload FROM participants ORDER BY name");
    return rows.map((r) => r.payload as Participant);
  }

  async upsertResults(sessionId: string, results: ResultEntry[]): Promise<ResultEntry[]> {
    const changed: ResultEntry[] = [];
    const now = new Date().toISOString();
    for (const r of results) {
      const hash = hashRecord(r);
      const { rows } = await this.pool.query(
        `INSERT INTO results (session_id, reg_id, org_code, rank_sort, hash, payload, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (session_id, reg_id) DO UPDATE SET
           org_code = EXCLUDED.org_code, rank_sort = EXCLUDED.rank_sort,
           hash = EXCLUDED.hash, payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at
         WHERE results.hash IS DISTINCT FROM EXCLUDED.hash
         RETURNING reg_id`,
        [sessionId, r.regId, r.orgCode, r.rankSort, hash, JSON.stringify(r), now],
      );
      if (rows.length === 0) continue;
      await this.pool.query(
        `INSERT INTO result_history (session_id, reg_id, hash, payload, recorded_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [sessionId, r.regId, hash, JSON.stringify(r), now],
      );
      changed.push(r);
    }
    return changed;
  }

  async getResults(sessionId: string): Promise<ResultEntry[]> {
    const { rows } = await this.pool.query(
      "SELECT payload FROM results WHERE session_id = $1 ORDER BY rank_sort ASC, reg_id ASC",
      [sessionId],
    );
    return rows.map((r) => r.payload as ResultEntry);
  }

  async upsertTally(tallyRows: MedalTallyRow[]): Promise<MedalTallyRow[]> {
    const changed: MedalTallyRow[] = [];
    const now = new Date().toISOString();
    for (const row of tallyRows) {
      const hash = hashRecord(row);
      const { rows } = await this.pool.query(
        `INSERT INTO medal_tally (org_code, rank_by_gold, hash, payload, updated_at)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (org_code) DO UPDATE SET rank_by_gold = EXCLUDED.rank_by_gold,
           hash = EXCLUDED.hash, payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at
         WHERE medal_tally.hash IS DISTINCT FROM EXCLUDED.hash
         RETURNING org_code`,
        [row.orgCode, row.rankByGold, hash, JSON.stringify(row), now],
      );
      if (rows.length > 0) changed.push(row);
    }
    return changed;
  }

  async getTally(): Promise<MedalTallyRow[]> {
    const { rows } = await this.pool.query("SELECT payload FROM medal_tally ORDER BY rank_by_gold ASC");
    return rows.map((r) => r.payload as MedalTallyRow);
  }

  async upsertMedalWins(wins: MedalWin[]): Promise<MedalWin[]> {
    const changed: MedalWin[] = [];
    for (const w of wins) {
      const id = hashRecord([w.orgCode, w.sportCode, w.eventName, w.medal, w.name]);
      const hash = hashRecord(w);
      const { rows } = await this.pool.query(
        `INSERT INTO medal_wins (id, org_code, won_at, hash, payload) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (id) DO UPDATE SET hash = EXCLUDED.hash, payload = EXCLUDED.payload
         WHERE medal_wins.hash IS DISTINCT FROM EXCLUDED.hash
         RETURNING id`,
        [id, w.orgCode, w.wonAt, hash, JSON.stringify(w)],
      );
      if (rows.length > 0) changed.push(w);
    }
    return changed;
  }

  async getMedalWins(orgCode?: string): Promise<MedalWin[]> {
    const { rows } = orgCode
      ? await this.pool.query("SELECT payload FROM medal_wins WHERE org_code = $1 ORDER BY won_at DESC", [orgCode])
      : await this.pool.query("SELECT payload FROM medal_wins ORDER BY won_at DESC");
    return rows.map((r) => r.payload as MedalWin);
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.pool.query(
      "INSERT INTO meta (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [key, value],
    );
  }

  async getMeta(key: string): Promise<string | null> {
    const { rows } = await this.pool.query("SELECT value FROM meta WHERE key = $1", [key]);
    return rows[0]?.value ?? null;
  }
}
