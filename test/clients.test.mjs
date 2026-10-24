// Unit tests for the client resolvers (auth/clients.ts): metadata documents (CIMD) through a fake fetcher,
// registered clients (DCR) through an in-memory repository, and the redirect URI rules both share.
// The fetcher's own network behaviour is in ssrf.test.mjs.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  CompositeClientResolver,
  displayName,
  isAcceptableRedirectUri,
  MetadataDocumentClientResolver,
  redirectUriAllowed,
  RegisteredClientResolver,
} from "../dist/auth/clients.js";
import { fakeFetcher, manualClock } from "./support/fakes.mjs";
import { MemoryClientRepository } from "./support/memory-repos.mjs";

const ID = "https://app.example/oauth/client.json";
const REDIRECT = "https://app.example/callback";

const document = (overrides = {}) => ({ client_id: ID, client_name: "Example App", redirect_uris: [REDIRECT], ...overrides });

function cimd(documents = { [ID]: document() }, { ttlMs = 60_000, maxEntries = 500 } = {}) {
  const fetcher = fakeFetcher(documents);
  const clock = manualClock();
  return { fetcher, clock, resolver: new MetadataDocumentClientResolver(fetcher, ttlMs, maxEntries, clock) };
}

test("a metadata document becomes a client, fetched from the client_id URL", async () => {
  const { fetcher, resolver } = cimd();
  assert.deepEqual(await resolver.resolve(ID), { clientId: ID, clientName: "Example App", redirectUris: [REDIRECT] });
  assert.deepEqual(fetcher.fetched, [ID]);
});

test("a document without a name makes a client without one", async () => {
  for (const client_name of [undefined, 42, null, { name: "x" }]) {
    const { resolver } = cimd({ [ID]: document({ client_name }) });
    assert.equal((await resolver.resolve(ID)).clientName, undefined, JSON.stringify(client_name));
  }
});

test("a long client name is cut to 100 characters", async () => {
  const { resolver } = cimd({ [ID]: document({ client_name: "n".repeat(300) }) });
  assert.equal((await resolver.resolve(ID)).clientName.length, 100);
});

test("the document must name the client_id it was fetched for", async () => {
  for (const client_id of ["https://app.example/oauth/other.json", `${ID}/`, ID.toUpperCase(), undefined, 7, [ID]]) {
    const { resolver } = cimd({ [ID]: document({ client_id }) });
    assert.equal(await resolver.resolve(ID), undefined, String(client_id));
  }
});

test("documents that aren't objects are refused", async () => {
  for (const body of [null, "a string", 42, true, []]) {
    const { resolver } = cimd({ [ID]: body });
    assert.equal(await resolver.resolve(ID), undefined, JSON.stringify(body));
  }
});

test("a client_id that isn't a plain https URL with a path is never fetched", async () => {
  const bad = [
    "http://app.example/client.json", // not https
    "https://app.example", // no path
    "https://app.example/", // root path only
    "https://app.example/client.json#frag", // fragment
    "https://user@app.example/client.json", // credentials
    "https://user:secret@app.example/client.json",
    "https://app.example/a/../client.json", // dot segments
    "https://app.example/a/./client.json",
    "https://app.example/%2e%2e/client.json",
    "https://APP.example/client.json", // not in normalised form
    "https://app.example:443/client.json",
    "https://",
    "https:// space.example/x",
  ];
  for (const clientId of bad) {
    const { fetcher, resolver } = cimd({ [clientId]: document({ client_id: clientId }) });
    assert.equal(await resolver.resolve(clientId), undefined, clientId);
    assert.deepEqual(fetcher.fetched, [], `${clientId} was not fetched`);
  }
});

test("a client_id URL may carry a query or a port", async () => {
  for (const clientId of ["https://app.example/client.json?v=2", "https://app.example:8443/client.json"]) {
    const { resolver } = cimd({ [clientId]: document({ client_id: clientId }) });
    assert.equal((await resolver.resolve(clientId))?.clientId, clientId);
  }
});

test("redirect_uris must be a non-empty list of acceptable addresses", async () => {
  const refused = [
    undefined,
    [],
    REDIRECT, // a string, not a list
    [REDIRECT, "http://evil.example/cb"], // one bad address spoils the list
    [REDIRECT, "javascript:alert(1)"],
    [REDIRECT, 42],
    [`${REDIRECT}#frag`],
    ["not a url"],
  ];
  for (const redirect_uris of refused) {
    const { resolver } = cimd({ [ID]: document({ redirect_uris }) });
    assert.equal(await resolver.resolve(ID), undefined, JSON.stringify(redirect_uris));
  }

  const { resolver } = cimd({ [ID]: document({ redirect_uris: [REDIRECT, "http://127.0.0.1/callback", "http://localhost:8080/cb", "http://[::1]/cb"] }) });
  assert.equal((await resolver.resolve(ID)).redirectUris.length, 4, "https and loopback addresses are fine");
});

test("the client must be able to be a public client (token_endpoint_auth_method none)", async () => {
  const accepted = [
    {}, // not stated: public client
    { token_endpoint_auth_method: "none" },
    // ChatGPT: prefers private_key_jwt but lists "none" among the methods it supports
    { token_endpoint_auth_method: "private_key_jwt", token_endpoint_auth_methods_supported: ["private_key_jwt", "none"] },
    { token_endpoint_auth_method: "client_secret_basic", token_endpoint_auth_methods_supported: ["none"] },
    { token_endpoint_auth_methods_supported: ["none", "client_secret_post"] },
  ];
  const refused = [
    { token_endpoint_auth_method: "private_key_jwt" },
    { token_endpoint_auth_method: "client_secret_basic" },
    { token_endpoint_auth_method: "private_key_jwt", token_endpoint_auth_methods_supported: ["private_key_jwt"] },
    { token_endpoint_auth_method: "private_key_jwt", token_endpoint_auth_methods_supported: [] },
    { token_endpoint_auth_method: "private_key_jwt", token_endpoint_auth_methods_supported: "none" }, // not a list
    { token_endpoint_auth_method: null },
  ];
  for (const extra of accepted) {
    const { resolver } = cimd({ [ID]: document(extra) });
    assert.ok(await resolver.resolve(ID), JSON.stringify(extra));
  }
  for (const extra of refused) {
    const { resolver } = cimd({ [ID]: document(extra) });
    assert.equal(await resolver.resolve(ID), undefined, JSON.stringify(extra));
  }
});

test("an unreachable document is no client, and the next attempt asks again", async () => {
  const { fetcher, resolver } = cimd({ [ID]: new Error("connection refused") });
  assert.equal(await resolver.resolve(ID), undefined);

  fetcher.documents[ID] = document();
  assert.ok(await resolver.resolve(ID), "failures aren't cached");
  assert.deepEqual(fetcher.fetched, [ID, ID]);
});

test("an invalid document isn't cached either", async () => {
  const { fetcher, resolver } = cimd({ [ID]: document({ redirect_uris: ["http://evil.example/cb"] }) });
  assert.equal(await resolver.resolve(ID), undefined);
  fetcher.documents[ID] = document();
  assert.ok(await resolver.resolve(ID));
});

test("a resolved client is cached until its lifetime ends", async () => {
  const { fetcher, clock, resolver } = cimd(undefined, { ttlMs: 60_000 });
  await resolver.resolve(ID);
  clock.advance(59_999);
  await resolver.resolve(ID);
  assert.deepEqual(fetcher.fetched, [ID], "still cached one millisecond before it ends");

  fetcher.documents[ID] = document({ client_name: "Renamed" });
  clock.advance(1);
  assert.equal((await resolver.resolve(ID)).clientName, "Renamed", "fetched again when the lifetime is over");
  assert.equal(fetcher.fetched.length, 2);
});

test("the cache holds a limited number of clients, dropping the oldest", async () => {
  const ids = ["a", "b", "c"].map((name) => `https://app.example/${name}.json`);
  const { fetcher, resolver } = cimd(
    Object.fromEntries(ids.map((id) => [id, document({ client_id: id })])),
    { maxEntries: 2 },
  );
  for (const id of ids) await resolver.resolve(id);
  assert.equal(fetcher.fetched.length, 3);

  await resolver.resolve(ids[2]);
  await resolver.resolve(ids[1]);
  assert.equal(fetcher.fetched.length, 3, "the two newest are still cached");
  await resolver.resolve(ids[0]);
  assert.equal(fetcher.fetched.length, 4, "the oldest was dropped");
});

test("the metadata resolver only handles https client ids", () => {
  const { resolver } = cimd();
  assert.equal(resolver.handles(ID), true);
  assert.equal(resolver.handles("0b1d3c5e-6c56-4c63-9f43-6d6a5e0c2f10"), false);
  assert.equal(resolver.handles("http://app.example/client.json"), false);
});

test("registered clients are looked up by the id /register issued", async () => {
  const repository = new MemoryClientRepository();
  repository.save({ clientId: "registered-1", clientName: "Registered", redirectUris: ["http://127.0.0.1/callback"] });
  const resolver = new RegisteredClientResolver(repository);

  assert.deepEqual(await resolver.resolve("registered-1"), { clientId: "registered-1", clientName: "Registered", redirectUris: ["http://127.0.0.1/callback"] });
  assert.equal(await resolver.resolve("registered-2"), undefined);
  assert.equal(resolver.handles("registered-1"), true);
  assert.equal(resolver.handles(ID), false, "https ids belong to the metadata resolver");
});

test("the composite asks the strategy responsible for the id, and no other", async () => {
  const repository = new MemoryClientRepository();
  repository.save({ clientId: "registered-1", redirectUris: ["http://127.0.0.1/callback"] });
  // Even a row stored under an https id can't be reached through the registered strategy
  repository.save({ clientId: ID, redirectUris: ["https://evil.example/cb"] });
  const { fetcher, resolver: metadata } = cimd();
  const composite = new CompositeClientResolver([metadata, new RegisteredClientResolver(repository)]);

  assert.equal((await composite.resolve("registered-1")).clientId, "registered-1");
  assert.deepEqual(fetcher.fetched, [], "registered ids don't cause a fetch");

  assert.deepEqual((await composite.resolve(ID)).redirectUris, [REDIRECT], "the fetched document wins over the stored row");
  assert.equal(await composite.resolve("unknown"), undefined);
  assert.equal(await new CompositeClientResolver([]).resolve("registered-1"), undefined, "no strategy, no client");
});

test("display names: the app's own name, else its host, else a placeholder", () => {
  assert.equal(displayName({ clientId: ID, clientName: "Example App" }), "Example App");
  assert.equal(displayName({ clientId: ID }), "app.example");
  assert.equal(displayName({ clientId: "https://app.example:8443/x.json" }), "app.example:8443");
  assert.equal(displayName({ clientId: "0b1d3c5e-6c56-4c63-9f43-6d6a5e0c2f10" }), "An unnamed app");
});

test("redirect URIs must be https or loopback http, without a fragment", () => {
  for (const uri of [
    "https://app.example/callback",
    "https://app.example:8443/cb?x=1",
    "http://localhost/callback",
    "http://localhost:6274/oauth/callback",
    "http://127.0.0.1:7777/callback",
    "http://[::1]:8080/cb",
  ]) {
    assert.equal(isAcceptableRedirectUri(uri), true, uri);
  }
  for (const uri of [
    "http://app.example/callback", // plain http off this computer
    "http://localhost.evil.example/cb",
    "http://127.0.0.1.evil.example/cb",
    "http://127.0.0.1@evil.example/cb",
    "http://0.0.0.0/cb",
    "http://127.0.0.2/cb", // only the spelled-out loopback names count
    "https://app.example/cb#frag",
    "http://localhost/cb#frag",
    "javascript:alert(1)",
    "javascript://app.example/%0aalert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "vbscript:msgbox(1)",
    "ftp://app.example/cb",
    "ws://localhost/cb",
    "//app.example/cb",
    "/callback",
    "app.example/callback",
    "not a url",
    "",
  ]) {
    assert.equal(isAcceptableRedirectUri(uri), false, uri);
  }
  for (const value of [undefined, null, 42, {}, ["https://app.example/cb"]]) {
    assert.equal(isAcceptableRedirectUri(value), false, JSON.stringify(value));
  }
});

test("a redirect must match a registered one exactly, except for the port on a loopback address", () => {
  const client = { clientId: "c", redirectUris: [REDIRECT, "http://127.0.0.1/callback?mode=app", "http://localhost/cb"] };
  const allowed = (uri) => redirectUriAllowed(client, uri);

  assert.equal(allowed(REDIRECT), true);
  assert.equal(allowed("http://127.0.0.1/callback?mode=app"), true);
  assert.equal(allowed("http://127.0.0.1:54321/callback?mode=app"), true, "any port on loopback (RFC 8252 section 7.3)");
  assert.equal(allowed("http://localhost:9/cb"), true);

  assert.equal(allowed("https://app.example/callback/"), false, "a web address must match exactly");
  assert.equal(allowed("https://app.example:8443/callback"), false, "and that includes the port");
  assert.equal(allowed(`${REDIRECT}?extra=1`), false);
  assert.equal(allowed("http://127.0.0.1:54321/other?mode=app"), false, "the path must match");
  assert.equal(allowed("http://127.0.0.1:54321/callback"), false, "and the query");
  assert.equal(allowed("http://127.0.0.1:54321/callback?mode=other"), false);
  assert.equal(allowed("http://localhost:54321/callback?mode=app"), false, "localhost and 127.0.0.1 are not interchangeable");
  assert.equal(allowed("http://[::1]:54321/cb"), false, "a loopback host that wasn't registered");
  assert.equal(allowed("https://127.0.0.1:54321/callback?mode=app"), false, "the scheme must match");
  assert.equal(allowed("http://evil.example:54321/cb"), false);
  assert.equal(allowed("not a url"), false);
  assert.equal(allowed(""), false);
});

test("a registered web address doesn't open up a port range", () => {
  const client = { clientId: "c", redirectUris: ["http://app.example:8080/cb"] };
  assert.equal(redirectUriAllowed(client, "http://app.example:8080/cb"), true);
  assert.equal(redirectUriAllowed(client, "http://app.example:9090/cb"), false);
});
