import type { MedalKind, ParticipantType, SessionStatus } from "../domain/types.ts";
import { log } from "../log.ts";

export const str = (v: unknown, fallback = ""): string =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : fallback;

export const num = (v: unknown, fallback = 0): number => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
};

export const bool = (v: unknown, fallback = false): boolean =>
  typeof v === "boolean" ? v : fallback;

const STATUS: Record<string, SessionStatus> = {
  SCHEDULED: "scheduled",
  START_LIST: "start_list",
  GETTING_READY: "getting_ready",
  DELAYED: "delayed",
  RUNNING: "running",
  // Seen only once the Games were under way, not in the Phase 0 day capture.
  INTERMEDIATE: "intermediate",
  UNOFFICIAL: "unofficial",
  PROVISIONAL: "provisional",
  OFFICIAL: "official",
};

/** Unknown statuses degrade to "unknown" and are logged - the source can add values. */
export function toStatus(raw: unknown, where: string): SessionStatus {
  const key = str(raw).toUpperCase();
  if (key === "") return "unknown";
  const mapped = STATUS[key];
  if (!mapped) {
    log.drift(where, { field: "Status", value: key });
    return "unknown";
  }
  return mapped;
}

const PARTICIPANT_TYPE: Record<string, ParticipantType> = {
  A: "athlete",
  T: "team",
  D: "pair",
};

export function toParticipantType(raw: unknown, where: string): ParticipantType {
  const key = str(raw).toUpperCase();
  if (key === "") return "unknown";
  const mapped = PARTICIPANT_TYPE[key];
  if (!mapped) {
    log.drift(where, { field: "Type", value: key });
    return "unknown";
  }
  return mapped;
}

const MEDAL: Record<string, MedalKind> = {
  ME_GOLD: "gold",
  ME_SILVER: "silver",
  ME_BRONZE: "bronze",
};

/** Returns null for "no medal", which is the common case. */
export function toMedal(raw: unknown, where: string): MedalKind | null {
  const key = str(raw).toUpperCase();
  if (key === "" || key === "0") return null;
  const mapped = MEDAL[key];
  if (!mapped) {
    log.drift(where, { field: "Medal", value: key });
    return null;
  }
  return mapped;
}

/**
 * Run an adapter over a list, dropping (and logging) any record that throws.
 * A single malformed record must never take down a whole poll.
 */
export function mapSafe<R, T>(rows: readonly R[] | undefined, where: string, fn: (row: R) => T | null): T[] {
  if (!Array.isArray(rows)) {
    if (rows !== undefined) log.drift(where, { expected: "array", got: typeof rows });
    return [];
  }
  const out: T[] = [];
  for (const row of rows) {
    try {
      const mapped = fn(row);
      if (mapped !== null) out.push(mapped);
    } catch (err) {
      log.drift(where, { err: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
