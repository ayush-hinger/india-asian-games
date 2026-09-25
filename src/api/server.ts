import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { Bus } from "../bus/index.ts";
import { config } from "../config.ts";
import { log } from "../log.ts";
import type { Store } from "../store/index.ts";
import { routes, type RouteContext } from "./routes.ts";
import { SseHub } from "./sse.ts";

const WEB_ROOT = fileURLToPath(new URL("../../web", import.meta.url));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

type Handler = (ctx: RouteContext, params: URLSearchParams) => Promise<unknown>;

const API: Record<string, Handler> = {
  "/api/health": routes.health,
  "/api/schedule": routes.schedule,
  "/api/live": routes.live,
  "/api/upcoming": routes.upcoming,
  "/api/medals": routes.medals,
  "/api/sports": routes.sports,
  "/api/sport": routes.sport,
  "/api/session": routes.session,
  "/api/contingent": routes.contingent,
  "/api/discussion": routes.discussion,
};

export function createServer(store: Store, bus: Bus) {
  const sse = new SseHub();
  sse.start(bus);
  const ctx: RouteContext = { store, sse };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // The dashboard is same-origin, but keep the API readable from other tools.
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (req.method !== "GET" && req.method !== "HEAD") {
      return send(res, 405, { error: "method not allowed" });
    }

    if (url.pathname === "/api/events") {
      sse.attach(res);
      return;
    }

    const handler = API[url.pathname];
    if (handler) {
      const started = Date.now();
      try {
        const body = await handler(ctx, url.searchParams);
        send(res, 200, body);
        log.debug("api", { path: url.pathname, ms: Date.now() - started });
      } catch (err) {
        log.error("api handler failed", { path: url.pathname, err });
        send(res, 500, { error: "internal error" });
      }
      return;
    }

    serveStatic(url.pathname, res);
  });

  return { server, sse };
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    // Every read model is poll-or-push driven; never let a proxy cache it.
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function serveStatic(pathname: string, res: http.ServerResponse): void {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  // normalize + prefix check keeps "../" out of the web root.
  const full = normalize(join(WEB_ROOT, rel));
  if (!full.startsWith(WEB_ROOT) || !existsSync(full) || !statSync(full).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }
  res.writeHead(200, { "Content-Type": MIME[extname(full)] ?? "application/octet-stream" });
  createReadStream(full).pipe(res);
}

export function listen(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    // Bind all interfaces explicitly: platforms such as Render route to the
    // container's external address, and a loopback-only bind is unreachable there.
    server.listen(config.port, "0.0.0.0", () => {
      log.info("http listening", { port: config.port, url: `http://localhost:${config.port}` });
      resolve();
    });
  });
}
