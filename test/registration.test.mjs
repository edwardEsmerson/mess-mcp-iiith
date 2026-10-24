// Unit tests for POST /register (auth/endpoints.ts), run in-process on an in-memory client repository.
// What matters most here is which redirect URIs are accepted: the address is where the authorization
// code is sent, so it is the one field of a registration that must not be taken on trust.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import express from "express";
import { registrationRouter } from "../dist/auth/endpoints.js";
import { serve } from "./support/fakes.mjs";
import { MemoryClientRepository } from "./support/memory-repos.mjs";

const CURSOR = {
  desktop: "cursor://anysphere.cursor-mcp/oauth/callback",
  web: "https://www.cursor.com/agents/mcp/oauth/callback",
  loopback: "http://localhost:8787/callback",
};

async function setup(t) {
  const repository = new MemoryClientRepository();
  const app = express();
  app.use(express.json());
  app.use(registrationRouter(repository));
  const server = await serve(app);
  t.after(server.close);

  const register = async (body) => {
    const res = await fetch(`${server.url}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { res, body: await res.json() };
  };
  return { repository, register };
}

test("a registration gets its own client_id and is stored as sent", async (t) => {
  const { repository, register } = await setup(t);
  const { res, body } = await register({ client_name: "Some App", redirect_uris: ["https://app.example/callback", "http://127.0.0.1/cb"] });

  assert.equal(res.status, 201);
  assert.match(body.client_id, /^[0-9a-f-]{36}$/);
  assert.equal(body.token_endpoint_auth_method, "none");
  assert.deepEqual(body.redirect_uris, ["https://app.example/callback", "http://127.0.0.1/cb"]);
  assert.deepEqual(body.grant_types, ["authorization_code", "refresh_token"]);
  assert.deepEqual(repository.find(body.client_id), { clientId: body.client_id, clientName: "Some App", redirectUris: ["https://app.example/callback", "http://127.0.0.1/cb"] });

  const second = await register({ redirect_uris: ["https://app.example/callback"] });
  assert.notEqual(second.body.client_id, body.client_id);
  assert.equal(repository.find(second.body.client_id).clientName, undefined);
});

test("a long client name is cut to 100 characters", async (t) => {
  const { repository, register } = await setup(t);
  const { body } = await register({ client_name: "n".repeat(300), redirect_uris: ["https://app.example/cb"] });
  assert.equal(repository.find(body.client_id).clientName.length, 100);
});

test("Cursor's registration, with its three callbacks, is accepted", async (t) => {
  const { repository, register } = await setup(t);
  const { res, body } = await register({
    client_name: "Cursor",
    redirect_uris: [CURSOR.desktop, CURSOR.web, CURSOR.loopback],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });

  assert.equal(res.status, 201);
  assert.deepEqual(body.redirect_uris, [CURSOR.desktop, CURSOR.web, CURSOR.loopback]);
  assert.deepEqual(repository.find(body.client_id).redirectUris, [CURSOR.desktop, CURSOR.web, CURSOR.loopback]);
});

test("a cursor:// redirect on its own is accepted", async (t) => {
  const { res } = await (await setup(t)).register({ redirect_uris: [CURSOR.desktop] });
  assert.equal(res.status, 201);
});

test("script, data, file and unlisted custom schemes are refused", async (t) => {
  const { repository, register } = await setup(t);
  for (const uri of [
    "javascript:alert(1)",
    "javascript://app.example/%0aalert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "vbscript:msgbox(1)",
    "blob:https://app.example/1234",
    "about:blank",
    "ftp://app.example/cb",
    "myapp://callback", // a custom scheme nobody listed
    "claude://callback",
    "vscode://vscode.github-authentication/did-authenticate",
    "com.example.app:/oauth2redirect",
    "cursors://anysphere.cursor-mcp/oauth/callback",
    "cursor:oauth/callback", // the scheme is listed, but not in scheme://app-id form
    "cursor://user@anysphere.cursor-mcp/oauth/callback",
    `${CURSOR.desktop}#frag`,
  ]) {
    const { res, body } = await register({ client_name: "Sneaky", redirect_uris: [uri] });
    assert.equal(res.status, 400, uri);
    assert.equal(body.error, "invalid_redirect_uri", uri);
  }
  assert.equal(repository.clients.size, 0, "none of them was stored");
});

test("one unacceptable address spoils the whole registration, even next to Cursor's", async (t) => {
  const { repository, register } = await setup(t);
  for (const bad of ["javascript:alert(1)", "myapp://callback", "http://app.example/cb"]) {
    const { res } = await register({ redirect_uris: [CURSOR.desktop, CURSOR.web, bad] });
    assert.equal(res.status, 400, bad);
  }
  assert.equal(repository.clients.size, 0);
});

test("the refusal says what is accepted", async (t) => {
  const { body } = await (await setup(t)).register({ redirect_uris: ["myapp://callback"] });
  assert.equal(body.error, "invalid_redirect_uri");
  assert.match(body.error_description, /https/);
  assert.match(body.error_description, /localhost/);
  assert.match(body.error_description, /cursor:/);
});

test("web redirects must be https, with no fragment; plain http is for this computer only", async (t) => {
  const { register } = await setup(t);
  for (const [uri, status] of [
    ["https://app.example/cb", 201],
    ["http://localhost:6274/oauth/callback", 201],
    ["http://[::1]:8080/cb", 201],
    ["http://app.example/cb", 400],
    ["http://localhost.evil.example/cb", 400],
    ["https://app.example/cb#frag", 400],
    ["/relative", 400],
  ]) {
    assert.equal((await register({ redirect_uris: [uri] })).res.status, status, uri);
  }
});

test("redirect_uris must be a list of one to ten strings", async (t) => {
  const { register } = await setup(t);
  const ok = Array.from({ length: 10 }, (_, i) => `https://app.example/cb${i}`);
  assert.equal((await register({ redirect_uris: ok })).res.status, 201);
  for (const redirect_uris of [undefined, [], [...ok, "https://app.example/eleven"], "https://app.example/cb", [42], [null], { 0: "https://app.example/cb" }]) {
    assert.equal((await register({ redirect_uris })).res.status, 400, JSON.stringify(redirect_uris));
  }
});

test("only public clients are registered", async (t) => {
  const { register } = await setup(t);
  assert.equal((await register({ redirect_uris: ["https://app.example/cb"], token_endpoint_auth_method: "none" })).res.status, 201);
  for (const token_endpoint_auth_method of ["client_secret_basic", "client_secret_post", "private_key_jwt"]) {
    const { res, body } = await register({ redirect_uris: ["https://app.example/cb"], token_endpoint_auth_method });
    assert.equal(res.status, 400, token_endpoint_auth_method);
    assert.equal(body.error, "invalid_client_metadata");
  }
});
