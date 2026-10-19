// Records what the server does, two ways: process-lifetime counters for Prometheus to scrape, and
// daily totals (IST days) in SQLite so the dashboard keeps its history across restarts. Daily totals
// are buffered and written by flush(), so a tool call never waits on a disk write.

import { MessApiError } from "../api/client.js";
import { systemClock, type AuthEvents, type Clock, type SignInOutcome } from "../auth/model.js";
import { todayIST } from "../lib/schemas.js";
import type { ActiveMark, DailyCount, MetricsStore, ToolOutcome } from "./model.js";
import { Counter, Histogram } from "./prometheus.js";

/** Anonymous daily totals are kept a little over a year; active marks (which hold grant IDs) only as long as the dashboard's widest window. */
const COUNT_RETENTION_DAYS = 400;
export const ACTIVE_RETENTION_DAYS = 90;

export interface PortalHealth {
  lastReachedAt?: number;
  lastUnreachableAt?: number;
}

export class MetricsRecorder implements AuthEvents {
  readonly toolCalls = new Counter("mess_mcp_tool_calls_total", "Tool calls by tool and outcome.");
  readonly toolDuration = new Histogram("mess_mcp_tool_call_duration_seconds", "Tool call duration, including the portal round trip.", [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15]);
  readonly signIns = new Counter("mess_mcp_sign_ins_total", "Sign-in page submissions by outcome.");
  readonly revocations = new Counter("mess_mcp_grants_revoked_total", "Connections ended by the server.");
  readonly httpRequests = new Counter("mess_mcp_http_requests_total", "HTTP requests by route, method and status.");

  readonly startedAt: number;
  readonly portal: PortalHealth = {};
  private pending = new Map<string, DailyCount>();
  private pendingActive = new Map<string, ActiveMark>();

  constructor(
    readonly store: MetricsStore,
    private readonly clock: Clock = systemClock,
    private readonly today: () => string = todayIST,
  ) {
    this.startedAt = clock();
  }

  toolCall(tool: string, durationMs: number, error?: unknown, grantId?: string): void {
    const outcome = toolOutcome(error);
    this.toolCalls.inc({ tool, outcome });
    this.toolDuration.observe({ tool }, durationMs / 1000);

    this.count("tool_calls", tool);
    if (outcome !== "ok") this.count("tool_failures", tool);
    this.count("tool_ms", tool, Math.round(durationMs));
    this.count("tool_outcome", outcome);

    if (outcome === "portal_down") this.portal.lastUnreachableAt = this.clock();
    else if (outcome !== "error") this.portal.lastReachedAt = this.clock();

    if (grantId) {
      const day = this.today();
      this.pendingActive.set(`${day}|${grantId}`, { day, subject: grantId });
    }
  }

  signIn(outcome: SignInOutcome): void {
    this.signIns.inc({ outcome });
    this.count("sign_in", outcome);
    if (outcome === "portal_unreachable") this.portal.lastUnreachableAt = this.clock();
    else if (outcome !== "cancelled") this.portal.lastReachedAt = this.clock();
  }

  /** The portal refused a stored key, so its grant was revoked. */
  grantRevoked(): void {
    this.revocations.inc({ reason: "portal_key_rejected" });
    this.count("revoked", "portal_key_rejected");
  }

  httpRequest(route: string, method: string, status: number): void {
    this.httpRequests.inc({ route, method, status: String(status) });
  }

  /** Writes buffered daily totals. Call periodically, before reading the store, and on shutdown. */
  flush(): void {
    const counts = [...this.pending.values()];
    const active = [...this.pendingActive.values()];
    this.pending = new Map();
    this.pendingActive = new Map();
    this.store.write(counts, active);
  }

  prune(): void {
    const today = this.today();
    this.store.prune(shiftDay(today, -COUNT_RETENTION_DAYS), shiftDay(today, -ACTIVE_RETENTION_DAYS));
  }

  private count(name: string, label: string, by = 1): void {
    const day = this.today();
    const key = `${day}|${name}|${label}`;
    const entry = this.pending.get(key);
    if (entry) entry.value += by;
    else this.pending.set(key, { day, name, label, value: by });
  }
}

export function toolOutcome(error: unknown): ToolOutcome {
  if (error === undefined) return "ok";
  if (!(error instanceof MessApiError)) return "error";
  // MessApiClient uses status 0 for "couldn't connect"
  return error.status === 0 || error.status >= 500 ? "portal_down" : "portal_rejected";
}

/** YYYY-MM-DD plus or minus whole days. */
export function shiftDay(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
