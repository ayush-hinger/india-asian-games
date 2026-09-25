import type { ServerResponse } from "node:http";
import type { Bus, BusEvent } from "../bus/index.ts";
import { log } from "../log.ts";

/**
 * Server-Sent Events fan-out.
 *
 * One-directional, which is all a score feed needs, and it survives proxies and
 * reconnects without the ceremony of a websocket. Clients reconnect on their own;
 * the heartbeat exists to stop idle intermediaries closing the connection.
 */
export class SseHub {
  private readonly clients = new Set<ServerResponse>();
  private heartbeat: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;

  start(bus: Bus): void {
    this.unsubscribe = bus.subscribe((event) => this.broadcast(event));
    this.heartbeat = setInterval(() => {
      for (const res of this.clients) res.write(": ping\n\n");
    }, 25_000);
    this.heartbeat.unref();
  }

  attach(res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 3000\n\n");
    res.write(`event: hello\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);

    this.clients.add(res);
    log.debug("sse client attached", { clients: this.clients.size });

    const drop = () => {
      this.clients.delete(res);
      log.debug("sse client dropped", { clients: this.clients.size });
    };
    res.on("close", drop);
    res.on("error", drop);
  }

  private broadcast(event: BusEvent): void {
    if (this.clients.size === 0) return;
    const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(frame);
      } catch (err) {
        log.warn("sse write failed", { err });
        this.clients.delete(res);
      }
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.unsubscribe?.();
    for (const res of this.clients) res.end();
    this.clients.clear();
  }
}
