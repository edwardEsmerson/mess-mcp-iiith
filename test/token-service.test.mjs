// Unit tests for TokenService on in-memory repositories: authorization codes, access token checks and
// revocation. The refresh token retry window has its own file (tokens.test.mjs); the end-to-end suite
// goes through /token over HTTP but can't wait out a lifetime.

import { strict as assert } from "node:assert";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { OAuthErrorCode } from "@modelcontextprotocol/server";
import { AesGcmBox, deriveKey, sha256 } from "../dist/auth/crypto.js";
import { GrantService } from "../dist/auth/grants.js";
import { ACCESS_TOKEN_PREFIX, DEFAULT_LIFETIMES, TokenService } from "../dist/auth/tokens.js";
import { manualClock } from "./support/fakes.mjs";
import { memoryRepositories } from "./support/memory-repos.mjs";

const CLIENT = "client-1";
const RESOURCE = "https://mess.example/mcp";
const REDIRECT = "http://127.0.0.1:7777/callback";

function setup(lifetimes = DEFAULT_LIFETIMES) {
  const repos = memoryRepositories();
  const clock = manualClock();
  const grants = new GrantService(repos.grants, new AesGcmBox(deriveKey(Buffer.alloc(32, 5), "test")), clock);
  const tokens = new TokenService(repos.codes, repos.tokens, repos.grants, clock, lifetimes);

  /** A signed-in user whose authorization code hasn't been redeemed yet. */
  function pendingSignIn() {
    const grant = grants.create({ clientId: CLIENT, resource: RESOURCE, scopes: [], diningKey: "a-dining-key" });
    const verifier = randomBytes(32).toString("base64url");
    const code = tokens.issueCode(grant, REDIRECT, createHash("sha256").update(verifier).digest("base64url"));
    const redeem = (overrides = {}) => tokens.exchangeCode({ code, clientId: CLIENT, redirectUri: REDIRECT, codeVerifier: verifier, resource: RESOURCE, ...overrides });
    return { grant, verifier, code, redeem };
  }

  const alive = (grant) => repos.grants.find(grant.id) !== undefined;
  return { repos, clock, grants, tokens, pendingSignIn, alive };
}

const error = (code) => (thrown) => thrown.code === code;
const invalidGrant = error(OAuthErrorCode.InvalidGrant);
const invalidToken = error(OAuthErrorCode.InvalidToken);

test("a redeemed code gives an access and a refresh token, stored only as hashes", () => {
  const { repos, pendingSignIn } = setup();
  const { code, redeem } = pendingSignIn();
  assert.match(code, /^mmcp_ac_/);

  const issued = redeem();

  assert.equal(issued.token_type, "Bearer");
  assert.equal(issued.expires_in, 3600);
  assert.equal(issued.scope, undefined, "no scopes are granted");
  assert.match(issued.access_token, /^mmcp_at_/);
  assert.match(issued.refresh_token, /^mmcp_rt_/);

  const stored = JSON.stringify([...repos.codes.codes.values(), ...repos.tokens.tokens.values(), ...repos.grants.grants.values()]);
  for (const secret of [code, issued.access_token, issued.refresh_token]) assert.ok(!stored.includes(secret), "a raw secret reached storage");
  assert.equal(repos.tokens.find(sha256(issued.access_token)).kind, "access");
  assert.equal(repos.tokens.find(sha256(issued.refresh_token)).kind, "refresh");
});

test("a code can be redeemed once", () => {
  const { pendingSignIn } = setup();
  const { redeem } = pendingSignIn();
  redeem();
  assert.throws(() => redeem(), invalidGrant);
});

test("a code nobody issued is refused", () => {
  const { tokens } = setup();
  assert.throws(() => tokens.exchangeCode({ code: "mmcp_ac_made-up", clientId: CLIENT, redirectUri: REDIRECT, codeVerifier: "v".repeat(43) }), invalidGrant);
});

test("a code lasts 5 minutes", () => {
  const { clock, pendingSignIn, alive } = setup();
  const justInTime = pendingSignIn();
  clock.advance(DEFAULT_LIFETIMES.codeMs);
  assert.ok(justInTime.redeem().access_token, "valid up to the last millisecond");

  const late = pendingSignIn();
  clock.advance(DEFAULT_LIFETIMES.codeMs + 1);
  assert.throws(() => late.redeem(), invalidGrant);
  assert.ok(alive(late.grant), "an expired code is just refused; there's nothing to suspect");
});

test("a code is bound to its PKCE verifier, client, redirect address and resource", () => {
  const wrong = {
    "verifier": { codeVerifier: randomBytes(32).toString("base64url") },
    "empty verifier": { codeVerifier: "" },
    "client": { clientId: "someone-else" },
    "redirect address": { redirectUri: "http://127.0.0.1:7777/other" },
    "redirect address with another port": { redirectUri: "http://127.0.0.1:9999/callback" },
    "resource": { resource: "https://other.example/mcp" },
  };
  for (const [what, overrides] of Object.entries(wrong)) {
    const { pendingSignIn, alive } = setup();
    const { grant, redeem } = pendingSignIn();
    assert.throws(() => redeem(overrides), invalidGrant, what);
    assert.equal(alive(grant), false, `${what}: a failed redemption may be a stolen code, so the grant ends`);
  }
});

test("a failed redemption uses up the code, so the right verifier can't follow", () => {
  const { pendingSignIn } = setup();
  const { redeem } = pendingSignIn();
  assert.throws(() => redeem({ codeVerifier: "wrong".repeat(10) }), invalidGrant);
  assert.throws(() => redeem(), invalidGrant);
});

test("the resource may be left out when redeeming, or written with a trailing slash", () => {
  const { pendingSignIn } = setup();
  assert.ok(pendingSignIn().redeem({ resource: undefined }).access_token);
  assert.ok(pendingSignIn().redeem({ resource: `${RESOURCE}/` }).access_token);
});

test("an access token identifies its grant, client and resource", async () => {
  const { clock, tokens, pendingSignIn } = setup();
  const { grant, redeem } = pendingSignIn();
  const issued = redeem();

  const info = await tokens.verifyAccessToken(issued.access_token);

  assert.equal(info.token, issued.access_token);
  assert.equal(info.clientId, CLIENT);
  assert.deepEqual(info.scopes, []);
  assert.equal(info.resource.href, RESOURCE);
  assert.equal(info.extra.grantId, grant.id);
  assert.equal(info.expiresAt, Math.floor((clock() + DEFAULT_LIFETIMES.accessMs) / 1000));
});

test("an access token lasts an hour", async () => {
  const { clock, tokens, pendingSignIn } = setup();
  const { access_token } = pendingSignIn().redeem();

  clock.advance(DEFAULT_LIFETIMES.accessMs);
  assert.ok(await tokens.verifyAccessToken(access_token), "valid up to the last millisecond");
  clock.advance(1);
  await assert.rejects(tokens.verifyAccessToken(access_token), invalidToken);
});

test("things that aren't a live access token are refused", async () => {
  const { tokens, pendingSignIn } = setup();
  const { access_token, refresh_token } = pendingSignIn().redeem();

  for (const [what, token] of Object.entries({
    "a refresh token": refresh_token,
    "an unknown token": `${ACCESS_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`,
    "a token without the prefix": access_token.slice(ACCESS_TOKEN_PREFIX.length),
    "an empty string": "",
    "a dining key": "a-dining-key",
  })) {
    await assert.rejects(tokens.verifyAccessToken(token), invalidToken, what);
  }
});

test("an access token can't be used to refresh", () => {
  const { tokens, pendingSignIn, alive } = setup();
  const { grant, redeem } = pendingSignIn();
  const { access_token } = redeem();
  assert.throws(() => tokens.refresh({ refreshToken: access_token, clientId: CLIENT }), invalidGrant);
  assert.ok(alive(grant));
});

test("refreshing hands out a new pair and keeps the grant", async () => {
  const { tokens, pendingSignIn } = setup();
  const { grant, redeem } = pendingSignIn();
  const first = redeem();

  const second = tokens.refresh({ refreshToken: first.refresh_token, clientId: CLIENT, resource: RESOURCE });

  assert.notEqual(second.access_token, first.access_token);
  assert.notEqual(second.refresh_token, first.refresh_token);
  assert.equal((await tokens.verifyAccessToken(second.access_token)).extra.grantId, grant.id);
  assert.ok(await tokens.verifyAccessToken(first.access_token), "the old access token simply runs out");
});

test("a refresh token lasts 60 days and is for its own client and resource", () => {
  const { clock, tokens, pendingSignIn, alive } = setup();
  const { grant, redeem } = pendingSignIn();
  const { refresh_token } = redeem();

  assert.throws(() => tokens.refresh({ refreshToken: refresh_token, clientId: "someone-else" }), invalidGrant);
  assert.throws(() => tokens.refresh({ refreshToken: refresh_token, clientId: CLIENT, resource: "https://other.example/mcp" }), error(OAuthErrorCode.InvalidTarget));
  assert.ok(alive(grant), "neither mistake ends the grant");

  clock.advance(DEFAULT_LIFETIMES.refreshMs);
  assert.ok(tokens.refresh({ refreshToken: refresh_token, clientId: CLIENT }).access_token, "valid up to the last millisecond");
  clock.advance(1);
  assert.throws(() => tokens.refresh({ refreshToken: refresh_token, clientId: CLIENT }), invalidGrant);
});

test("lifetimes can be changed", async () => {
  const { clock, tokens, pendingSignIn } = setup({ ...DEFAULT_LIFETIMES, accessMs: 10_000, codeMs: 1_000 });
  const late = pendingSignIn();
  clock.advance(1_001);
  assert.throws(() => late.redeem(), invalidGrant);

  const issued = pendingSignIn().redeem();
  assert.equal(issued.expires_in, 10);
  clock.advance(10_001);
  await assert.rejects(tokens.verifyAccessToken(issued.access_token), invalidToken);
});

test("revoking either token ends the grant and every token under it", async () => {
  for (const which of ["access_token", "refresh_token"]) {
    const { tokens, pendingSignIn, alive } = setup();
    const { grant, redeem } = pendingSignIn();
    const issued = redeem();
    const rotated = tokens.refresh({ refreshToken: issued.refresh_token, clientId: CLIENT });

    tokens.revoke(issued[which], CLIENT);

    assert.equal(alive(grant), false, which);
    await assert.rejects(tokens.verifyAccessToken(issued.access_token), invalidToken);
    await assert.rejects(tokens.verifyAccessToken(rotated.access_token), invalidToken, "including ones issued later");
    assert.throws(() => tokens.refresh({ refreshToken: rotated.refresh_token, clientId: CLIENT }), invalidGrant);
  }
});

test("only the client a token was issued to can revoke it", async () => {
  const { tokens, pendingSignIn, alive } = setup();
  const { grant, redeem } = pendingSignIn();
  const issued = redeem();

  tokens.revoke(issued.access_token, "someone-else");
  tokens.revoke(issued.refresh_token, "");
  assert.ok(alive(grant));
  assert.ok(await tokens.verifyAccessToken(issued.access_token));
});

test("revoking a token nobody issued is silently fine", () => {
  const { tokens, pendingSignIn, alive } = setup();
  const { grant } = pendingSignIn();
  tokens.revoke("mmcp_at_unknown", CLIENT);
  tokens.revoke("", CLIENT);
  assert.ok(alive(grant));
});

test("a revoked grant's pending code is no longer redeemable", () => {
  const { grants, pendingSignIn } = setup();
  const { grant, redeem } = pendingSignIn();
  grants.revoke(grant.id);
  assert.throws(() => redeem(), invalidGrant);
});
