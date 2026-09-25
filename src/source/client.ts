import { config, userAgent } from "../config.ts";
import { log } from "../log.ts";
import { decodeBody } from "./decode.ts";

export class SourceError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(message: string, status: number, url: string) {
    super(message);
    this.name = "SourceError";
    this.status = status;
    this.url = url;
  }
}

export interface SourceResponse<T> {
  data: T;
  /** CDN cache age in seconds, when the edge reports one. */
  age: number | null;
  url: string;
}

const headers = {
  // Upstream pins access-control-allow-origin to this value and rejects other origins.
  Origin: config.sourceOrigin,
  Referer: `${config.sourceOrigin}/`,
  "User-Agent": userAgent,
  Accept: "application/json",
};

/**
 * Fetch one upstream resource.
 *
 * `scope` is `ALL` or a three-letter discipline code, and the two are NOT
 * interchangeable: several routes exist only under one of them and return a 404
 * body `{"code":404,...}` under the other. See docs/api-notes.md section 2.
 */
export async function fetchSource<T>(
  path: string,
  scope = "ALL",
  opts: { retries?: number; timeoutMs?: number } = {},
): Promise<SourceResponse<T>> {
  const { retries = 2, timeoutMs = 15_000 } = opts;
  const url = `${config.sourceRoot}/${scope}${path}`;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const backoff = 500 * 2 ** (attempt - 1) + Math.random() * 250;
      await new Promise((r) => setTimeout(r, backoff));
    }
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });

      if (!res.ok) {
        // 404 means "no such service at this scope" and will never succeed on retry.
        if (res.status === 404) throw new SourceError("service does not exist", 404, url);
        throw new SourceError(`upstream ${res.status}`, res.status, url);
      }

      const text = await res.text();
      const ageHeader = res.headers.get("age");
      const data = decodeBody(text) as T;

      log.debug("source fetch", { url, age: ageHeader, bytes: text.length });
      return { data, age: ageHeader === null ? null : Number(ageHeader), url };
    } catch (err) {
      if (err instanceof SourceError && err.status === 404) throw err;
      lastErr = err;
      log.warn("source fetch failed", { url, attempt, err });
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Fetch that resolves to `null` instead of throwing, for optional/unstable routes. */
export async function tryFetchSource<T>(path: string, scope = "ALL"): Promise<T | null> {
  try {
    return (await fetchSource<T>(path, scope)).data;
  } catch (err) {
    log.warn("optional fetch failed", { path, scope, err });
    return null;
  }
}
