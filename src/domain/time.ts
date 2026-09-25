/** Japan Standard Time - the source's wall clock. No DST during the Games. */
export const JST_OFFSET_MINUTES = 9 * 60;
/** India Standard Time - the display clock. */
export const IST_OFFSET_MINUTES = 5 * 60 + 30;

/**
 * Parse an upstream instant (ISO-8601 carrying a +09:00 offset) to an ISO UTC string.
 * Returns null rather than throwing, so one bad timestamp cannot stall a poll.
 */
export function toUtc(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

/** The local competition date (JST) an instant belongs to, as YYYY-MM-DD. */
export function competitionDate(utcIso: string): string {
  const shifted = new Date(Date.parse(utcIso) + JST_OFFSET_MINUTES * 60_000);
  return shifted.toISOString().slice(0, 10);
}

/** Today's competition date in JST. */
export function todayJst(now = new Date()): string {
  return new Date(now.getTime() + JST_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);
}

/** Format an ISO UTC instant as IST wall time, e.g. "14:30". */
export function toIstTime(utcIso: string): string {
  const shifted = new Date(Date.parse(utcIso) + IST_OFFSET_MINUTES * 60_000);
  return shifted.toISOString().slice(11, 16);
}
