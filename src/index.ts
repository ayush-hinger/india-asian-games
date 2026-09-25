import { Bus } from "./bus/index.ts";
import { config } from "./config.ts";
import { createServer, listen } from "./api/server.ts";
import { Poller } from "./jobs/scheduler.ts";
import { log } from "./log.ts";
import { createStore } from "./store/index.ts";

async function main(): Promise<void> {
  log.info("starting", {
    country: config.country,
    store: config.store,
    poller: config.pollerEnabled,
    cacheTtlSeconds: config.cacheTtlSeconds,
  });

  const store = await createStore();
  const bus = new Bus();
  bus.start();

  const { server, sse } = createServer(store, bus);
  await listen(server);

  // Serving stored data without polling is a valid mode - useful for a replica
  // process, or for working on the UI without touching the upstream source.
  const poller = config.pollerEnabled ? new Poller({ store, bus }) : null;
  if (poller) {
    poller.start().catch((err) => log.error("poller failed to start", { err }));
  } else {
    log.info("poller disabled");
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down", { signal });
    poller?.stop();
    sse.stop();
    bus.stop();
    server.close();
    await store.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // A rejected promise anywhere must not take the tracker down mid-Games.
  process.on("unhandledRejection", (err) => log.error("unhandled rejection", { err }));
  process.on("uncaughtException", (err) => log.error("uncaught exception", { err }));
}

main().catch((err) => {
  log.error("fatal", { err });
  process.exit(1);
});
