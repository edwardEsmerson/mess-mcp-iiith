// Tests the tools against a fake portal, in-process (no network, no ports): the tool list, merged
// and multi-meal tools, errors that teach, trimmed responses, empty reads, deadlines on a pinned clock
// and the size of the tool definitions. Runs the built dist/, so `npm test` builds first.
// All names, IDs and amounts below are made up.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { MessApiError } from "../dist/api/client.js";
import { connect } from "../scripts/lib/in-process.mjs";

// 2026-10-24 20:00 UTC is already Sunday 2026-10-25 in IST (01:30)
const SUNDAY_IN_IST = () => new Date("2026-10-24T20:00:00Z");

const MESSES = [
  { id: "yuktahar", name: "Yuktāhār", short_name: "Yuktāhār", color: "0.70 0.12 180", tags: 7, billing_id: 1, rating: 3.85, feedback_count: 26 },
  { id: "kadamba-veg", name: "Kadamba (Veg)", short_name: "Kadamba (V)", color: "0.70 0.194 149", tags: 7, billing_id: 5, rating: 2.72, feedback_count: 129 },
  { id: "kadamba-nonveg", name: "Kadamba (Non-Veg)", short_name: "Kadamba (NV)", color: "0.70 0.2 20", tags: 7, billing_id: 6, rating: 3.1, feedback_count: 80 },
  { id: "kadamba", name: "Kadamba", short_name: "Kadamba", color: "0.5 0.1 10", tags: 0, billing_id: 3, rating: 0, feedback_count: 0 },
  { id: "north", name: "North", short_name: "North", color: "0.65 0.22 16", tags: 0, billing_id: 2, rating: 0, feedback_count: 0 },
  { id: "bakul-veg", name: "Bakul (Veg)", short_name: "Bakul (V)", color: "0.6 0.1 90", tags: 7, billing_id: 8, rating: 0, feedback_count: 0 },
  { id: "bakul-nonveg", name: "Bakul (Non-Veg)", short_name: "Bakul (NV)", color: "0.6 0.1 95", tags: 7, billing_id: 9, rating: 0, feedback_count: 0 },
  { id: "lounge-veg", name: "Faculty/Staff Lounge (Veg)", short_name: "Lounge (V)", color: "0.70 0.15 90", tags: 2, billing_id: 7, rating: 0, feedback_count: 0 },
];

/** A stand-in for the portal: answers by "METHOD /path" and records every call. */
function fakePortal(handlers = {}) {
  const calls = [];
  const table = { "GET /mess/info": () => ({ data: MESSES }), ...handlers };
  const call = (method) => async (path, arg) => {
    calls.push({ method, path, arg });
    const handler = table[`${method} ${path}`];
    if (!handler) throw new MessApiError(`fake portal has no ${method} ${path}`, 404);
    return handler(arg);
  };
  return { get: call("GET"), post: call("POST"), put: call("PUT"), delete: call("DELETE"), calls };
}

async function withServer(portal, options, run) {
  const session = await connect(portal, options);
  try {
    return await run(session);
  } finally {
    await session.close();
  }
}

const text = (result) => result.content[0].text;
const json = (result) => JSON.parse(text(result));

const EXPECTED_TOOLS = [
  "cancel_meal",
  "create_monthly_registration",
  "delete_extra_registration",
  "delete_monthly_registration",
  "get_account",
  "get_bill",
  "get_deadlines",
  "get_extras",
  "get_meal_rating",
  "get_menu",
  "get_mess_info",
  "get_monthly_registration",
  "get_registrations",
  "register_extra",
  "reset_qr_token",
  "set_meal_mess",
  "skip_meal",
  "submit_feedback",
  "update_preferences",
];

test("tools/list: the merged set, annotations and compact schemas", () =>
  withServer(fakePortal(), {}, async (session) => {
    const tools = await session.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), EXPECTED_TOOLS);

    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.equal(byName.set_meal_mess.annotations.idempotentHint, true);
    assert.equal(byName.set_meal_mess.annotations.destructiveHint, false);
    assert.equal(byName.cancel_meal.annotations.destructiveHint, true);
    assert.equal(byName.get_deadlines.annotations.readOnlyHint, true);

    // Date format is explained in the instructions; the schema just says "date", with no regex
    const schemas = JSON.stringify(tools.map((t) => t.inputSchema));
    assert.doesNotMatch(schemas, /pattern|\$schema|9007199254740991/);
    assert.deepEqual(byName.get_registrations.inputSchema.properties.from, { type: "string", format: "date" });
    assert.equal(byName.set_meal_mess.inputSchema.properties.meals.items.properties.mess.description, undefined);

    // What misled models into cancelling a meal to change its mess is gone; the rule that remains is
    // in the tool description itself, which every client shows
    assert.match(byName.set_meal_mess.description, /call this again/);
    assert.doesNotMatch(byName.cancel_meal.description, /registration/i);
    assert.doesNotMatch(session.instructions, /register_meal|Never cancel|replaces the registration/);
    for (const name of ["set_meal_mess", "register_extra", "create_monthly_registration", "cancel_meal"]) {
      assert.match(byName[name].description, /confirm with the user/i, name);
    }
  }));

test("a date that doesn't exist is refused", () =>
  withServer(fakePortal(), {}, async (session) => {
    const attempt = await session.callTool("get_registrations", { from: "2026-02-30" }).then(
      (result) => (result.isError ? text(result) : "accepted"),
      (error) => error.message,
    );
    assert.match(attempt, /YYYY-MM-DD/);
  }));

test("set_meal_mess: one result per meal, and a failing meal doesn't hide the others", () => {
  const portal = fakePortal({
    "POST /registrations": (body) => {
      if (body.meal_date === "2026-10-30") throw new MessApiError("Registration for this date has closed.", 400);
      return {};
    },
  });
  return withServer(portal, { now: SUNDAY_IN_IST }, async (session) => {
    const result = await session.callTool("set_meal_mess", {
      meals: [
        { date: "2026-10-29", meal: "lunch", mess: "yuktahar" },
        { date: "2026-10-30", meal: "lunch", mess: "yuktahar" },
        { date: "2026-10-31", meal: "dinner", mess: "kadamba-veg", guests: 2 },
      ],
    });
    assert.notEqual(result.isError, true);
    assert.deepEqual(json(result), [
      { date: "2026-10-29", weekday: "thursday", meal: "lunch", mess: "yuktahar", ok: true },
      { date: "2026-10-30", weekday: "friday", meal: "lunch", mess: "yuktahar", ok: false, error: "Registration for this date has closed." },
      { date: "2026-10-31", weekday: "saturday", meal: "dinner", mess: "kadamba-veg", ok: true },
    ]);
    const posts = portal.calls.filter((c) => c.method === "POST");
    assert.deepEqual(posts[2].arg, { meal_date: "2026-10-31", meal_type: "dinner", meal_mess: "kadamba-veg", guests: 2 });
    assert.equal(portal.calls.filter((c) => c.path === "/mess/info").length, 1, "the mess list is fetched once per call, not per meal");
  });
});

test("set_meal_mess: when every meal fails the call is an error naming each one", () => {
  const portal = fakePortal({ "POST /registrations": () => Promise.reject(new MessApiError("Registration for this date has closed.", 400)) });
  return withServer(portal, {}, async (session) => {
    const result = await session.callTool("set_meal_mess", {
      meals: [
        { date: "2026-10-26", meal: "lunch", mess: "yuktahar" },
        { date: "2026-10-27", meal: "lunch", mess: "yuktahar" },
      ],
    });
    assert.equal(result.isError, true);
    assert.match(text(result), /2026-10-26 monday lunch: Registration for this date has closed\.\n2026-10-27 tuesday lunch: Registration/);
  });
});

test("set_meal_mess: losing the portal stops the batch instead of repeating the failure", () => {
  const portal = fakePortal({ "POST /registrations": () => Promise.reject(new MessApiError("Could not reach the mess portal", 0)) });
  return withServer(portal, {}, async (session) => {
    const result = await session.callTool("set_meal_mess", {
      meals: ["2026-10-26", "2026-10-27", "2026-10-28"].map((date) => ({ date, meal: "lunch", mess: "yuktahar" })),
    });
    assert.equal(result.isError, true);
    assert.equal(portal.calls.filter((c) => c.method === "POST").length, 1);
    assert.match(text(result), /Not attempted/);
  });
});

test("cancel_meal: undo restores, and the default cancels", () => {
  const portal = fakePortal({ "POST /registrations/cancel": () => ({}), "POST /registrations/uncancel": () => ({}) });
  return withServer(portal, {}, async (session) => {
    const cancelled = await session.callTool("cancel_meal", { meals: [{ date: "2026-10-30", meal: "dinner" }] });
    assert.deepEqual(json(cancelled), [{ date: "2026-10-30", weekday: "friday", meal: "dinner", ok: true }]);
    await session.callTool("cancel_meal", { meals: [{ date: "2026-10-30", meal: "dinner" }], undo: true });
    assert.deepEqual(
      portal.calls.map((c) => [c.path, c.arg]),
      [
        ["/registrations/cancel", { meal_date: "2026-10-30", meal_type: "dinner" }],
        ["/registrations/uncancel", { meal_date: "2026-10-30", meal_type: "dinner" }],
      ],
    );
  });
});

test("skip_meal: undo sends skipping false", () => {
  const portal = fakePortal({ "POST /registrations/skipping": () => ({}) });
  return withServer(portal, {}, async (session) => {
    const meals = [{ date: "2026-10-30", meal: "lunch", mess: "yuktahar" }];
    await session.callTool("skip_meal", { meals });
    await session.callTool("skip_meal", { meals, undo: true });
    const sent = portal.calls.filter((c) => c.method === "POST").map((c) => c.arg.skipping);
    assert.deepEqual(sent, [true, false]);
  });
});

test("a wrong mess fails with the valid IDs and writes nothing", () => {
  const portal = fakePortal({ "POST /registrations": () => ({}) });
  return withServer(portal, {}, async (session) => {
    const attempt = async (mess) => {
      const result = await session.callTool("set_meal_mess", { meals: [{ date: "2026-10-30", meal: "lunch", mess }] });
      assert.equal(result.isError, true, mess);
      return text(result);
    };

    // A real but retired ID: candidates are the messes in use that look like it
    const retired = await attempt("kadamba");
    assert.match(retired, /"kadamba" is not in use/);
    assert.match(retired, /kadamba-veg \(Kadamba \(Veg\)\)/);
    assert.match(retired, /kadamba-nonveg \(Kadamba \(Non-Veg\)\)/);
    assert.doesNotMatch(retired, /bakul|north/);

    // Right name, wrong spelling of the ID: not silently fixed
    assert.match(await attempt("Yuktahar"), /Did you mean: yuktahar \(Yuktāhār\)/);
    assert.match(await attempt("bakul"), /bakul-veg .*bakul-nonveg/);

    // Nothing close: list every mess in use, and none that isn't
    const nothing = await attempt("hostel");
    assert.match(nothing, /Messes in use: yuktahar .*kadamba-veg .*bakul-veg/);
    assert.doesNotMatch(nothing, /north|"kadamba"|kadamba \(Kadamba\)/);

    assert.equal(portal.calls.filter((c) => c.method === "POST").length, 0, "no write reached the portal");

    // The same check guards the other tools that take a mess
    const extra = await session.callTool("register_extra", { extra_id: "e1", date: "2026-10-30", meal: "lunch", mess: "kadamba" });
    assert.equal(extra.isError, true);
    assert.match(text(extra), /Did you mean: kadamba-veg/);
  });
});

test("reads with a mess filter only look the mess up when something goes wrong", () => {
  const portal = fakePortal({ "GET /registration/rating": () => ({ data: { average: 4, count: 3 } }) });
  return withServer(portal, {}, async (session) => {
    assert.deepEqual(json(await session.callTool("get_meal_rating", { meal: "lunch", mess: "yuktahar" })), { average: 4, count: 3 });
    assert.equal(portal.calls.filter((c) => c.path === "/mess/info").length, 0);
  });
});

test("an unknown mess rejected by the portal on a read is explained", () => {
  const portal = fakePortal({ "GET /registration/rating": () => Promise.reject(new MessApiError("invalid mess", 400)) });
  return withServer(portal, {}, async (session) => {
    const result = await session.callTool("get_meal_rating", { meal: "lunch", mess: "bakul" });
    assert.equal(result.isError, true);
    assert.match(text(result), /Did you mean: bakul-veg/);
    // A real mess the portal rejects for another reason keeps the portal's words
    const other = await session.callTool("get_meal_rating", { meal: "lunch", mess: "yuktahar" });
    assert.equal(text(other), "invalid mess");
  });
});

test("an empty reply: None. for a read, Done. for a write", () => {
  const portal = fakePortal({
    "GET /extras": () => ({}),
    "GET /registrations/extras": () => ({}),
    "GET /registrations/monthly": () => ({}),
    "POST /auth/reset-token": () => ({}),
  });
  return withServer(portal, { now: SUNDAY_IN_IST }, async (session) => {
    const extras = json(await session.callTool("get_extras", { meal: "lunch" }));
    assert.deepEqual(extras, { date: "2026-10-25", weekday: "sunday", meal: "lunch", on_offer: [], registered: [] });

    assert.equal(text(await session.callTool("get_monthly_registration", {})), "None.");
    assert.equal(text(await session.callTool("reset_qr_token", {})), "Done.");
  });
});

test("get_extras: what's on offer and what you registered, in one call", () => {
  const portal = fakePortal({
    "GET /extras": () => ({ data: [{ id: "x1", mess: "yuktahar", rate: 1500 }] }),
    "GET /registrations/extras": () => ({ data: [{ id: "r9", extra: "x1" }] }),
  });
  return withServer(portal, {}, async (session) => {
    const result = json(await session.callTool("get_extras", { meal: "dinner", date: "2026-10-30" }));
    assert.equal(result.weekday, "friday");
    assert.deepEqual(result.on_offer, [{ id: "x1", mess: "yuktahar", rate: 1500 }]);
    assert.deepEqual(result.registered, [{ id: "r9", extra: "x1" }]);
    assert.deepEqual(
      portal.calls.map((c) => c.arg),
      [{ meal: "dinner", date: "2026-10-30" }, { meal: "dinner", date: "2026-10-30" }],
    );
  });
});

test("get_account: profile and preferences together", () => {
  const portal = fakePortal({
    "GET /auth/me": () => ({ data: { name: "Test Student" } }),
    "GET /preferences": () => ({ data: { nag_for_feedback: true } }),
  });
  return withServer(portal, {}, async (session) => {
    assert.deepEqual(json(await session.callTool("get_account", {})), { profile: { name: "Test Student" }, preferences: { nag_for_feedback: true } });
  });
});

const dish = (item, category = "") => ({ item, category });
const MENUS = [
  {
    mess: "yuktahar",
    days: {
      sunday: {
        breakfast: [dish("Idli", "Tiffin")],
        lunch: [dish("Multigrain roti", "Phulka/Chapathi"), dish("", "Dal"), dish("Steamed rice")],
        snacks: [dish("", "")],
        dinner: [dish("", ""), dish("", "")],
      },
      monday: { lunch: [dish("Poori", "Bread")] },
    },
  },
  { mess: "kadamba-veg", days: { sunday: { lunch: [dish("Chapathi", "Bread"), dish("Dal fry", "Dal")], dinner: [dish("Fried rice", "Rice")] } } },
];

test("get_menu: one day, empty slots dropped, optionally one meal and mess", () => {
  const portal = fakePortal({ "GET /mess/menus": () => ({ data: MENUS }) });
  return withServer(portal, { now: SUNDAY_IN_IST }, async (session) => {
    const all = json(await session.callTool("get_menu", {}));
    assert.deepEqual(portal.calls[0].arg, { on: "2026-10-25" });
    assert.deepEqual(all, {
      date: "2026-10-25",
      weekday: "sunday",
      menus: [
        { mess: "yuktahar", menu: { breakfast: ["Tiffin: Idli"], lunch: ["Phulka/Chapathi: Multigrain roti", "Steamed rice"] } },
        { mess: "kadamba-veg", menu: { lunch: ["Bread: Chapathi", "Dal: Dal fry"], dinner: ["Rice: Fried rice"] } },
      ],
    });

    const filtered = json(await session.callTool("get_menu", { date: "2026-10-26", meal: "lunch" }));
    assert.deepEqual(filtered, { date: "2026-10-26", weekday: "monday", menus: [{ mess: "yuktahar", menu: { lunch: ["Bread: Poori"] } }, { mess: "kadamba-veg", menu: {} }] });

    const oneMess = json(await session.callTool("get_menu", { mess: "kadamba-veg", meal: "dinner" }));
    assert.deepEqual(oneMess.menus, [{ mess: "kadamba-veg", menu: { dinner: ["Rice: Fried rice"] } }]);
  });
});

test("get_menu: a mess that isn't one gets the list, a real one with no menu doesn't", () => {
  const portal = fakePortal({ "GET /mess/menus": () => ({ data: MENUS }) });
  return withServer(portal, {}, async (session) => {
    const wrong = await session.callTool("get_menu", { mess: "Kadamba" });
    assert.equal(wrong.isError, true);
    assert.match(text(wrong), /kadamba-veg/);
    assert.deepEqual(json(await session.callTool("get_menu", { mess: "bakul-veg" })).menus, []);
  });
});

const REGISTRATION = (over) => ({
  id: "01TESTREGISTRATION0000000000",
  category: "registered",
  meal_date: "2026-10-20",
  meal_type: "breakfast",
  meal_mess: "kadamba-veg",
  user_id: "test.student",
  registered_at: "2026-10-05T09:21:15.970067+05:30",
  cancelled_at: null,
  availed_at: null,
  availed_price: null,
  monthly_reg: null,
  metadata: { guests: [] },
  ...over,
});

test("get_registrations: trimmed to what a model needs, and today plus six days by default", () => {
  const portal = fakePortal({
    "GET /registrations": () => ({
      data: [
        REGISTRATION({ meal_date: "2026-10-26", meal_type: "dinner", meal_mess: "yuktahar" }),
        REGISTRATION({ meal_date: "2026-10-25", meal_type: "lunch", availed_at: "2026-10-25T13:22:52+05:30", availed_price: 15500 }),
        REGISTRATION({ meal_date: "2026-10-25", meal_type: "breakfast", cancelled_at: "2026-10-08T20:58:39+05:30" }),
        REGISTRATION({ meal_date: "2026-10-27", meal_type: "lunch", availed_price: 7200, metadata: { guests: [{}, {}] }, monthly_reg: { id: "m1" } }),
      ],
    }),
  });
  return withServer(portal, { now: SUNDAY_IN_IST }, async (session) => {
    const result = await session.callTool("get_registrations", {});
    assert.deepEqual(portal.calls[0].arg, { from: "2026-10-25", to: "2026-10-31" });
    assert.deepEqual(json(result), {
      from: "2026-10-25",
      to: "2026-10-31",
      registrations: [
        { date: "2026-10-25", weekday: "sunday", meal: "breakfast", mess: "kadamba-veg", status: "cancelled" },
        { date: "2026-10-25", weekday: "sunday", meal: "lunch", mess: "kadamba-veg", status: "eaten", price: 15500 },
        { date: "2026-10-26", weekday: "monday", meal: "dinner", mess: "yuktahar", status: "registered" },
        { date: "2026-10-27", weekday: "tuesday", meal: "lunch", mess: "kadamba-veg", status: "registered", price: 7200, guests: 2, monthly: true },
      ],
    });
    assert.doesNotMatch(text(result), /01TEST|test\.student|registered_at|9:21/);

    await session.callTool("get_registrations", { from: "2026-10-27" });
    assert.deepEqual(portal.calls[1].arg, { from: "2026-10-27", to: "2026-11-02" });
    await session.callTool("get_registrations", { from: "2026-10-01", to: "2026-10-31" });
    assert.deepEqual(portal.calls[2].arg, { from: "2026-10-01", to: "2026-10-31" });
  });
});

test("get_registrations: an empty range is an empty list, not Done.", () =>
  withServer(fakePortal({ "GET /registrations": () => ({}) }), { now: SUNDAY_IN_IST }, async (session) => {
    assert.deepEqual(json(await session.callTool("get_registrations", {})), { from: "2026-10-25", to: "2026-10-31", registrations: [] });
  }));

const TIMINGS = {
  yuktahar: [
    { meal: "breakfast", start_time: "06:30:00", end_time: "10:30:00" },
    { meal: "lunch", start_time: "11:30:00", end_time: "15:30:00" },
  ],
  "kadamba-nonveg": [{ meal: "lunch", start_time: "11:30:00", end_time: "15:30:00" }],
  "bakul-veg": [{ meal: "breakfast", start_time: "06:30:00", end_time: "10:30:00" }],
};

test("get_mess_info: messes in use with ratings and serving times, no UI fields", () => {
  const portal = fakePortal({ "GET /config/meal-timings": () => ({ data: TIMINGS }) });
  return withServer(portal, { now: SUNDAY_IN_IST }, async (session) => {
    const result = json(await session.callTool("get_mess_info", {}));
    assert.equal(result.date, "2026-10-25");
    assert.equal(result.weekday, "sunday");
    assert.deepEqual(
      result.messes.map((m) => m.id),
      ["yuktahar", "kadamba-veg", "kadamba-nonveg", "bakul-veg", "bakul-nonveg", "lounge-veg"],
    );
    assert.deepEqual(result.messes[0], { id: "yuktahar", name: "Yuktāhār", rating: 3.85, feedback_count: 26, timings: { breakfast: "06:30-10:30", lunch: "11:30-15:30" } });
    assert.deepEqual(result.messes[3], { id: "bakul-veg", name: "Bakul (Veg)", timings: { breakfast: "06:30-10:30" } }, "an unrated mess has no rating");
    assert.doesNotMatch(JSON.stringify(result), /color|billing_id|tags|short_name/);
  });
});

test("get_mess_info with a meal: only the messes serving it, with rates and seats", () => {
  const portal = fakePortal({
    "GET /config/meal-timings": () => ({ data: TIMINGS }),
    "GET /mess/rates": () => ({
      data: {
        registered: [
          { mess: "yuktahar", rate: 7200, day: null },
          { mess: "kadamba-nonveg", rate: 9000, day: null },
          { mess: "kadamba-nonveg", rate: 15500, day: "Sunday" },
          { mess: "kadamba-nonveg", rate: 11000, day: "Monday" },
        ],
        unregistered: [{ mess: "yuktahar", rate: 12400, day: null }],
      },
    }),
    "GET /mess/capacities": () => ({
      data: { guest: [], registered: [{ mess: "yuktahar", available: 176, capacity: 340 }], unregistered: [{ mess: "yuktahar", available: 30, capacity: 30 }] },
    }),
  });
  return withServer(portal, { now: SUNDAY_IN_IST }, async (session) => {
    const result = json(await session.callTool("get_mess_info", { meal: "lunch" }));
    assert.deepEqual(portal.calls.find((c) => c.path === "/mess/rates").arg, { meal: "lunch", on: "2026-10-25" });
    assert.equal(result.meal, "lunch");
    assert.deepEqual(result.messes, [
      {
        id: "yuktahar",
        name: "Yuktāhār",
        rating: 3.85,
        feedback_count: 26,
        time: "11:30-15:30",
        registered: { rate: 7200, available: 176, capacity: 340 },
        unregistered: { rate: 12400, available: 30, capacity: 30 },
      },
      { id: "kadamba-nonveg", name: "Kadamba (Non-Veg)", rating: 3.1, feedback_count: 80, time: "11:30-15:30", registered: { rate: 15500 } },
    ]);
  });
});

test("get_deadlines: dates follow the IST day, not the UTC one", async () => {
  const portal = fakePortal({
    // Real values seen on the portal: registering closes 4 days ahead, cancelling 2, extras 1
    "GET /config/registration-window": () => ({ data: 345600 }),
    "GET /config/cancellation-window": () => ({ data: 172800 }),
    "GET /config/extras-window": () => ({ data: 86400 }),
    "GET /config/registration-max-date": () => ({ data: "2026-12-31" }),
    "GET /config/max-cancellations": ({ meal }) => ({ data: meal === "snacks" ? 3 : 6 }),
    "GET /registrations/cancellations": ({ meal }) => ({ data: meal === "lunch" ? 5 : 0 }),
  });
  const deadlinesAt = (instant) => withServer(portal, { now: () => new Date(instant) }, async (session) => json(await session.callTool("get_deadlines", {})));

  // 20:00 UTC on the 24th is 01:30 on Sunday the 25th in IST
  const sunday = await deadlinesAt("2026-10-24T20:00:00Z");
  assert.deepEqual(sunday, {
    today: "2026-10-25",
    weekday: "sunday",
    set_meal_mess: { from: "2026-10-29", to: "2026-12-31" },
    cancel_meal: { from: "2026-10-27" },
    register_extra: { from: "2026-10-26" },
    skip_meal: { from: "2026-10-25" },
    cancellations: {
      breakfast: { used: 0, limit: 6 },
      lunch: { used: 5, limit: 6 },
      snacks: { used: 0, limit: 3 },
      dinner: { used: 0, limit: 6 },
    },
  });

  // The IST day ends at 18:30 UTC
  assert.equal((await deadlinesAt("2026-10-25T18:29:59Z")).today, "2026-10-25");
  const monday = await deadlinesAt("2026-10-25T18:30:00Z");
  assert.equal(monday.today, "2026-10-26");
  assert.equal(monday.weekday, "monday");
  assert.equal(monday.set_meal_mess.from, "2026-10-30");
  assert.equal(monday.skip_meal.from, "2026-10-26");

  // Across a month end
  assert.equal((await deadlinesAt("2026-10-30T19:00:00Z")).set_meal_mess.from, "2026-11-04");
});

test("get_deadlines: a meal type the portal has no cancellation figures for doesn't fail the rest", () => {
  const portal = fakePortal({
    "GET /config/registration-window": () => ({ data: 345600 }),
    "GET /config/cancellation-window": () => ({ data: 172800 }),
    "GET /config/extras-window": () => ({ data: 86400 }),
    "GET /config/registration-max-date": () => ({ data: "2026-12-31" }),
    "GET /config/max-cancellations": ({ meal }) => (meal === "snacks" ? Promise.reject(new MessApiError("no limit for snacks", 400)) : { data: 6 }),
    "GET /registrations/cancellations": () => ({ data: 1 }),
  });
  return withServer(portal, { now: SUNDAY_IN_IST }, async (session) => {
    const result = json(await session.callTool("get_deadlines", {}));
    assert.equal(result.cancellations.snacks, null);
    assert.deepEqual(result.cancellations.lunch, { used: 1, limit: 6 });
  });
});

// Tool definitions are paid for in every conversation, so growth should be a decision. If this
// fails because a tool was added or reworded on purpose, check `npm run count-tokens` and raise
// the budget in the same commit. The current size is about 10% under it.
const BUDGET_CHARS = 11_100;

test("tools/list plus the instructions stay within the size budget", () =>
  withServer(fakePortal(), {}, async (session) => {
    const size = JSON.stringify(await session.listTools()).length + session.instructions.length;
    assert.ok(size <= BUDGET_CHARS, `tools/list and instructions are ${size} characters, over the ${BUDGET_CHARS} budget`);
  }));
