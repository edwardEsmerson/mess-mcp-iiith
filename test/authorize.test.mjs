// Unit tests for the sign-in flow (auth/authorize.ts): request validation, the signed pending request that
// carries the validated parameters from GET to POST, and what each outcome of the POST does. The router
// runs in this process with in-memory repositories, a fake portal check and a clock the tests move by
// hand, which is what lets them cover expiry. The end-to-end suite goes through the real server.

import { strict as assert } from "node:assert";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import express from "express";
import { authorizeRouter } from "../dist/auth/authorize.js";
import { CompositeClientResolver, MetadataDocumentClientResolver, RegisteredClientResolver } from "../dist/auth/clients.js";
import { AesGcmBox, deriveKey, HmacSigner } from "../dist/auth/crypto.js";
import { GrantService } from "../dist/auth/grants.js";
import { TokenService } from "../dist/auth/tokens.js";
import { fakeFetcher, manualClock, serve } from "./support/fakes.mjs";
import { memoryRepositories } from "./support/memory-repos.mjs";

const MASTER = Buffer.alloc(32, 3);
const ISSUER = "https://mess.example";
const RESOURCE = `${ISSUER}/mcp`;
const CLIENT = "client-1";
const REDIRECT = "https://app.example/callback";
const GOOD_KEY = "good-key";
const FORM = { "content-type": "application/x-www-form-urlencoded" };
const PENDING_LIFETIME_MS = 15 * 60 * 1000;

const signerFor = (master) => new HmacSigner(deriveKey(master, "authorize-request"));

/** The authorize router wired to in-memory parts, served on a loopback port for the length of the test. */
async function setup(t, { documents = {}, clients = [{ clientId: CLIENT, clientName: "Test App", redirectUris: [REDIRECT] }] } = {}) {
  const repos = memoryRepositories();
  for (const client of clients) repos.clients.save(client);
  const clock = manualClock();
  const grants = new GrantService(repos.grants, new AesGcmBox(deriveKey(MASTER, "dining-keys")), clock);
  const tokens = new TokenService(repos.codes, repos.tokens, repos.grants, clock);

  const checked = [];
  const events = [];
  const keyValidator = {
    async check(key) {
      checked.push(key);
      if (key === "portal-down") throw new Error("portal unreachable");
      return key === GOOD_KEY ? "valid" : "rejected";
    },
  };

  const app = express();
  app.use(
    authorizeRouter({
      issuer: ISSUER,
      resource: RESOURCE,
      clients: new CompositeClientResolver([new MetadataDocumentClientResolver(fakeFetcher(documents), undefined, undefined, clock), new RegisteredClientResolver(repos.clients)]),
      grants,
      tokens,
      keyValidator,
      signer: signerFor(MASTER),
      clock,
      events: { signIn: (outcome) => events.push(outcome) },
    }),
  );
  const server = await serve(app);
  t.after(server.close);

  /** Opens the sign-in page the way an app sends the user to it. */
  async function open(params = {}) {
    const verifier = randomBytes(32).toString("base64url");
    const query = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT,
      redirect_uri: REDIRECT,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      state: "xyz",
      resource: RESOURCE,
      ...params,
    });
    for (const [key, value] of Object.entries(params)) if (value === undefined) query.delete(key);
    const res = await fetch(`${server.url}/authorize?${query}`, { redirect: "manual" });
    const html = await res.text();
    return { res, html, text: pageText(html), verifier, request: /name="request" value="([^"]+)"/.exec(html)?.[1] };
  }

  const submit = async (fields) => {
    const res = await fetch(`${server.url}/authorize`, { method: "POST", headers: FORM, body: new URLSearchParams(fields), redirect: "manual" });
    const html = await res.text();
    return { res, html, text: pageText(html), location: res.headers.get("location") ? new URL(res.headers.get("location")) : undefined };
  };

  return { repos, clock, grants, tokens, checked, events, open, submit, url: server.url };
}

/** What a reader sees on a page: no style, tags or entities. */
const pageText = (html) =>
  html
    .replace(/<style>.*?<\/style>/gs, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

const decodePending = (request) => JSON.parse(Buffer.from(request.split(".")[0], "base64url").toString("utf8"));
const forge = (pending, signer) => {
  const payload = Buffer.from(JSON.stringify(pending)).toString("base64url");
  return `${payload}.${signer.sign(payload)}`;
};

test("an unknown client gets an error page, not a redirect", async (t) => {
  const { open } = await setup(t);
  for (const client_id of ["nobody", "https://unreachable.example/client.json", undefined]) {
    const { res, text } = await open({ client_id });
    assert.equal(res.status, 400, String(client_id));
    assert.equal(res.headers.get("location"), null);
    assert.match(text, /isn't recognised/);
  }
});

test("a redirect address the client didn't register gets an error page, not a redirect", async (t) => {
  const { open } = await setup(t);
  for (const redirect_uri of ["https://evil.example/callback", `${REDIRECT}/`, "https://app.example/callback?x=1", "javascript:alert(1)"]) {
    const { res, text } = await open({ redirect_uri });
    assert.equal(res.status, 400, redirect_uri);
    assert.equal(res.headers.get("location"), null, "the code mustn't be sent anywhere for an unregistered address");
    assert.match(text, /unregistered redirect address/);
  }
});

test("a client with one redirect address may leave it out; with several it must choose", async (t) => {
  const { open } = await setup(t, {
    clients: [
      { clientId: "one", redirectUris: [REDIRECT] },
      { clientId: "two", redirectUris: [REDIRECT, "https://app.example/other"] },
    ],
  });
  assert.equal((await open({ client_id: "one", redirect_uri: undefined })).res.status, 200);
  assert.equal((await open({ client_id: "two", redirect_uri: undefined })).res.status, 400);
  assert.equal((await open({ client_id: "two", redirect_uri: "https://app.example/other" })).res.status, 200);
});

test("other mistakes in the request go back to the client as OAuth errors", async (t) => {
  const { open, events } = await setup(t);
  const cases = [
    [{ response_type: "token" }, "unsupported_response_type"],
    [{ response_type: undefined }, "unsupported_response_type"],
    [{ code_challenge: undefined }, "invalid_request"],
    [{ code_challenge_method: "plain" }, "invalid_request"],
    [{ code_challenge_method: undefined }, "invalid_request"],
    [{ resource: "https://other.example/mcp" }, "invalid_target"],
  ];
  for (const [params, error] of cases) {
    const { res } = await open(params);
    assert.equal(res.status, 302, JSON.stringify(params));
    const back = new URL(res.headers.get("location"));
    assert.equal(back.origin + back.pathname, REDIRECT);
    assert.equal(back.searchParams.get("error"), error, JSON.stringify(params));
    assert.equal(back.searchParams.get("state"), "xyz", "the client's state comes back");
    assert.equal(back.searchParams.get("iss"), ISSUER, "with the issuer, so the client can tell who answered");
    assert.equal(back.searchParams.get("code"), null);
  }
  assert.deepEqual(events, [], "none of these reached the sign-in page");
});

test("the resource may be written with a trailing slash or left out", async (t) => {
  const { open } = await setup(t);
  assert.equal((await open({ resource: `${RESOURCE}/` })).res.status, 200);
  assert.equal((await open({ resource: undefined })).res.status, 200);
});

test("repeated parameters are ignored rather than picking one", async (t) => {
  const { url } = await setup(t);
  const res = await fetch(`${url}/authorize?client_id=${CLIENT}&client_id=other&response_type=code`, { redirect: "manual" });
  assert.equal(res.status, 400);
});

test("the sign-in page is served with a signed request, and nothing may frame or cache it", async (t) => {
  const { open, clock } = await setup(t);
  const { res, text, request } = await open();

  assert.equal(res.status, 200);
  assert.ok(request, "the form carries the signed request");
  assert.match(res.headers.get("content-security-policy"), /form-action 'self' https:\/\/app\.example;/, "the redirect target is allowed to receive the post-submit redirect");
  assert.match(res.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.match(text, /Test App/);

  const pending = decodePending(request);
  assert.equal(pending.clientId, CLIENT);
  assert.equal(pending.redirectUri, REDIRECT);
  assert.equal(pending.state, "xyz");
  assert.equal(pending.expiresAt, clock() + PENDING_LIFETIME_MS);
  assert.ok(!request.includes(GOOD_KEY));
});

test("a signed request that was altered is refused, whatever part was changed", async (t) => {
  const { open, submit, checked, events, repos } = await setup(t);
  const { request } = await open();
  const [payload, signature] = request.split(".");

  const evil = Buffer.from(JSON.stringify({ ...decodePending(request), redirectUri: "https://evil.example/steal" })).toString("base64url");
  const flip = (text) => (text[0] === "A" ? "B" : "A") + text.slice(1);
  const tampered = {
    "payload edited, signature kept": `${evil}.${signature}`,
    "payload character changed": `${flip(payload)}.${signature}`,
    "signature character changed": `${payload}.${flip(signature)}`,
    "signature removed": payload,
    "signature empty": `${payload}.`,
    "payload removed": `.${signature}`,
    "signature of another payload": `${payload}.${signerFor(MASTER).sign("something else")}`,
    "not a signed request": "hello",
    "empty": "",
  };
  for (const [what, forged] of Object.entries(tampered)) {
    const { res, text, location } = await submit({ request: forged, dining_key: GOOD_KEY, action: "approve" });
    assert.equal(res.status, 400, what);
    assert.equal(location, undefined, `${what}: no redirect`);
    assert.match(text, /expired/, what);
  }
  assert.equal((await submit({ dining_key: GOOD_KEY, action: "approve" })).res.status, 400, "no request at all");

  assert.deepEqual(checked, [], "the pasted key was never even checked");
  assert.deepEqual(events, []);
  assert.equal(repos.grants.grants.size, 0, "and no grant was made");
});

test("a request signed with another secret is refused, even if its contents are valid", async (t) => {
  const { submit, clock, repos } = await setup(t);
  const pending = { clientId: CLIENT, redirectUri: "https://evil.example/steal", codeChallenge: "x", state: "s", expiresAt: clock() + PENDING_LIFETIME_MS };

  const { res } = await submit({ request: forge(pending, signerFor(Buffer.alloc(32, 9))), dining_key: GOOD_KEY, action: "approve" });
  assert.equal(res.status, 400);
  assert.equal(repos.grants.grants.size, 0);

  // The same contents signed with the server's own secret would be accepted: it's the signature that matters
  const accepted = await submit({ request: forge(pending, signerFor(MASTER)), dining_key: GOOD_KEY, action: "approve" });
  assert.equal(accepted.res.status, 302);
});

test("the signed request is good for 15 minutes", async (t) => {
  const { open, submit, clock, checked } = await setup(t);
  const { request } = await open();

  clock.advance(PENDING_LIFETIME_MS);
  const lastMoment = await submit({ request, dining_key: "wrong-key", action: "approve" });
  assert.equal(lastMoment.res.status, 400);
  assert.match(lastMoment.text, /accept that key/, "still the sign-in page, not the expiry page");

  clock.advance(1);
  const late = await submit({ request, dining_key: GOOD_KEY, action: "approve" });
  assert.equal(late.res.status, 400);
  assert.match(late.text, /This page has expired/);
  assert.equal(late.location, undefined);
  assert.deepEqual(checked, ["wrong-key"], "an expired page doesn't check the key");
});

test("an expired page can't be cancelled back to the app either", async (t) => {
  const { open, submit, clock, events } = await setup(t);
  const { request } = await open();
  clock.advance(PENDING_LIFETIME_MS + 1);
  const { res, location } = await submit({ request, action: "deny" });
  assert.equal(res.status, 400);
  assert.equal(location, undefined);
  assert.deepEqual(events, []);
});

test("approving with a good key redirects back with a code that can be redeemed once", async (t) => {
  const { open, submit, tokens, grants, repos, events, checked } = await setup(t);
  const { request, verifier } = await open();

  const { res, location } = await submit({ request, dining_key: GOOD_KEY, action: "approve" });

  assert.equal(res.status, 302);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(location.origin + location.pathname, REDIRECT);
  assert.equal(location.searchParams.get("state"), "xyz");
  assert.equal(location.searchParams.get("iss"), ISSUER);
  assert.equal(location.searchParams.get("error"), null);
  assert.deepEqual(checked, [GOOD_KEY]);
  assert.deepEqual(events, ["connected"]);

  const [grant] = repos.grants.grants.values();
  assert.equal(grant.clientId, CLIENT);
  assert.equal(grant.resource, RESOURCE);
  assert.equal(grants.diningKeyFor(grant.id), GOOD_KEY, "the key is kept for the app's tokens");
  assert.ok(!grant.sealedKey.includes(GOOD_KEY));

  const code = location.searchParams.get("code");
  const issued = tokens.exchangeCode({ code, clientId: CLIENT, redirectUri: REDIRECT, codeVerifier: verifier, resource: RESOURCE });
  assert.equal((await tokens.verifyAccessToken(issued.access_token)).extra.grantId, grant.id);
});

test("the pasted key is trimmed before it is checked and stored", async (t) => {
  const { open, submit, checked, repos, grants } = await setup(t);
  const { request } = await open();
  const { res } = await submit({ request, dining_key: `  ${GOOD_KEY}\n`, action: "approve" });
  assert.equal(res.status, 302);
  assert.deepEqual(checked, [GOOD_KEY]);
  assert.equal(grants.diningKeyFor([...repos.grants.grants.keys()][0]), GOOD_KEY);
});

test("a key the portal refuses shows the page again, with nothing stored, and can be retried", async (t) => {
  const { open, submit, events, repos } = await setup(t);
  const { request } = await open();

  const refused = await submit({ request, dining_key: "bad-key", action: "approve" });
  assert.equal(refused.res.status, 400);
  assert.match(refused.text, /didn't accept that key/);
  assert.match(refused.html, /name="request"/, "the form is there to try again");
  assert.equal(refused.location, undefined);
  assert.deepEqual(events, ["rejected_key"]);
  assert.equal(repos.grants.grants.size, 0);
  assert.equal(repos.codes.codes.size, 0);

  const retry = await submit({ request: /name="request" value="([^"]+)"/.exec(refused.html)[1], dining_key: GOOD_KEY, action: "approve" });
  assert.equal(retry.res.status, 302);
  assert.deepEqual(events, ["rejected_key", "connected"]);
});

test("a portal that can't be reached isn't blamed on the key", async (t) => {
  const { open, submit, events, repos } = await setup(t);
  const { request } = await open();

  const { res, text, location } = await submit({ request, dining_key: "portal-down", action: "approve" });
  assert.equal(res.status, 400);
  assert.match(text, /Couldn't reach the mess portal/);
  assert.doesNotMatch(text, /didn't accept/);
  assert.equal(location, undefined);
  assert.deepEqual(events, ["portal_unreachable"]);
  assert.equal(repos.grants.grants.size, 0);
});

test("an empty key asks for one without bothering the portal", async (t) => {
  const { open, submit, checked, events } = await setup(t);
  const { request } = await open();
  for (const dining_key of ["", "   ", undefined]) {
    const { res, text } = await submit({ request, ...(dining_key === undefined ? {} : { dining_key }), action: "approve" });
    assert.equal(res.status, 400);
    assert.match(text, /Paste your dining auth key/);
  }
  assert.deepEqual(checked, []);
  assert.deepEqual(events, []);
});

test("cancelling goes back to the app with access_denied and stores nothing", async (t) => {
  const { open, submit, events, checked, repos } = await setup(t);
  const { request } = await open();

  const { res, location } = await submit({ request, dining_key: GOOD_KEY, action: "deny" });
  assert.equal(res.status, 302);
  assert.equal(location.origin + location.pathname, REDIRECT);
  assert.equal(location.searchParams.get("error"), "access_denied");
  assert.equal(location.searchParams.get("state"), "xyz");
  assert.equal(location.searchParams.get("iss"), ISSUER);
  assert.equal(location.searchParams.get("code"), null);
  assert.deepEqual(events, ["cancelled"]);
  assert.deepEqual(checked, [], "a key typed before cancelling is never sent anywhere");
  assert.equal(repos.grants.grants.size, 0);
});

test("anything but an explicit approval counts as cancelling", async (t) => {
  const { open, submit } = await setup(t);
  const { request } = await open();
  for (const action of [undefined, "", "APPROVE", "approve "]) {
    const { res, location } = await submit({ request, dining_key: GOOD_KEY, ...(action === undefined ? {} : { action }) });
    assert.equal(res.status, 302, String(action));
    assert.equal(location.searchParams.get("error"), "access_denied", String(action));
  }
});

test("a client's state is optional, and only what it sent comes back", async (t) => {
  const { open, submit } = await setup(t);
  const { request } = await open({ state: undefined });
  const { location } = await submit({ request, dining_key: GOOD_KEY, action: "approve" });
  assert.ok(location.searchParams.get("code"));
  assert.equal(location.searchParams.has("state"), false);

  const odd = await open({ state: "a&b=c d#e" });
  const back = (await submit({ request: odd.request, dining_key: GOOD_KEY, action: "approve" })).location;
  assert.equal(back.searchParams.get("state"), "a&b=c d#e", "survives URL encoding");
  assert.equal(back.hash, "");
});

test("a client identified by a metadata document signs in like any other", async (t) => {
  const id = "https://app.example/oauth/client.json";
  const { open, submit } = await setup(t, {
    clients: [],
    documents: { [id]: { client_id: id, client_name: "Document App", redirect_uris: [REDIRECT] } },
  });
  const { res, text, request } = await open({ client_id: id });
  assert.equal(res.status, 200);
  assert.match(text, /Document App/);

  const { location } = await submit({ request, dining_key: GOOD_KEY, action: "approve" });
  assert.ok(location.searchParams.get("code"));
});
