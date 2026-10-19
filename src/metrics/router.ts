// GET /metrics (Prometheus text format) and GET /dashboard (HTML), both behind METRICS_TOKEN.
// The token is accepted as a bearer token (for scrapers) or as the password of HTTP Basic auth
// (so a browser shows its own sign-in prompt; any username works).

import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import type { ConnectionStats } from "../auth/model.js";
import { todayIST } from "../lib/schemas.js";
import { connectionsByApp, renderDashboard, WINDOWS } from "./dashboard.js";
import { render } from "./prometheus.js";
import { shiftDay, type MetricsRecorder } from "./recorder.js";

export interface MetricsRouterDeps {
  token: string;
  recorder: MetricsRecorder;
  connections: ConnectionStats;
  version: string;
  host: string;
}

export function metricsRouter(deps: MetricsRouterDeps): Router {
  const router = Router();
  // Only failed attempts count, so a scraper with the right token is never limited
  router.use(["/metrics", "/dashboard"], rateLimit({ windowMs: 15 * 60_000, limit: 30, skipSuccessfulRequests: true, standardHeaders: "draft-8", legacyHeaders: false }));
  router.use(["/metrics", "/dashboard"], requireToken(deps.token));

  router.get("/metrics", (_req, res) => {
    const { recorder } = deps;
    const { store } = recorder;
    recorder.flush();
    const now = Date.now();
    const today = todayIST();
    const text = render(
      [recorder.toolCalls, recorder.toolDuration, recorder.signIns, recorder.revocations, recorder.httpRequests],
      [
        {
          name: "mess_mcp_connections",
          help: "Connections an app can still use, by app name.",
          values: connectionsByApp(deps.connections.connectedByClient(now)).map((c) => ({ labels: { app: c.app }, value: c.count })),
        },
        {
          name: "mess_mcp_active_users",
          help: "Connections that made a tool call, over the trailing window (IST days, today included).",
          values: [1, 7, 30].map((days) => ({ labels: { window: `${days}d` }, value: store.activeSince(shiftDay(today, 1 - days)) })),
        },
        { name: "mess_mcp_build_info", help: "Server version.", values: [{ labels: { version: deps.version }, value: 1 }] },
        { name: "process_start_time_seconds", help: "Start time of the process since the Unix epoch.", values: [{ value: Math.floor(recorder.startedAt / 1000) }] },
        { name: "process_resident_memory_bytes", help: "Resident memory size in bytes.", values: [{ value: process.memoryUsage.rss() }] },
      ],
    );
    res.set("Cache-Control", "no-store").type("text/plain; version=0.0.4").send(text);
  });

  router.get("/dashboard", (req, res) => {
    const { recorder } = deps;
    const { store } = recorder;
    const requested = Number(req.query.days);
    const days = WINDOWS.includes(requested) ? requested : 30;
    recorder.flush();
    const now = Date.now();
    const today = todayIST();
    const since = shiftDay(today, 1 - days);
    const html = renderDashboard({
      days,
      today,
      counts: store.counts(since),
      activePerDay: store.activePerDay(since),
      activeInWindow: store.activeSince(since),
      connected: deps.connections.connectedByClient(now),
      portal: recorder.portal,
      host: deps.host,
      version: deps.version,
      startedAt: recorder.startedAt,
      now,
      rssBytes: process.memoryUsage.rss(),
    });
    res
      .set({
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "no-store",
      })
      .type("html")
      .send(html);
  });

  return router;
}

/** Counts every request once it finishes. Paths outside `routes` are counted as "other" so label values stay bounded. */
export function measureRequests(recorder: MetricsRecorder, routes: string[]): RequestHandler {
  const known = new Set(routes);
  return (req, res, next) => {
    res.on("finish", () => recorder.httpRequest(known.has(req.path) ? req.path : "other", req.method, res.statusCode));
    next();
  };
}

function requireToken(token: string): RequestHandler {
  const expected = digest(token);
  return (req: Request, res: Response, next: NextFunction) => {
    const presented = presentedToken(req.headers.authorization);
    // Comparing fixed-length digests keeps the check constant-time whatever was sent
    if (presented !== undefined && timingSafeEqual(digest(presented), expected)) return next();
    res.set("WWW-Authenticate", 'Basic realm="mess-mcp metrics", charset="UTF-8"').status(401).type("text/plain").send("Metrics token required.");
  };
}

function presentedToken(header: string | undefined): string | undefined {
  const [scheme, value] = header?.split(" ", 2) ?? [];
  if (!value) return undefined;
  if (scheme.toLowerCase() === "bearer") return value;
  if (scheme.toLowerCase() !== "basic") return undefined;
  const decoded = Buffer.from(value, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  return colon === -1 ? undefined : decoded.slice(colon + 1);
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
