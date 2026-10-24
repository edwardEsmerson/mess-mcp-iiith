// Input schemas, tool annotations and IST date helpers shared by the tools.
// The mess runs on IST, so "today" is computed in Asia/Kolkata regardless of the host's timezone.

import { z } from "zod";
import type { ToolAnnotations } from "@modelcontextprotocol/server";

export const MEALS = ["breakfast", "lunch", "snacks", "dinner"] as const;

// What a date, a meal and a mess ID are is said once, in the server instructions, so these carry no
// descriptions: tools/list pays for every one of them on every tool that takes them.
export const meal = z.enum(MEALS);
// Rejects dates that don't exist (2026-02-30). Clients see just `format: "date"`, not zod's long
// leap-year regex (see compactJsonSchema); the error teaches the format to clients that skip the instructions.
export const date = z.iso.date({ error: "Use a calendar date as YYYY-MM-DD, e.g. 2026-10-25" });
export const optionalDate = date.optional();
export const month = z.number().int().min(1).max(12);
export const year = z.number().int().min(2000).max(2100).describe("Year, e.g. 2026");
export const messId = z.string();

// zod's JSON Schema has noise a model gains nothing from, yet every tools/list sends it:
// a $schema URL on each tool, ±2^53 bounds on each .int() and the regex behind each date's
// `format: "date"`. Drop these from what clients see; validation is still zod's.
export function compactJsonSchema<T extends z.ZodType>(schema: T): T {
  const std = schema["~standard"];
  schema["~standard"] = {
    ...std,
    jsonSchema: { ...std.jsonSchema, input: (options) => stripSchemaNoise(std.jsonSchema.input(options)) as Record<string, unknown> },
  };
  return schema;
}

function stripSchemaNoise(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripSchemaNoise);
  if (typeof node !== "object" || node === null) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$schema") continue;
    if (key === "pattern" && "format" in node && node.format === "date") continue;
    if (key === "maximum" && value === Number.MAX_SAFE_INTEGER) continue;
    if (key === "minimum" && value === Number.MIN_SAFE_INTEGER) continue;
    out[key] = stripSchemaNoise(value);
  }
  return out;
}

export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, openWorldHint: true };
export const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
export const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

/** Today's date in IST. `now` is injectable so tests can pin the clock. */
export function todayIST(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now);
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Lowercase English weekday name of a YYYY-MM-DD date, e.g. "sunday". */
export function weekdayOf(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleString("en-US", { weekday: "long", timeZone: "UTC" }).toLowerCase();
}
