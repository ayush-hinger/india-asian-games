import { EventEmitter } from "node:events";
import { config } from "../config.ts";
import { log } from "../log.ts";
import { RedisConnection } from "./resp.ts";

export type BusEvent =
  | { type: "session.updated"; session: unknown }
  | { type: "results.updated"; sessionId: string; results: unknown }
  | { type: "live.updated"; live: unknown }
  | { type: "medals.updated"; tally: unknown }
  | { type: "medal.won"; win: unknown }
  | { type: "discussion.updated"; thread: unknown };

const CHANNEL = "ag2026:events";

/**
 * Fan-out for live updates.
 *
 * Publishes through Redis when REDIS_URL is set, so several API processes can each
 * serve SSE clients from one poller. Without Redis - or while the connection is
 * down - it degrades to in-process delivery, which is correct for a single node.
 */
export class Bus {
  private readonly local = new EventEmitter();
  private publisher: RedisConnection | null = null;
  private subscriber: RedisConnection | null = null;
  private redisUp = false;

  constructor() {
    this.local.setMaxListeners(0);
  }

  start(): void {
    if (!config.redisUrl) {
      log.info("bus: in-process only", { reason: "REDIS_URL not set" });
      return;
    }
    const url = new URL(config.redisUrl);
    const onError = (err: Error) => {
      if (this.redisUp) log.warn("bus: redis error", { err });
      this.redisUp = false;
    };

    this.publisher = new RedisConnection(url, () => {}, () => { this.redisUp = true; }, onError);
    this.subscriber = new RedisConnection(
      url,
      (channel, payload) => {
        if (channel !== CHANNEL) return;
        try {
          this.local.emit("event", JSON.parse(payload));
        } catch (err) {
          log.warn("bus: undecodable payload", { err });
        }
      },
      (conn) => conn.send("SUBSCRIBE", CHANNEL),
      onError,
    );

    this.publisher.connect();
    this.subscriber.connect();
    log.info("bus: redis pub/sub", { url: `${url.hostname}:${url.port || 6379}` });
  }

  publish(event: BusEvent): void {
    if (this.redisUp && this.publisher) {
      // Redis echoes to our own subscriber, so do not also emit locally or
      // every SSE client would receive the event twice.
      this.publisher.send("PUBLISH", CHANNEL, JSON.stringify(event));
    } else {
      this.local.emit("event", event);
    }
  }

  subscribe(listener: (event: BusEvent) => void): () => void {
    this.local.on("event", listener);
    return () => this.local.off("event", listener);
  }

  stop(): void {
    this.publisher?.close();
    this.subscriber?.close();
  }
}
