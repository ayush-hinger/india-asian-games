import { config } from "../config.ts";

/**
 * Links back to the official results site (results.asiangames2026.org).
 *
 * The site is a Vue SPA using hash routing, so an event's page is
 * `/#/discipline/<DISC>/results/<ResCode>` - the same discipline scope and raw
 * ResCode we poll the API with. The server only ever sees `/`, which always
 * loads; the path-style form without `#` is the one that 404s
 * (docs/api-notes.md section 4a).
 */
export function eventPageUrl(sportCode: string, resCode: string): string {
  return `${config.sourceOrigin}/#/discipline/${encodeURIComponent(sportCode)}/results/${encodeURIComponent(resCode)}`;
}
