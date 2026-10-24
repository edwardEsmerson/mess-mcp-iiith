// Runs one portal write per meal for the tools that take a list of meals, and reports each outcome.

import { MessApiError } from "../api/client.js";
import { weekdayOf } from "./schemas.js";

interface MealRef {
  date: string;
  meal: string;
  mess?: string;
}

export type MealResult = { date: string; weekday: string; meal: string; mess?: string; ok: boolean; error?: string };

// Over a month's worth of meals a call would take long enough for a client to give up on it
export const MAX_MEALS_PER_CALL = 31;

/**
 * Applies `write` to each meal in order. One meal failing doesn't hide the others' results; if every
 * meal fails the whole call fails, with the reason for each. Losing the portal (unreachable, or the key
 * rejected) is not about any one meal, so it stops the rest instead of repeating itself for each.
 */
export async function eachMeal<T extends MealRef>(meals: T[], write: (item: T) => Promise<unknown>): Promise<MealResult[]> {
  const results: MealResult[] = [];
  let firstError: unknown;
  let stopped: string | undefined;
  for (const item of meals) {
    const label = { date: item.date, weekday: weekdayOf(item.date), meal: item.meal, ...(item.mess ? { mess: item.mess } : {}) };
    if (stopped) {
      results.push({ ...label, ok: false, error: `Not attempted: ${stopped}` });
      continue;
    }
    try {
      await write(item);
      results.push({ ...label, ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof MessApiError && (error.status === 0 || error.status === 401)) stopped = message;
      firstError ??= error;
      results.push({ ...label, ok: false, error: message });
    }
  }
  if (results.every((r) => !r.ok)) throw failure(results, firstError);
  return results;
}

function failure(results: MealResult[], cause: unknown): Error {
  const text = results.map((r) => `${r.date} ${r.weekday} ${r.meal}: ${r.error}`).join("\n");
  // Keep the portal's status so metrics can tell a rejection from an outage
  return cause instanceof MessApiError ? new MessApiError(text, cause.status) : new Error(text);
}
