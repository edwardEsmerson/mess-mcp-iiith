// Unit tests for GrantService (where dining keys are sealed and unsealed) and PortalKeyValidator,
// on in-memory repositories and a fake portal client.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { MessApiError } from "../dist/api/client.js";
import { AesGcmBox, deriveKey } from "../dist/auth/crypto.js";
import { GrantService, PortalKeyValidator } from "../dist/auth/grants.js";
import { fakeApi, manualClock } from "./support/fakes.mjs";
import { memoryRepositories } from "./support/memory-repos.mjs";

const MASTER = Buffer.alloc(32, 1);
const RESOURCE = "https://mess.example/mcp";
const KEY = "dining-key-0123456789";

const boxFor = (master) => new AesGcmBox(deriveKey(master, "dining-keys"));

function setup() {
  const { grants: repository } = memoryRepositories();
  const clock = manualClock();
  const grants = new GrantService(repository, boxFor(MASTER), clock);
  const create = (diningKey = KEY, clientId = "client-1") => grants.create({ clientId, resource: RESOURCE, scopes: ["mess"], diningKey });
  return { repository, clock, grants, create };
}

test("a created grant records who it is for and when, and is stored", () => {
  const { repository, clock, create } = setup();
  clock.advance(1234);
  const grant = create();

  assert.ok(grant.id);
  assert.equal(grant.clientId, "client-1");
  assert.equal(grant.resource, RESOURCE);
  assert.deepEqual(grant.scopes, ["mess"]);
  assert.equal(grant.createdAt, clock());
  assert.deepEqual(repository.find(grant.id), grant);
  assert.notEqual(create().id, grant.id, "every grant gets its own id");
});

test("the dining key is stored sealed and comes back unsealed", () => {
  const { repository, grants, create } = setup();
  const grant = create();

  assert.ok(!grant.sealedKey.includes(KEY), "the plaintext key isn't in the grant");
  assert.ok(!JSON.stringify([...repository.grants.values()]).includes(KEY), "or anywhere in the repository");
  assert.equal(grants.diningKeyFor(grant.id), KEY);
});

test("sealing the same key twice gives different ciphertexts", () => {
  const { create } = setup();
  const [a, b] = [create(), create()];
  assert.notEqual(a.sealedKey, b.sealedKey);
});

test("keys with unusual characters survive sealing", () => {
  const { grants, create } = setup();
  for (const key of ["a", "k".repeat(500), "dots.in.the.key", "ünïcode \u{1F511} key", "line\nbreak"]) {
    assert.equal(grants.diningKeyFor(create(key).id), key);
  }
});

test("an unknown grant has no key", () => {
  const { grants } = setup();
  assert.equal(grants.diningKeyFor("no-such-grant"), undefined);
});

test("revoking a grant removes its key, and only that grant's", () => {
  const { grants, create } = setup();
  const [mine, theirs] = [create(KEY), create("someone-elses-key", "client-2")];

  grants.revoke(mine.id);

  assert.equal(grants.diningKeyFor(mine.id), undefined);
  assert.equal(grants.diningKeyFor(theirs.id), "someone-elses-key");
});

test("revoking an unknown or already revoked grant is harmless", () => {
  const { grants, create } = setup();
  const grant = create();
  grants.revoke("no-such-grant");
  grants.revoke(grant.id);
  grants.revoke(grant.id);
  assert.equal(grants.diningKeyFor(grant.id), undefined);
});

test("a key sealed under one secret can't be unsealed under another", () => {
  const { repository, create } = setup();
  const grant = create();

  const otherServer = new GrantService(repository, boxFor(Buffer.alloc(32, 2)), manualClock());
  assert.throws(() => otherServer.diningKeyFor(grant.id), "an authentication failure, not garbage text");

  const sameSecretOtherPurpose = new GrantService(repository, new AesGcmBox(deriveKey(MASTER, "authorize-request")), manualClock());
  assert.throws(() => sameSecretOtherPurpose.diningKeyFor(grant.id), "keys derived for other purposes don't open it either");

  const restarted = new GrantService(repository, boxFor(MASTER), manualClock());
  assert.equal(restarted.diningKeyFor(grant.id), KEY, "the same secret opens it after a restart");
});

test("a sealed key that was altered in storage is refused", () => {
  const { repository, grants, create } = setup();
  const grant = create();

  const [version, iv, tag, ciphertext] = grant.sealedKey.split(".");
  const flipped = Buffer.from(ciphertext, "base64url");
  flipped[0] ^= 1;
  const tampered = {
    "ciphertext bit flipped": [version, iv, tag, flipped.toString("base64url")].join("."),
    "tag removed": [version, iv, "", ciphertext].join("."),
    "unknown version": ["v2", iv, tag, ciphertext].join("."),
    "truncated": version,
    "not sealed at all": KEY,
  };
  for (const [what, sealedKey] of Object.entries(tampered)) {
    repository.save({ ...grant, sealedKey });
    assert.throws(() => grants.diningKeyFor(grant.id), what);
  }
});

test("PortalKeyValidator accepts a key the portal answers for, asking /auth/me with that key", async () => {
  const keys = [];
  const api = fakeApi(() => ({ data: { name: "Test Student" } }));
  const validator = new PortalKeyValidator((key) => (keys.push(key), api));

  assert.equal(await validator.check("some-key"), "valid");
  assert.deepEqual(keys, ["some-key"]);
  assert.deepEqual(api.calls, [{ method: "GET", endpoint: "/auth/me", argument: undefined }]);
});

test("PortalKeyValidator rejects a key the portal refuses with 401 or 403", async () => {
  for (const status of [401, 403]) {
    const validator = new PortalKeyValidator(() =>
      fakeApi(() => {
        throw new MessApiError("The mess portal rejected the API key", status);
      }),
    );
    assert.equal(await validator.check("bad-key"), "rejected", String(status));
  }
});

test("PortalKeyValidator says nothing about the key when the portal can't be asked", async () => {
  const failures = [
    new MessApiError("Could not reach the mess portal", 0),
    new MessApiError("Mess portal returned 500", 500),
    new MessApiError("Mess portal returned 404", 404),
    new MessApiError("Mess portal returned 429", 429),
    new TypeError("fetch failed"),
  ];
  for (const failure of failures) {
    const validator = new PortalKeyValidator(() =>
      fakeApi(() => {
        throw failure;
      }),
    );
    await assert.rejects(validator.check("any-key"), (error) => error === failure, failure.message);
  }
});
