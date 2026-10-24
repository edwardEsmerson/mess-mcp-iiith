// Every tool, as a table of { input schema, annotations, API call }.
// Tools return the portal's JSON (minus the { data } envelope) unless it is too big or confusing for
// a model, in which case the tool trims it. Units the model needs to know (paise, seconds) are stated
// in the descriptions.

import { z } from "zod";
import type { McpServer, ToolAnnotations } from "@modelcontextprotocol/server";
import { unwrap, type MessApi, type Params } from "./api/client.js";
import { MAX_MEALS_PER_CALL, eachMeal } from "./lib/batch.js";
import { explainMessOnRejection, messInfo, requireMesses } from "./lib/messes.js";
import { compactRegistrations, dayMenus } from "./lib/reshape.js";
import { DESTRUCTIVE, MEALS, READ_ONLY, WRITE, addDays, compactJsonSchema, date, meal, messId, month, optionalDate, todayIST, weekdayOf, year } from "./lib/schemas.js";

/** What tools get besides the portal: a clock, so tests can pin "now". */
export interface Context {
  now: () => Date;
}

interface Tool<S extends z.ZodRawShape> {
  title: string;
  description: string;
  annotations: ToolAnnotations;
  input?: S;
  run: (api: MessApi, args: z.infer<z.ZodObject<S>>, context: Context) => Promise<unknown>;
}

// Identity helper so each entry's `run` gets typed args from its own `input`
const tool = <S extends z.ZodRawShape = {}>(def: Tool<S>) => def;

const guests = z.number().int().min(0).optional();
const mealList = <T extends z.ZodType>(item: T) => z.array(item).min(1).max(MAX_MEALS_PER_CALL);

// The portal answers an empty list with an empty 204, which the client turns into {}
const asList = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0 ? [] : value);

const tools = {
  // Account

  get_account: tool({
    title: "Get account",
    description: "Your profile (name, email, roll number, last login) and preferences.",
    annotations: READ_ONLY,
    run: async (api) => {
      const [profile, preferences] = await Promise.all([api.get("/auth/me"), api.get("/preferences")]);
      return { profile: unwrap(profile), preferences: unwrap(preferences) };
    },
  }),

  update_preferences: tool({
    title: "Update preferences",
    description: "Change preferences (see get_account). Only the fields you pass change.",
    annotations: { ...WRITE, idempotentHint: true },
    input: {
      notify_not_registered: z.boolean().optional().describe("Email a reminder before the deadline"),
      notify_malloc_happened: z.boolean().optional().describe("Email when allocated a meal"),
      auto_reset_token_daily: z.boolean().optional().describe("Reset the QR token daily"),
      enable_unregistered: z.boolean().optional().describe("Allow eating without registering"),
      nag_for_feedback: z.boolean().optional().describe("Prompt for feedback after meals"),
    },
    run: async (api, changes) => {
      // The API replaces the whole object, so merge onto the current one
      const current = unwrap(await api.get("/preferences")) as object;
      return api.put("/preferences", { ...current, ...changes });
    },
  }),

  reset_qr_token: tool({
    title: "Reset QR token",
    description: "Reset the QR code token used to verify meals at the mess. The old QR code stops working.",
    annotations: DESTRUCTIVE,
    run: (api) => api.post("/auth/reset-token"),
  }),

  // Messes and rules

  get_mess_info: tool({
    title: "List messes",
    description:
      "Messes in use, with their IDs, ratings and serving times. With a meal, only the messes serving it, with that meal's rate in paise and seats left for each category (registered, unregistered).",
    annotations: READ_ONLY,
    input: { meal: meal.optional(), date: optionalDate },
    run: (api, { meal, date }, { now }) => {
      const on = date ?? todayIST(now());
      return messInfo(api, on, weekdayOf(on), meal);
    },
  }),

  get_menu: tool({
    title: "Get menu",
    description: "Menu for one day at every mess, or just one meal and/or mess.",
    annotations: READ_ONLY,
    input: { date: optionalDate, meal: meal.optional(), mess: messId.optional() },
    run: async (api, { date, meal, mess }, { now }) => {
      const on = date ?? todayIST(now());
      const weekday = weekdayOf(on);
      // The API returns the whole week; keep only the requested day
      const menus = dayMenus(unwrap(await api.get("/mess/menus", { on })), weekday, meal, mess);
      // No menu for the mess asked for: say so if it isn't a mess at all
      if (mess && menus.length === 0) await requireMesses(api, [mess]);
      return { date: on, weekday, menus };
    },
  }),

  get_deadlines: tool({
    title: "Get deadlines",
    description:
      "Today (IST), the first meal date each tool can still be used for (set_meal_mess also has a last date), and the cancellations used and allowed this month per meal type. Worked out from the portal's windows the way dining.iiit.ac.in does; the portal has the final say.",
    annotations: READ_ONLY,
    run: async (api, _args, { now }) => {
      const get = async (path: string, params?: Params) => unwrap(await api.get(path, params));
      const [registration, cancellation, extras, lastDate] = await Promise.all(
        ["/config/registration-window", "/config/cancellation-window", "/config/extras-window", "/config/registration-max-date"].map((path) => get(path)),
      );
      const cancellations = await Promise.all(
        MEALS.map((meal) =>
          Promise.all([get("/registrations/cancellations", { meal }), get("/config/max-cancellations", { meal })])
            .then(([used, limit]) => ({ used, limit }))
            .catch(() => null),
        ),
      );
      const today = todayIST(now());
      // Windows are in seconds, but the portal compares whole dates
      const after = (seconds: unknown) => addDays(today, Math.floor(Number(seconds) / 86400));
      return {
        today,
        weekday: weekdayOf(today),
        set_meal_mess: { from: after(registration), to: lastDate },
        cancel_meal: { from: after(cancellation) },
        register_extra: { from: after(extras) },
        skip_meal: { from: today },
        cancellations: Object.fromEntries(MEALS.map((meal, i) => [meal, cancellations[i]])),
      };
    },
  }),

  // Meals

  get_registrations: tool({
    title: "List registrations",
    description:
      "Your meals from `from` to `to` (at most 2 months). Without dates: today and the next 6 days. status is registered, cancelled or eaten; price is in paise, once charged.",
    annotations: READ_ONLY,
    input: { from: optionalDate, to: optionalDate },
    run: async (api, args, { now }) => {
      const from = args.from ?? todayIST(now());
      const to = args.to ?? addDays(from, 6);
      return { from, to, registrations: compactRegistrations(unwrap(await api.get("/registrations", { from, to }))) };
    },
  }),

  set_meal_mess: tool({
    title: "Set a meal's mess",
    description:
      "Choose which mess you eat each listed meal at. To change a meal's mess, call this again with the new one. The meals are charged to your bill: confirm with the user first. Returns a result per meal.",
    annotations: { ...WRITE, idempotentHint: true },
    input: { meals: mealList(z.object({ date, meal, mess: messId, guests })) },
    run: async (api, { meals }) => {
      await requireMesses(api, meals.map((m) => m.mess));
      return eachMeal(meals, (m) => api.post("/registrations", { meal_date: m.date, meal_type: m.meal, meal_mess: m.mess, guests: m.guests }));
    },
  }),

  cancel_meal: tool({
    title: "Cancel meals",
    description:
      "Opt out of the listed meals: you aren't charged, and each uses one of your monthly cancellations, so confirm with the user first. With undo, opt back in. Returns a result per meal.",
    annotations: DESTRUCTIVE,
    input: { meals: mealList(z.object({ date, meal })), undo: z.boolean().optional() },
    run: (api, { meals, undo }) => eachMeal(meals, (m) => api.post(undo ? "/registrations/uncancel" : "/registrations/cancel", { meal_date: m.date, meal_type: m.meal })),
  }),

  skip_meal: tool({
    title: "Skip meals",
    description: "Say you won't come to the listed meals. You are still charged and no cancellation is used. With undo, take it back. Returns a result per meal.",
    annotations: { ...WRITE, idempotentHint: true },
    input: { meals: mealList(z.object({ date, meal, mess: messId })), undo: z.boolean().optional() },
    run: async (api, { meals, undo }) => {
      await requireMesses(api, meals.map((m) => m.mess));
      return eachMeal(meals, (m) => api.post("/registrations/skipping", { meal_date: m.date, meal_type: m.meal, meal_mess: m.mess, skipping: !undo }));
    },
  }),

  get_monthly_registration: tool({
    title: "Get monthly registration",
    description: "Your monthly mess registration. Defaults to the current month.",
    annotations: READ_ONLY,
    input: { month: month.optional(), year: year.optional() },
    run: (api, args) => api.get("/registrations/monthly", args),
  }),

  create_monthly_registration: tool({
    title: "Register for a month",
    description: "Register at one mess for a whole month. It is charged to your bill: confirm with the user first.",
    annotations: WRITE,
    input: { month, year, mess: messId },
    run: async (api, args) => {
      await requireMesses(api, [args.mess]);
      return api.post("/registrations/monthly", args);
    },
  }),

  delete_monthly_registration: tool({
    title: "Delete monthly registration",
    description: "Delete your monthly registration for a month.",
    annotations: DESTRUCTIVE,
    input: { month, year },
    run: (api, args) => api.delete("/registrations/monthly", args),
  }),

  // Extras

  get_extras: tool({
    title: "List extra items",
    description:
      "Extra items on offer for a meal (with IDs, mess and rate in paise; they vary by date and mess), and the extras you have registered (with the registration IDs needed to delete them).",
    annotations: READ_ONLY,
    input: { meal, date: optionalDate },
    run: async (api, { meal, date }, { now }) => {
      const on = date ?? todayIST(now());
      const [offered, registered] = await Promise.all([api.get("/extras", { meal, date: on }), api.get("/registrations/extras", { meal, date: on })]);
      return { date: on, weekday: weekdayOf(on), meal, on_offer: asList(unwrap(offered)), registered: asList(unwrap(registered)) };
    },
  }),

  register_extra: tool({
    title: "Register an extra item",
    description: "Register for an extra item from get_extras (same date and meal). It is charged to your bill: confirm with the user first.",
    annotations: WRITE,
    input: {
      extra_id: z.string().describe("ID from get_extras"),
      date,
      meal,
      mess: messId,
    },
    run: async (api, { extra_id, date, meal, mess }) => {
      await requireMesses(api, [mess]);
      return api.post("/registrations/extras", { extra: extra_id, meal_date: date, meal_type: meal, meal_mess: mess });
    },
  }),

  delete_extra_registration: tool({
    title: "Delete an extra registration",
    description: "Delete an extra you registered.",
    annotations: DESTRUCTIVE,
    input: { registration_id: z.string().describe("Registration ID from the registered list in get_extras") },
    run: (api, { registration_id }) => api.delete("/registrations/extras", { id: registration_id }),
  }),

  // Bills and feedback

  get_bill: tool({
    title: "Get bill",
    description: "Your mess bill for a month in paise: non_projected is already availed, projected is upcoming. Defaults to the current month.",
    annotations: READ_ONLY,
    input: { month: month.optional(), year: year.optional() },
    run: (api, args) => api.get("/registrations/bill", args),
  }),

  submit_feedback: tool({
    title: "Submit meal feedback",
    description: "Submit anonymous feedback for a meal you've eaten.",
    annotations: WRITE,
    input: {
      date,
      meal,
      rating: z.number().int().min(1).max(5),
      remarks: z.string().optional(),
    },
    run: (api, { date, meal, rating, remarks }) => api.post("/registrations/feedback", { meal_date: date, meal_type: meal, rating, remarks }),
  }),

  get_meal_rating: tool({
    title: "Get meal ratings",
    description: "Average rating and rating count for a meal, for one mess or all messes.",
    annotations: READ_ONLY,
    input: { meal, date: optionalDate, mess: messId.optional() },
    run: (api, args) => explainMessOnRejection(api, args.mess, () => api.get("/registration/rating", args)),
  }),
};

/** Told about each tool call once it finishes, with what it threw if it failed (used for metrics). */
export type ToolCallObserver = (tool: string, durationMs: number, error?: unknown) => void;

export function registerTools(server: McpServer, api: MessApi, onCall?: ToolCallObserver, context: Context = { now: () => new Date() }) {
  for (const [name, def] of Object.entries(tools) as [string, Tool<z.ZodRawShape>][]) {
    server.registerTool(
      name,
      { title: def.title, description: def.description, inputSchema: compactJsonSchema(z.object(def.input ?? {})), annotations: def.annotations },
      async (args) => {
        const started = performance.now();
        try {
          const result = unwrap(await def.run(api, args, context));
          onCall?.(name, performance.now() - started);
          // Write endpoints often reply 204 No Content ("Done."). A read that finds nothing says so
          // instead, since "Done." would read as success to a model that asked a question.
          const empty = result == null || (typeof result === "object" && Object.keys(result).length === 0);
          const text = empty ? (def.annotations.readOnlyHint ? "None." : "Done.") : JSON.stringify(result);
          return { content: [{ type: "text" as const, text }] };
        } catch (error) {
          onCall?.(name, performance.now() - started, error);
          throw error;
        }
      },
    );
  }
}
