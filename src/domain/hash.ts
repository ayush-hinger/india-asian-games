import { createHash } from "node:crypto";

/**
 * Stable structural hash of a normalized record.
 *
 * Keys are sorted at every level so that upstream reordering an object - which it
 * does between responses - does not read as a change. Used to persist and emit only
 * on real change, keeping write and SSE volume proportional to actual updates.
 */
export function hashRecord(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex").slice(0, 32);
}

function canonical(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
