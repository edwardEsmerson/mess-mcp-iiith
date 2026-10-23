// GET /metrics (Prometheus text format) and GET /dashboard (HTML), both behind a password the operator picks.
// Browsers sign in on a small form and get a cookie; scrapers send the password as a bearer token.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import express, { Router, type Request, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import type { ConnectionStats } from "../auth/model.js";
import { renderDashboardSignIn } from "../auth/pages.js";
import { todayIST } from "../lib/schemas.js";
import { connectionsByApp, renderDashboard, WINDOWS } from "./dashboard.js";
import { render } from "./prometheus.js";
import { shiftDay, type MetricsRecorder } from "./recorder.js";

export interface MetricsRouterDeps {
  password: string;
  recorder: MetricsRecorder;
  connections: ConnectionStats;
  version: string;
  host: string;
  /** Mark the session cookie Secure (true whenever the public URL is https). */
  secureCookie: boolean;
}

const COOKIE = "mess_mcp_dashboard";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

const PAGE_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

export function metricsRouter(deps: MetricsRouterDeps): Router {
  const router = Router();
  const session = new DashboardSession(deps.password);
  // Only failed attempts count, so a scraper or a signed-in browser is never limited
  const limitGuesses = rateLimit({ windowMs: 15 * 60_000, limit: 30, skipSuccessfulRequests: true, standardHeaders: "draft-8", legacyHeaders: false });

  router.post("/dashboard", limitGuesses, express.urlencoded({ extended: false, limit: "2kb" }), (req, res) => {
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!session.checkPassword(password)) {
      res.status(401).set(PAGE_HEADERS).type("html").send(renderDashboardSignIn("That password isn't right."));
      return;
    }
    res.cookie(COOKIE, session.issue(Date.now()), { httpOnly: true, secure: deps.secureCookie, sameSite: "strict", path: "/", maxAge: SESSION_MS });
    res.redirect(303, "/dashboard");
  });

  router.post("/dashboard/sign-out", (_req, res) => {
    res.clearCookie(COOKIE, { httpOnly: true, secure: deps.secureCookie, sameSite: "strict", path: "/" });
    res.redirect(303, "/dashboard");
  });

  router.get("/metrics", limitGuesses, (req, res, next) => {
    if (session.allows(req)) return next();
    res.set("WWW-Authenticate", 'Bearer realm="mess-mcp metrics"').status(401).type("text/plain").send("Send the dashboard password as a bearer token.");
  });

  router.get("/dashboard", (req, res, next) => {
    if (session.allows(req)) return next();
    res.status(401).set(PAGE_HEADERS).type("html").send(renderDashboardSignIn());
  });

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
    res.set(PAGE_HEADERS).type("html").send(html);
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

/**
 * Checks the dashboard password and the cookie a browser gets after signing in.
 * The cookie is "<expiry>.<HMAC of expiry>", keyed by the password, so changing the password signs everyone out.
 */
class DashboardSession {
  private readonly passwordDigest: Buffer;
  private readonly cookieKey: Buffer;

  constructor(password: string) {
    this.passwordDigest = digest(password);
    this.cookieKey = createHash("sha256").update("mess-mcp dashboard session\0").update(password).digest();
  }

  checkPassword(presented: string): boolean {
    // Comparing fixed-length digests keeps the check constant-time whatever was sent
    return timingSafeEqual(digest(presented), this.passwordDigest);
  }

  issue(now: number): string {
    const expires = String(now + SESSION_MS);
    return `${expires}.${this.sign(expires)}`;
  }

  allows(req: Request): boolean {
    // Everything after "Bearer ", since a chosen password may contain spaces
    const bearer = req.headers.authorization?.match(/^bearer (.+)$/is)?.[1];
    if (bearer) return this.checkPassword(bearer);
    const cookie = readCookie(req.headers.cookie, COOKIE);
    if (!cookie) return false;
    const [expires, signature] = cookie.split(".", 2);
    if (!signature || !(Number(expires) > Date.now())) return false;
    const expected = Buffer.from(this.sign(expires));
    const given = Buffer.from(signature);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  private sign(expires: string): string {
    return createHmac("sha256", this.cookieKey).update(expires).digest("base64url");
  }
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
