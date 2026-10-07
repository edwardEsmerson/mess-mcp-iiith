// Input schemas, tool annotations and IST date helpers shared by the tools.
// The mess runs on IST, so "today" is computed in Asia/Kolkata regardless of the host's timezone.

import { z } from "zod";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

export const meal = z.enum(["breakfast", "lunch", "snacks", "dinner"]).describe("Meal type");
export const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").describe("Date as YYYY-MM-DD");
export const optionalDate = date.optional().describe("Date as YYYY-MM-DD. Defaults to today (IST).");
export const month = z.number().int().min(1).max(12).describe("Month, 1-12");
export const year = z.number().int().min(2000).max(2100).describe("Year, e.g. 2026");
export const messId = z.string().min(1).describe("Mess ID from get_mess_info, e.g. yuktahar or kadamba-veg");

export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, openWorldHint: true };
export const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
export const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

export function todayIST(): string {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}

export function weekdayOf(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleString("en-US", { weekday: "long", timeZone: "UTC" }).toLowerCase();
}
