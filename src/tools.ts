// Every tool, as a table of { input schema, annotations, API call }.
// Tools return the portal's JSON as-is (minus the { data } envelope); the model reads it directly.
// Units the model needs to know (paise, seconds) are stated in the descriptions.

import { z } from "zod";
import type { McpServer, ToolAnnotations } from "@modelcontextprotocol/server";
import type { MessApi } from "./api/client.js";
import { DESTRUCTIVE, READ_ONLY, WRITE, date, meal, messId, month, optionalDate, todayIST, weekdayOf, year } from "./lib/schemas.js";

interface Tool<S extends z.ZodRawShape> {
  title: string;
  description: string;
  annotations: ToolAnnotations;
  input?: S;
  run: (api: MessApi, args: z.infer<z.ZodObject<S>>) => Promise<unknown>;
}

// Identity helper so each entry's `run` gets typed args from its own `input`
const tool = <S extends z.ZodRawShape = {}>(def: Tool<S>) => def;

const tools = {
  // Account

  get_user_info: tool({
    title: "Get profile",
    description: "Your profile: name, email, roll number, last login.",
    annotations: READ_ONLY,
    run: (api) => api.get("/auth/me"),
  }),

  reset_qr_token: tool({
    title: "Reset QR token",
    description: "Reset the QR code token used to verify meals at the mess. The old QR code stops working.",
    annotations: DESTRUCTIVE,
    run: (api) => api.post("/auth/reset-token"),
  }),

  get_preferences: tool({
    title: "Get preferences",
    description: "Your notification and meal preferences.",
    annotations: READ_ONLY,
    run: (api) => api.get("/preferences"),
  }),

  update_preferences: tool({
    title: "Update preferences",
    description: "Change preferences. Only the fields you pass are changed.",
    annotations: { ...WRITE, idempotentHint: true },
    input: {
      notify_not_registered: z.boolean().optional().describe("Email a reminder before the registration deadline"),
      notify_malloc_happened: z.boolean().optional().describe("Email when randomly allocated to a meal"),
      auto_reset_token_daily: z.boolean().optional().describe("Reset the QR token daily"),
      enable_unregistered: z.boolean().optional().describe("Allow availing meals without registering"),
      nag_for_feedback: z.boolean().optional().describe("Prompt for feedback after meals"),
    },
    run: async (api, changes) => {
      // The API replaces the whole object, so merge onto the current one
      const current = unwrap(await api.get("/preferences")) as object;
      return api.put("/preferences", { ...current, ...changes });
    },
  }),

  // Messes and rules

  get_mess_info: tool({
    title: "List messes",
    description: "All messes with their IDs and whether they are open. Use these IDs wherever a mess ID is needed.",
    annotations: READ_ONLY,
    run: (api) => api.get("/mess/info"),
  }),

  get_menu: tool({
    title: "Get menu",
    description: "Menu at every mess for one day.",
    annotations: READ_ONLY,
    input: { date: optionalDate },
    run: async (api, { date }) => {
      // The API returns the whole week; keep only the requested day
      const on = date ?? todayIST();
      const menus = unwrap(await api.get("/mess/menus", { on })) as { mess: string; days?: Record<string, unknown> }[];
      const day = weekdayOf(on);
      return { date: on, day, menus: menus.map((m) => ({ mess: m.mess, menu: m.days?.[day] ?? null })) };
    },
  }),

  get_meal_rates: tool({
    title: "Get meal rates",
    description: "Price of a meal at each mess, by category (registered, unregistered, guest). Rates are in paise.",
    annotations: READ_ONLY,
    input: { meal, date: optionalDate },
    run: (api, { meal, date }) => api.get("/mess/rates", { meal, on: date }),
  }),

  get_meal_capacities: tool({
    title: "Get meal capacities",
    description: "Remaining and total capacity at each mess for a meal.",
    annotations: READ_ONLY,
    input: { meal, date: optionalDate },
    run: (api, { meal, date }) => api.get("/mess/capacities", { meal, on: date }),
  }),

  get_meal_timings: tool({
    title: "Get meal timings",
    description: "Serving times of each meal at each mess.",
    annotations: READ_ONLY,
    input: { date: optionalDate },
    run: (api, { date }) => api.get("/config/meal-timings", { on: date }),
  }),

  get_registration_window: tool({
    title: "Get registration window",
    description: "How long before a meal registration closes, in seconds.",
    annotations: READ_ONLY,
    run: (api) => api.get("/config/registration-window"),
  }),

  get_registration_max_date: tool({
    title: "Get last registrable date",
    description: "The furthest date meals can currently be registered for.",
    annotations: READ_ONLY,
    run: (api) => api.get("/config/registration-max-date"),
  }),

  get_cancellation_window: tool({
    title: "Get cancellation window",
    description: "How long before a meal cancellation closes, in seconds.",
    annotations: READ_ONLY,
    run: (api) => api.get("/config/cancellation-window"),
  }),

  get_max_cancellations: tool({
    title: "Get cancellation limit",
    description: "Maximum cancellations allowed per month for a meal.",
    annotations: READ_ONLY,
    input: { meal },
    run: (api, { meal }) => api.get("/config/max-cancellations", { meal }),
  }),

  // Registrations

  get_registrations: tool({
    title: "List registrations",
    description: "Your meal registrations in a date range (at most 2 months). A registration is cancelled if cancelled_at is set and eaten if availed_at is set.",
    annotations: READ_ONLY,
    input: { from: date, to: date },
    run: (api, { from, to }) => api.get("/registrations", { from, to }),
  }),

  get_registration: tool({
    title: "Get registration",
    description: "Your registration for one meal on a date, or for every meal that day if meal is omitted.",
    annotations: READ_ONLY,
    input: { meal: meal.optional(), date: optionalDate },
    run: (api, { meal, date }) => api.get("/registration", { meal, date }),
  }),

  register_meal: tool({
    title: "Register for a meal",
    description: "Register for a meal at a mess. The meal is charged to your bill.",
    annotations: WRITE,
    input: { meal_date: date, meal_type: meal, meal_mess: messId, guests: z.number().int().min(0).optional().describe("Number of guests") },
    run: (api, args) => api.post("/registrations", args),
  }),

  cancel_meal: tool({
    title: "Cancel a meal",
    description: "Cancel a meal registration. Uses up one of your limited monthly cancellations.",
    annotations: DESTRUCTIVE,
    input: { meal_date: date, meal_type: meal },
    run: (api, args) => api.post("/registrations/cancel", args),
  }),

  uncancel_meal: tool({
    title: "Uncancel a meal",
    description: "Restore a cancelled meal registration.",
    annotations: WRITE,
    input: { meal_date: date, meal_type: meal },
    run: (api, args) => api.post("/registrations/uncancel", args),
  }),

  skip_meal: tool({
    title: "Skip a meal",
    description: "Mark a registered meal as skipped, or unmark it. Unlike cancelling, you are still charged.",
    annotations: { ...WRITE, idempotentHint: true },
    input: { meal_date: date, meal_type: meal, meal_mess: messId, skipping: z.boolean().default(true).describe("False to unskip") },
    run: (api, args) => api.post("/registrations/skipping", args),
  }),

  get_cancellation_count: tool({
    title: "Get cancellations used",
    description: "How many cancellations you've used for a meal in a month. Defaults to the current month.",
    annotations: READ_ONLY,
    input: { meal, month: month.optional(), year: year.optional() },
    run: (api, args) => api.get("/registrations/cancellations", args),
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
    description: "Register at one mess for a whole month.",
    annotations: WRITE,
    input: { month, year, mess: messId },
    run: (api, args) => api.post("/registrations/monthly", args),
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
    description: "Extra items on offer for a meal, with IDs, mess and rate in paise. Availability and IDs vary by date and mess.",
    annotations: READ_ONLY,
    input: { meal, date: optionalDate },
    run: (api, { meal, date }) => api.get("/extras", { meal, date }),
  }),

  get_extra_registrations: tool({
    title: "List your extras",
    description: "Extra items you've registered for a meal, with registration IDs (needed to delete them).",
    annotations: READ_ONLY,
    input: { meal, date: optionalDate },
    run: (api, { meal, date }) => api.get("/registrations/extras", { meal, date }),
  }),

  register_extra: tool({
    title: "Register an extra item",
    description: "Register for an extra item. It is charged to your bill.",
    annotations: WRITE,
    input: {
      extra_id: z.string().min(1).describe("Item ID from get_extras for the same date and meal"),
      meal_date: date,
      meal_type: meal,
      meal_mess: messId.describe("Mess offering this extra on that date"),
    },
    run: (api, { extra_id, ...rest }) => api.post("/registrations/extras", { extra: extra_id, ...rest }),
  }),

  delete_extra_registration: tool({
    title: "Delete an extra registration",
    description: "Delete an extra item registration.",
    annotations: DESTRUCTIVE,
    input: { registration_id: z.string().min(1).describe("Registration ID from get_extra_registrations") },
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
      meal_date: date,
      meal_type: meal,
      rating: z.number().int().min(1).max(5).describe("Rating, 1-5"),
      remarks: z.string().optional().describe("Comments"),
    },
    run: (api, args) => api.post("/registrations/feedback", args),
  }),

  get_meal_rating: tool({
    title: "Get meal ratings",
    description: "Average rating and rating count for a meal, for one mess or all messes.",
    annotations: READ_ONLY,
    input: { meal, date: optionalDate, mess: messId.optional() },
    run: (api, args) => api.get("/registration/rating", args),
  }),
};

// The portal wraps most responses as { data: ... }
function unwrap(response: unknown): unknown {
  return response && typeof response === "object" && "data" in response ? response.data : response;
}

export function registerTools(server: McpServer, api: MessApi) {
  for (const [name, def] of Object.entries(tools) as [string, Tool<z.ZodRawShape>][]) {
    server.registerTool(
      name,
      { title: def.title, description: def.description, inputSchema: z.object(def.input ?? {}), annotations: def.annotations },
      async (args) => {
        const result = unwrap(await def.run(api, args));
        // Write endpoints often reply 204 No Content
        const empty = result === undefined || (typeof result === "object" && result !== null && Object.keys(result).length === 0);
        return { content: [{ type: "text" as const, text: empty ? "Done." : JSON.stringify(result) }] };
      },
    );
  }
}
