// Unit tests for TokenService on an in-memory database with a clock the tests move by hand.
// The end-to-end suite covers the same flows over HTTP, but can't wait out the refresh grace window.

import { strict as assert } from "node:assert";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { OAuthErrorCode } from "@modelcontextprotocol/server";
import { AesGcmBox, deriveKey } from "../dist/auth/crypto.js";
import { GrantService } from "../dist/auth/grants.js";
import { openDatabase, SqliteCodeRepository, SqliteGrantRepository, SqliteTokenRepository } from "../dist/auth/sqlite.js";
import { DEFAULT_LIFETIMES, TokenService } from "../dist/auth/tokens.js";

const CLIENT = "client-1";
const RESOURCE = "https://mess.example/mcp";
const REDIRECT = "http://127.0.0.1:7777/callback";
const GRACE = DEFAULT_LIFETIMES.refreshReuseGraceMs;

function setup(lifetimes = DEFAULT_LIFETIMES) {
  let now = 1_700_000_000_000;
  const clock = () => now;
  const db = openDatabase(":memory:");
  const grantRepository = new SqliteGrantRepository(db);
  const grants = new GrantService(grantRepository, new AesGcmBox(deriveKey(Buffer.alloc(32, 7), "test")), clock);
  const tokens = new TokenService(new SqliteCodeRepository(db), new SqliteTokenRepository(db), grantRepository, clock, lifetimes);

  /** A user signing in: new grant, authorization code, code exchange. */
  function signIn() {
    const grant = grants.create({ clientId: CLIENT, resource: RESOURCE, scopes: [], diningKey: "a-dining-key" });
    const verifier = randomBytes(32).toString("base64url");
    const code = tokens.issueCode(grant, REDIRECT, createHash("sha256").update(verifier).digest("base64url"));
    const issued = tokens.exchangeCode({ code, clientId: CLIENT, redirectUri: REDIRECT, codeVerifier: verifier, resource: RESOURCE });
    return { grant, issued };
  }

  return {
    grants,
    tokens,
    signIn,
    advance: (ms) => void (now += ms),
    refresh: (refreshToken, clientId = CLIENT) => tokens.refresh({ refreshToken, clientId, resource: RESOURCE }),
    alive: (grant) => grants.diningKeyFor(grant.id) !== undefined,
  };
}

const invalidGrant = (error) => error.code === OAuthErrorCode.InvalidGrant;

test("a rotated refresh token still works inside the grace window", async () => {
  const { tokens, signIn, advance, refresh, alive } = setup();
  const { grant, issued: first } = signIn();

  const second = refresh(first.refresh_token);
  advance(10_000);
  const retried = refresh(first.refresh_token);

  assert.notEqual(retried.refresh_token, second.refresh_token, "the retry gets a fresh pair of its own");
  assert.notEqual(retried.access_token, second.access_token);
  assert.equal((await tokens.verifyAccessToken(retried.access_token)).extra.grantId, grant.id, "for the same grant");
  assert.ok(await tokens.verifyAccessToken(second.access_token), "the first rotation's pair stays valid");
  assert.ok(alive(grant));

  // Either pair can carry on from here
  assert.ok(refresh(second.refresh_token).refresh_token);
  assert.ok(refresh(retried.refresh_token).refresh_token);
  assert.ok(alive(grant));
});

test("the window covers the whole grace period and no more", () => {
  const { signIn, advance, refresh, alive } = setup();
  const { grant, issued } = signIn();
  refresh(issued.refresh_token);

  advance(GRACE);
  assert.ok(refresh(issued.refresh_token), "exactly at the end of the window");
  assert.ok(alive(grant));

  advance(1);
  assert.throws(() => refresh(issued.refresh_token), invalidGrant, "one millisecond later");
  assert.equal(alive(grant), false, "reuse after the window ends the grant");
});

test("reuse after the window revokes the grant and every token under it", async () => {
  const { tokens, signIn, advance, refresh, alive } = setup();
  const { grant, issued: first } = signIn();
  const second = refresh(first.refresh_token);

  advance(5 * 60_000);
  assert.throws(() => refresh(first.refresh_token), invalidGrant);

  assert.equal(alive(grant), false);
  await assert.rejects(tokens.verifyAccessToken(second.access_token), "the newer access token is dead");
  assert.throws(() => refresh(second.refresh_token), invalidGrant, "and so is the newer refresh token");
});

test("retrying doesn't extend the window", () => {
  const { signIn, advance, refresh, alive } = setup();
  const { grant, issued } = signIn();
  refresh(issued.refresh_token);

  advance(20_000);
  refresh(issued.refresh_token);
  advance(11_000);
  // 11s since the last retry, but 31s since the rotation
  assert.throws(() => refresh(issued.refresh_token), invalidGrant);
  assert.equal(alive(grant), false);
});

test("the window is configurable", () => {
  const { signIn, advance, refresh, alive } = setup({ ...DEFAULT_LIFETIMES, refreshReuseGraceMs: 0 });
  const { grant, issued } = signIn();
  refresh(issued.refresh_token);

  assert.ok(refresh(issued.refresh_token), "no time has passed, so a zero window still allows it");
  advance(1);
  assert.throws(() => refresh(issued.refresh_token), invalidGrant);
  assert.equal(alive(grant), false);
});

test("inside the window a refresh token is still bound to its client", () => {
  const { signIn, refresh, alive } = setup();
  const { grant, issued } = signIn();
  refresh(issued.refresh_token);

  assert.throws(() => refresh(issued.refresh_token, "someone-else"), invalidGrant);
  assert.ok(alive(grant), "a stranger presenting the token doesn't end the owner's grant");
});

test("a refresh token that expired while rotated is not revived by the window", () => {
  const { signIn, advance, refresh } = setup({ ...DEFAULT_LIFETIMES, refreshMs: 5_000 });
  const { issued } = signIn();
  refresh(issued.refresh_token);

  advance(6_000);
  assert.throws(() => refresh(issued.refresh_token), invalidGrant);
});
