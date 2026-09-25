import { config } from "../config.ts";
import { log } from "../log.ts";
import type { Store } from "./types.ts";

export type { Store, SessionQuery } from "./types.ts";

export async function createStore(): Promise<Store> {
  const store: Store = config.store === "postgres"
    ? new (await import("./postgres.ts")).PostgresStore()
    : new (await import("./sqlite.ts")).SqliteStore();

  await store.init();
  log.info("store ready", { driver: config.store });
  return store;
}
