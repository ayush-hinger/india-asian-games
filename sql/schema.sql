-- Postgres schema for the India @ AG2026 tracker.
-- Apply with:  psql "$DATABASE_URL" -f sql/schema.sql
--
-- Mirrors src/store/sqlite.ts. Normalized records live in a jsonb `payload` next to
-- the scalar columns that are actually queried, so adding a field to the domain
-- model needs no migration - which matters because the upstream source can change
-- shape mid-Games.

CREATE TABLE IF NOT EXISTS sports (
  code     text PRIMARY KEY,
  name     text NOT NULL,
  tracked  boolean NOT NULL DEFAULT false,
  payload  jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  -- "${sportCode}:${resCode}", NOT the bare upstream ResCode: ResCode is only
  -- unique within one sport (confirmed collision: Badminton and Table Tennis both
  -- produced the identical ResCode for their own Men's Team semifinal on the same
  -- day). Always build/compare this through compositeSessionId() in the app code.
  id                text PRIMARY KEY,
  sport_code        text NOT NULL,
  competition_date  date NOT NULL,         -- JST calendar date
  starts_at         timestamptz NOT NULL,  -- stored UTC, source sends +09:00
  status            text NOT NULL,
  is_live           boolean NOT NULL DEFAULT false,
  has_tracked       boolean NOT NULL DEFAULT false,
  is_medal_session  boolean NOT NULL DEFAULT false,
  hash              text NOT NULL,
  payload           jsonb NOT NULL,
  updated_at        timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions (competition_date, starts_at);
CREATE INDEX IF NOT EXISTS idx_sessions_live ON sessions (is_live, has_tracked);

-- The brief's `sessions_of_interest`: every session with at least one tracked
-- participant. Modelled as a partial index rather than a copied table, so the set
-- cannot drift out of sync with the schedule it is derived from.
CREATE INDEX IF NOT EXISTS idx_sessions_of_interest
  ON sessions (starts_at) WHERE has_tracked;

CREATE TABLE IF NOT EXISTS participants (
  reg_id      text NOT NULL,   -- numeric-looking for individuals, composite for teams
  sport_code  text NOT NULL,
  event_key   text NOT NULL,
  org_code    text NOT NULL,
  name        text NOT NULL,
  payload     jsonb NOT NULL,
  PRIMARY KEY (reg_id, sport_code, event_key)
);
CREATE INDEX IF NOT EXISTS idx_participants_org ON participants (org_code, sport_code);

CREATE TABLE IF NOT EXISTS results (
  session_id  text NOT NULL,
  reg_id      text NOT NULL,
  org_code    text NOT NULL,
  rank_sort   integer NOT NULL DEFAULT 0,
  hash        text NOT NULL,
  payload     jsonb NOT NULL,
  updated_at  timestamptz NOT NULL,
  PRIMARY KEY (session_id, reg_id)
);

-- Append-only. A result corrected after going UNOFFICIAL leaves a trail instead of
-- being silently overwritten.
CREATE TABLE IF NOT EXISTS result_history (
  id           bigserial PRIMARY KEY,
  session_id   text NOT NULL,
  reg_id       text NOT NULL,
  hash         text NOT NULL,
  payload      jsonb NOT NULL,
  recorded_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_session ON result_history (session_id, recorded_at);

CREATE TABLE IF NOT EXISTS medal_tally (
  org_code      text PRIMARY KEY,
  rank_by_gold  integer NOT NULL DEFAULT 0,
  hash          text NOT NULL,
  payload       jsonb NOT NULL,
  updated_at    timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS medal_wins (
  id        text PRIMARY KEY,   -- hash of (org, sport, event, medal, name)
  org_code  text NOT NULL,
  won_at    timestamptz NOT NULL,
  hash      text NOT NULL,
  payload   jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wins_org ON medal_wins (org_code, won_at DESC);

CREATE TABLE IF NOT EXISTS meta (
  key    text PRIMARY KEY,
  value  text NOT NULL
);
