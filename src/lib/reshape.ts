// Trims portal responses that are mostly noise to a model: empty menu slots, registration IDs and
// timestamps. Only for shapes we have seen live; everything else is passed through as the portal sent it.

import { MEALS, weekdayOf } from "./schemas.js";

type Row = Record<string, unknown>;
const rows = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : []);

/**
 * One day's menus. The portal sends a week per mess with many empty slots ({ item: "" }); this keeps
 * the given weekday, drops the empty slots, and writes each dish as "Category: item". Optionally
 * only one meal and/or one mess.
 */
export function dayMenus(menus: unknown, weekday: string, meal?: string, mess?: string) {
  return rows(menus)
    .filter((entry) => !mess || entry.mess === mess)
    .map((entry) => {
      const day = (entry.days as Record<string, Row> | undefined)?.[weekday];
      const menu: Record<string, string[]> = {};
      for (const name of MEALS) {
        if (meal && name !== meal) continue;
        const dishes = rows(day?.[name])
          .filter((row) => String(row.item ?? "").trim())
          .map((row) => (row.category ? `${row.category}: ${String(row.item).trim()}` : String(row.item).trim()));
        if (dishes.length) menu[name] = dishes;
      }
      return { mess: entry.mess, menu };
    });
}

/**
 * Registrations as { date, weekday, meal, mess, status, price }, oldest first. status is registered,
 * cancelled or eaten; price is paise, present once the portal has charged the meal. Nothing else in
 * the tool set needs a registration's ID, user or timestamps, so they are dropped.
 */
export function compactRegistrations(registrations: unknown) {
  const order = (row: Row) => `${row.meal_date}${MEALS.indexOf(row.meal_type as (typeof MEALS)[number])}`;
  return rows(registrations)
    .sort((a, b) => order(a).localeCompare(order(b)))
    .map((row) => {
      const date = String(row.meal_date);
      const guests = rows((row.metadata as Row | undefined)?.guests).length;
      return {
        date,
        weekday: weekdayOf(date),
        meal: row.meal_type,
        mess: row.meal_mess,
        status: row.cancelled_at ? "cancelled" : row.availed_at ? "eaten" : "registered",
        ...(row.availed_price != null ? { price: row.availed_price } : {}),
        // "registered" is the ordinary category; anything else (we have only seen that one) is worth showing
        ...(row.category && row.category !== "registered" ? { category: row.category } : {}),
        ...(guests ? { guests } : {}),
        ...(row.monthly_reg != null ? { monthly: true } : {}),
      };
    });
}
