import { readFileSync } from "node:fs";

/** Load a captured upstream response. Fixtures wrap the payload in `_fixture`/`data`. */
export function fixture<T>(name: string): T {
  const raw = readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8");
  return JSON.parse(raw).data as T;
}
