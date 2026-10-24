// Unit tests for RevokeOnUnauthorized: when a portal 401 ends the OAuth grant and when it doesn't.
// The rule is that one 401 proves nothing; only a refused /auth/me (the call that accepted the key at
// sign-in) does. The end-to-end suite covers the same through a mock portal over HTTP.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { MessApiError } from "../dist/api/client.js";
import { RevokeOnUnauthorized } from "../dist/auth/revoke-on-unauthorized.js";
import { fakeApi } from "./support/fakes.mjs";

const unauthorized = (message = "The mess portal rejected the API key") => new MessApiError(message, 401);

/**
 * A portal client wrapped in the decorator. `answers` maps an endpoint to what it should do: an Error
 * is thrown, anything else is returned. Endpoints not listed succeed.
 */
function setup({ answers = {} } = {}) {
  let revoked = 0;
  const api = fakeApi((_method, endpoint) => {
    const answer = answers[endpoint];
    if (answer instanceof Error) throw answer;
    return answer ?? { data: endpoint };
  });
  const guarded = new RevokeOnUnauthorized(api, () => void revoked++);
  return { api, guarded, revoked: () => revoked, asked: () => api.calls.map((call) => call.endpoint) };
}

const rejectedWith = (matcher) => (error) => {
  assert.ok(error instanceof MessApiError, "a MessApiError");
  assert.match(error.message, matcher);
  return true;
};

test("successful calls pass straight through", async () => {
  const { guarded, revoked, asked } = setup();
  assert.deepEqual(await guarded.get("/mess/info"), { data: "/mess/info" });
  assert.equal(revoked(), 0);
  assert.deepEqual(asked(), ["/mess/info"]);
});

test("every method passes its arguments to the portal", async () => {
  const { api, guarded } = setup();
  await guarded.get("/a", { date: "2026-01-01" });
  await guarded.post("/b", { meal: "lunch" });
  await guarded.put("/c", { vegetarian: true });
  await guarded.delete("/d", { id: 5 });
  assert.deepEqual(api.calls, [
    { method: "GET", endpoint: "/a", argument: { date: "2026-01-01" } },
    { method: "POST", endpoint: "/b", argument: { meal: "lunch" } },
    { method: "PUT", endpoint: "/c", argument: { vegetarian: true } },
    { method: "DELETE", endpoint: "/d", argument: { id: 5 } },
  ]);
});

test("every method rechecks the key after a 401", async () => {
  for (const method of ["get", "post", "put", "delete"]) {
    const { guarded, revoked, asked } = setup({ answers: { "/x": unauthorized(), "/auth/me": unauthorized() } });
    await assert.rejects(guarded[method]("/x"), rejectedWith(/Reconnect/), method);
    assert.equal(revoked(), 1, method);
    assert.deepEqual(asked(), ["/x", "/auth/me"], method);
  }
});

test("a 401 the key survives is passed on as it was, and the grant stays", async () => {
  const stray = unauthorized("Please login to view this page.");
  const { guarded, revoked, asked } = setup({ answers: { "/mess/info": stray } });

  await assert.rejects(guarded.get("/mess/info"), (error) => error === stray, "the very same error, not a rewritten one");
  assert.equal(revoked(), 0);
  assert.deepEqual(asked(), ["/mess/info", "/auth/me"], "the key was checked once");
});

test("a 401 confirmed by /auth/me ends the grant and tells the user to reconnect", async () => {
  const { guarded, revoked } = setup({ answers: { "/mess/info": unauthorized("rejected"), "/auth/me": unauthorized() } });

  await assert.rejects(guarded.get("/mess/info"), (error) => {
    assert.ok(error instanceof MessApiError);
    assert.equal(error.status, 401);
    assert.match(error.message, /^rejected Reconnect this app to sign in with a new key\.$/);
    return true;
  });
  assert.equal(revoked(), 1);
});

test("when the failing call is /auth/me itself, it isn't asked again", async () => {
  const { guarded, revoked, asked } = setup({ answers: { "/auth/me": unauthorized() } });
  await assert.rejects(guarded.get("/auth/me"), rejectedWith(/Reconnect/));
  assert.equal(revoked(), 1);
  assert.deepEqual(asked(), ["/auth/me"]);
});

test("a recheck that fails for any reason but a 401 leaves the grant alone", async () => {
  const failures = [
    new MessApiError("Could not reach the mess portal", 0),
    new MessApiError("Mess portal returned 500", 500),
    new MessApiError("Mess portal returned 503", 503),
    new MessApiError("forbidden", 403),
    new TypeError("fetch failed"),
  ];
  for (const failure of failures) {
    const stray = unauthorized();
    const { guarded, revoked } = setup({ answers: { "/mess/info": stray, "/auth/me": failure } });
    await assert.rejects(guarded.get("/mess/info"), (error) => error === stray, failure.message);
    assert.equal(revoked(), 0, failure.message);
  }
});

test("errors other than 401 are passed on without any recheck", async () => {
  const failures = [
    new MessApiError("Mess portal returned 500", 500),
    new MessApiError("forbidden", 403),
    new MessApiError("Could not reach the mess portal", 0),
    new Error("something else"),
  ];
  for (const failure of failures) {
    const { guarded, revoked, asked } = setup({ answers: { "/mess/info": failure } });
    await assert.rejects(guarded.get("/mess/info"), (error) => error === failure, failure.message);
    assert.equal(revoked(), 0);
    assert.deepEqual(asked(), ["/mess/info"], `${failure.message}: no /auth/me call`);
  }
});

test("a non-401 failure of /auth/me itself doesn't revoke", async () => {
  const down = new MessApiError("Mess portal returned 500", 500);
  const { guarded, revoked } = setup({ answers: { "/auth/me": down } });
  await assert.rejects(guarded.get("/auth/me"), (error) => error === down);
  assert.equal(revoked(), 0);
});

test("a tool that fans out to several endpoints rechecks and revokes once", async () => {
  const endpoints = ["/config/registration-window", "/config/cancellation-window", "/config/extras-window", "/config/registration-max-date"];
  const { guarded, revoked, asked } = setup({
    answers: { ...Object.fromEntries(endpoints.map((e) => [e, unauthorized()])), "/auth/me": unauthorized() },
  });

  const results = await Promise.allSettled(endpoints.map((endpoint) => guarded.get(endpoint)));

  for (const result of results) {
    assert.equal(result.status, "rejected");
    assert.match(result.reason.message, /Reconnect/);
  }
  assert.equal(asked().filter((endpoint) => endpoint === "/auth/me").length, 1);
  assert.equal(revoked(), 1);
});

test("one answer from the recheck covers the rest of this request", async () => {
  const first = unauthorized("first");
  const second = unauthorized("second");
  const { guarded, revoked, asked } = setup({ answers: { "/a": first, "/b": second } });

  await assert.rejects(guarded.get("/a"), (error) => error === first);
  await assert.rejects(guarded.get("/b"), (error) => error === second, "the key was fine a moment ago, so it still is");
  assert.equal(asked().filter((endpoint) => endpoint === "/auth/me").length, 1);
  assert.equal(revoked(), 0);
});

test("each decorator rechecks for itself", async () => {
  // The server wraps the portal client anew for every MCP request, so a later request checks again
  const stray = unauthorized();
  const api = fakeApi((_method, endpoint) => {
    if (endpoint === "/mess/info") throw stray;
    return {};
  });
  let revoked = 0;
  for (let request = 0; request < 3; request++) {
    await assert.rejects(new RevokeOnUnauthorized(api, () => void revoked++).get("/mess/info"));
  }
  assert.equal(api.calls.filter((call) => call.endpoint === "/auth/me").length, 3);
  assert.equal(revoked, 0);
});
