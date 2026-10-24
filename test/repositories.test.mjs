// The in-memory repositories the unit tests use (test/support/memory-repos.mjs) must behave like the
// SQLite ones the server runs on, or the unit tests prove nothing. The same checks run against both.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { openDatabase, SqliteClientRepository, SqliteCodeRepository, SqliteGrantRepository, SqliteTokenRepository } from "../dist/auth/sqlite.js";
import { memoryRepositories } from "./support/memory-repos.mjs";

const implementations = {
  memory: () => memoryRepositories(),
  sqlite: () => {
    const db = openDatabase(":memory:");
    return { clients: new SqliteClientRepository(db), grants: new SqliteGrantRepository(db), codes: new SqliteCodeRepository(db), tokens: new SqliteTokenRepository(db) };
  },
};

// SQLite hands back an explicit undefined for a missing optional field where the memory copy has no key
const plain = (value) => value && JSON.parse(JSON.stringify(value));

const grant = (id = "grant-1", overrides = {}) => ({ id, clientId: "client-1", resource: "https://mess.example/mcp", scopes: [], sealedKey: "v1.iv.tag.cipher", createdAt: 1_700_000_000_000, ...overrides });
const code = (hash = "code-hash", grantId = "grant-1") => ({ codeHash: hash, grantId, clientId: "client-1", redirectUri: "http://127.0.0.1:7777/cb", codeChallenge: "challenge", expiresAt: 1_700_000_300_000 });
const token = (hash, kind = "access", grantId = "grant-1") => ({ tokenHash: hash, grantId, kind, expiresAt: 1_700_003_600_000 });

for (const [name, create] of Object.entries(implementations)) {
  test(`${name}: clients are stored and found by id`, () => {
    const { clients } = create();
    const named = { clientId: "c1", clientName: "Named", redirectUris: ["https://app.example/cb", "http://127.0.0.1/cb"] };
    const unnamed = { clientId: "c2", redirectUris: ["https://app.example/cb"] };
    clients.save(named);
    clients.save(unnamed);

    assert.deepEqual(plain(clients.find("c1")), named);
    assert.deepEqual(plain(clients.find("c2")), unnamed);
    assert.equal(clients.find("c3"), undefined);
  });

  test(`${name}: grants are stored, found and deleted`, () => {
    const { grants } = create();
    const plain = grant("g1");
    const scoped = grant("g2", { scopes: ["read", "write"] });
    grants.save(plain);
    grants.save(scoped);

    assert.deepEqual(grants.find("g1"), plain);
    assert.deepEqual(grants.find("g2"), scoped);
    assert.equal(grants.find("g3"), undefined);

    grants.delete("g1");
    grants.delete("g3");
    assert.equal(grants.find("g1"), undefined);
    assert.deepEqual(grants.find("g2"), scoped, "other grants stay");
  });

  test(`${name}: a code can be taken once`, () => {
    const { grants, codes } = create();
    grants.save(grant());
    codes.save(code("a"));
    codes.save(code("b"));

    assert.deepEqual(codes.take("a"), code("a"));
    assert.equal(codes.take("a"), undefined, "gone after being taken");
    assert.deepEqual(codes.take("b"), code("b"), "others stay");
    assert.equal(codes.take("c"), undefined);
  });

  test(`${name}: tokens are stored, found and marked used`, () => {
    const { grants, tokens } = create();
    grants.save(grant());
    tokens.save(token("t-access", "access"));
    tokens.save(token("t-refresh", "refresh"));

    assert.deepEqual(plain(tokens.find("t-access")), token("t-access", "access"));
    assert.equal(tokens.find("t-access").usedAt, undefined);
    assert.equal(tokens.find("t-missing"), undefined);

    tokens.markUsed("t-refresh", 1_700_000_100_000);
    tokens.markUsed("t-missing", 1_700_000_100_000);
    assert.equal(tokens.find("t-refresh").usedAt, 1_700_000_100_000);
    assert.equal(tokens.find("t-access").usedAt, undefined, "only that token");
  });

  test(`${name}: deleting a grant removes its codes and tokens, and only its own`, () => {
    const { grants, codes, tokens } = create();
    grants.save(grant("gone"));
    grants.save(grant("kept"));
    codes.save(code("code-gone", "gone"));
    codes.save(code("code-kept", "kept"));
    tokens.save(token("token-gone", "refresh", "gone"));
    tokens.save(token("token-kept", "refresh", "kept"));

    grants.delete("gone");

    assert.equal(codes.take("code-gone"), undefined);
    assert.equal(tokens.find("token-gone"), undefined);
    assert.ok(codes.take("code-kept"));
    assert.ok(tokens.find("token-kept"));
  });

  test(`${name}: what is returned is a copy, not the stored record`, () => {
    const { grants, tokens } = create();
    grants.save(grant("g1", { scopes: ["read"] }));
    tokens.save(token("t1", "access", "g1"));

    const found = grants.find("g1");
    found.scopes.push("write");
    found.sealedKey = "changed";
    tokens.find("t1").usedAt = 1;

    assert.deepEqual(grants.find("g1"), grant("g1", { scopes: ["read"] }));
    assert.equal(tokens.find("t1").usedAt, undefined);
  });
}
