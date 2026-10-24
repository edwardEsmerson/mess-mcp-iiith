// The portal's list of messes: which ones are in use, errors that tell a model which IDs are valid,
// and the combined view get_mess_info returns (rating, serving times, and for a meal rates and seats).

import { MessApiError, unwrap, type MessApi } from "../api/client.js";

interface Mess {
  id: string;
  name: string;
  rating?: number;
  feedback_count?: number;
  tags?: number;
}

// `tags` is undocumented. From the live list it looks like a bitfield: students' messes have 7, the
// faculty lounge 2, and retired ones (north, south, the bare "kadamba") 0. We only rely on 0 meaning
// "nobody can use this mess". Confirm against the portal before leaning on more than that.
const inUse = (mess: Mess) => mess.tags !== 0;

async function listMesses(api: MessApi): Promise<Mess[]> {
  const messes = unwrap(await api.get("/mess/info"));
  return Array.isArray(messes) ? (messes as Mess[]) : [];
}

// "Yuktāhār", "yuktahar" and "Yuktahar " all compare equal
const squash = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/** The error for the first ID that is not a mess in use, listing the valid ones; undefined if all are fine. */
function unknownMess(messes: Mess[], ids: string[]): Error | undefined {
  const open = messes.filter(inUse);
  // If the portal gave us no list there is nothing to judge by; let the portal decide
  if (open.length === 0) return undefined;
  const id = ids.find((candidate) => !open.some((mess) => mess.id === candidate));
  if (id === undefined) return undefined;

  const key = squash(id);
  const near = key ? open.filter((mess) => [mess.id, mess.name].some((text) => squash(text) && (squash(text).includes(key) || key.includes(squash(text))))) : [];
  const describe = (list: Mess[]) => list.map((mess) => `${mess.id} (${mess.name})`).join(", ");
  const problem = messes.some((mess) => mess.id === id) ? `Mess "${id}" is not in use.` : `Unknown mess "${id}".`;
  // Never pick one for the caller: a write must go to the mess the user meant
  return new Error(`${problem} ${near.length ? "Did you mean" : "Messes in use"}: ${describe(near.length ? near : open)}. Pass the exact ID.`);
}

/** Throws, listing the valid IDs, unless every ID is a mess in use. Costs one portal call. */
export async function requireMesses(api: MessApi, ids: string[]): Promise<void> {
  const problem = unknownMess(await listMesses(api), ids);
  if (problem) throw problem;
}

/**
 * Runs a call that filters by mess without checking it first. Only if the portal rejects the call
 * and the mess is not one in use do we fetch the list and explain; otherwise the portal's error stands.
 */
export async function explainMessOnRejection<T>(api: MessApi, mess: string | undefined, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (mess && error instanceof MessApiError && error.status >= 400 && error.status < 500 && error.status !== 401) {
      const problem = unknownMess(await listMesses(api).catch(() => []), [mess]);
      if (problem) throw problem;
    }
    throw error;
  }
}

type Row = Record<string, unknown>;
const rows = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : []);
const clock = (time: unknown) => String(time).replace(/^(\d\d:\d\d):\d\d$/, "$1");
const span = (timing: Row) => `${clock(timing.start_time)}-${clock(timing.end_time)}`;

/**
 * Messes in use with their rating and serving times. With a meal, only the messes serving it, with
 * the time, rate (paise) and seats for each category (registered, unregistered, ...).
 */
export async function messInfo(api: MessApi, on: string, weekday: string, meal?: string) {
  const [messes, timings, rates, capacities] = await Promise.all([
    listMesses(api),
    api.get("/config/meal-timings", { on }).then(unwrap),
    meal ? api.get("/mess/rates", { meal, on }).then(unwrap) : undefined,
    meal ? api.get("/mess/capacities", { meal, on }).then(unwrap) : undefined,
  ]);

  // mess -> category -> { rate, available, capacity }
  const byMess = new Map<string, Record<string, Record<string, unknown>>>();
  const entry = (mess: unknown, category: string) => {
    const categories = byMess.get(String(mess)) ?? {};
    byMess.set(String(mess), categories);
    return (categories[category] ??= {});
  };
  for (const [category, list] of Object.entries((rates ?? {}) as Record<string, unknown>)) {
    // A rate with a weekday applies on that weekday only and wins over the all-days rate (day: null)
    for (const row of [...rows(list)].sort((a, b) => Number(a.day != null) - Number(b.day != null))) {
      if (row.day == null || String(row.day).toLowerCase() === weekday) entry(row.mess, category).rate = row.rate;
    }
  }
  for (const [category, list] of Object.entries((capacities ?? {}) as Record<string, unknown>)) {
    for (const row of rows(list)) Object.assign(entry(row.mess, category), { available: row.available, capacity: row.capacity });
  }

  const serving = (id: string) => rows((timings as Record<string, unknown> | undefined)?.[id]);
  const list = messes
    .filter(inUse)
    .filter((mess) => !meal || byMess.has(mess.id))
    .map((mess) => ({
      id: mess.id,
      name: mess.name,
      // Unrated messes report a rating of 0, which is not a rating
      ...(mess.feedback_count ? { rating: mess.rating, feedback_count: mess.feedback_count } : {}),
      ...(meal
        ? { time: serving(mess.id).filter((t) => t.meal === meal).map(span)[0], ...byMess.get(mess.id) }
        : { timings: Object.fromEntries(serving(mess.id).map((t) => [t.meal, span(t)])) }),
    }));
  return { date: on, weekday, ...(meal ? { meal } : {}), messes: list };
}
