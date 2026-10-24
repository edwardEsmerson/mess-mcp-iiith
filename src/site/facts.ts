// How long things live, worded for the public pages. Read from the same constants the server uses,
// so a page can't drift from the code when a lifetime changes.

import { DEFAULT_LIFETIMES } from "../auth/tokens.js";
import { ACTIVE_RETENTION_DAYS } from "../metrics/recorder.js";

/** "5 minutes", "1 hour", "60 days": the largest whole unit. */
export function duration(ms: number): string {
  for (const [unit, size] of [["day", 86_400_000], ["hour", 3_600_000], ["minute", 60_000]] as const) {
    if (ms >= size && ms % size === 0) return `${ms / size} ${unit}${ms === size ? "" : "s"}`;
  }
  return `${Math.round(ms / 1000)} seconds`;
}

export const CODE_LIFETIME = duration(DEFAULT_LIFETIMES.codeMs);
export const ACCESS_TOKEN_LIFETIME = duration(DEFAULT_LIFETIMES.accessMs);
export const REFRESH_TOKEN_LIFETIME = duration(DEFAULT_LIFETIMES.refreshMs);
export const ACTIVE_LIST_RETENTION = `${ACTIVE_RETENTION_DAYS} days`;
