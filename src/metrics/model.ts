// What the metrics layer stores. Everything is an aggregate: per IST day, per tool, per outcome.
// The one per-user record is "this grant was active on this day", kept by opaque grant ID only
// long enough to count active users. Nothing here holds a key, a token or anything the portal returned.

/** How a tool call ended. portal_rejected is the portal saying no (bad input, past a deadline, revoked key). */
export type ToolOutcome = "ok" | "portal_rejected" | "portal_down" | "error";

/** One counter's total for one day. Days are IST dates, YYYY-MM-DD. */
export interface DailyCount {
  day: string;
  name: string;
  label: string;
  value: number;
}

export interface ActiveMark {
  day: string;
  subject: string;
}

export interface MetricsStore {
  /** Adds counts onto the stored totals and records active marks, in one transaction. */
  write(counts: DailyCount[], active: ActiveMark[]): void;
  counts(sinceDay: string): DailyCount[];
  activePerDay(sinceDay: string): { day: string; count: number }[];
  /** Distinct subjects active on or after sinceDay. */
  activeSince(sinceDay: string): number;
  prune(countsBefore: string, activeBefore: string): void;
}
