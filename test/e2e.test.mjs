// End-to-end test of the hosted server: OAuth discovery, client registration, the sign-in page,
// token exchange and rotation, and MCP calls, against a mock portal. Runs the built dist/http.js.
// One optional check fetches Claude Code's real client metadata document and is skipped offline.

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const PORT = 3999;
const BASE = `http://localhost:${PORT}`;
const RESOURCE = `${BASE}/mcp`;
const REDIRECT = "http://127.0.0.1:7777/callback";
// Browsers submit the sign-in form with `Origin: null` because the page sets no-referrer
const FORM = { "content-type": "application/x-www-form-urlencoded", origin: "null" };
const GOOD_KEY = "good-key";
const METRICS_TOKEN = randomBytes(24).toString("hex");

let portal;
let portalKeyRevoked = false;
let server;
let dataDir;

before(async () => {
  portal = http.createServer((req, res) => {
    const ok = req.headers.authorization === GOOD_KEY && !portalKeyRevoked;
    res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify(ok ? { data: { name: "Test Student" } } : { error: { message: "Please login to view this page." } }));
  });
  portal.listen(0, "127.0.0.1");
  await once(portal, "listening");

  dataDir = mkdtempSync(join(tmpdir(), "mess-mcp-e2e-"));
  server = spawn(process.execPath, ["dist/http.js"], {
    env: {
      ...process.env,
      PUBLIC_URL: BASE,
      PORT: String(PORT),
      MCP_SECRET: randomBytes(32).toString("base64"),
      DATA_DIR: dataDir,
      METRICS_TOKEN,
      MESS_API_URL: `http://127.0.0.1:${portal.address().port}`,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  // The server logs "listening" to stderr once it accepts connections
  await new Promise((resolve, reject) => {
    server.stderr.on("data", (chunk) => String(chunk).includes("listening") && resolve());
    server.on("exit", (code) => reject(new Error(`server exited with ${code}`)));
  });
});

after(() => {
  server?.kill();
  portal?.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

const form = (fields) => new URLSearchParams(fields).toString();

async function mcp(token, body, extraHeaders = {}) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const json = text.startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").find((l) => l.startsWith("data:"))?.slice(5) ?? "null");
  return { res, json };
}

async function startAuthorization(clientId, redirectUri = REDIRECT) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
    resource: RESOURCE,
  });
  const res = await fetch(`${BASE}/authorize?${query}`, { redirect: "manual" });
  const html = await res.text();
  return { res, html, request: /name="request" value="([^"]+)"/.exec(html)?.[1], verifier };
}

async function submitKey(request, diningKey, action = "approve") {
  return fetch(`${BASE}/authorize`, { method: "POST", headers: FORM, body: form({ request, dining_key: diningKey, action }), redirect: "manual" });
}

async function signIn(clientId) {
  const auth = await startAuthorization(clientId);
  const approved = await submitKey(auth.request, GOOD_KEY);
  const code = new URL(approved.headers.get("location")).searchParams.get("code");
  const res = await fetch(`${BASE}/token`, {
    method: "POST",
    headers: FORM,
    body: form({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: auth.verifier, resource: RESOURCE }),
  });
  return res.json();
}

async function register(redirectUris = ["http://127.0.0.1/callback"], name = "E2E <b>Client</b>") {
  const res = await fetch(`${BASE}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: name, redirect_uris: redirectUris }) });
  return { res, body: await res.json() };
}

test("discovery: 401 challenge and metadata documents", async () => {
  const { res } = await mcp(undefined, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate"), new RegExp(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`));

  const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(prm.resource, RESOURCE);
  assert.deepEqual(prm.authorization_servers, [BASE]);

  const as = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  assert.equal(as.issuer, BASE);
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  assert.equal(as.client_id_metadata_document_supported, true);
  assert.ok(as.token_endpoint_auth_methods_supported.includes("none"));
});

test("dynamic client registration validates redirect URIs", async () => {
  const ok = await register();
  assert.equal(ok.res.status, 201);
  assert.equal(ok.body.token_endpoint_auth_method, "none");
  const bad = await register(["http://evil.example/cb"]);
  assert.equal(bad.res.status, 400);
});

test("authorize page: rendering, validation and errors", async () => {
  const { body: client } = await register();
  const auth = await startAuthorization(client.client_id);
  assert.equal(auth.res.status, 200, "loopback redirect matches on any port");
  assert.ok(auth.request);
  assert.ok(auth.html.includes("E2E &lt;b&gt;Client&lt;/b&gt;"), "client name is escaped");
  assert.match(auth.res.headers.get("content-security-policy"), /form-action 'self' http:\/\/127\.0\.0\.1:7777/);
  const font = await fetch(`${BASE}/authorize/font.woff2`);
  assert.equal(font.status, 200, "the page's font is served from this origin");
  assert.equal(font.headers.get("content-type"), "font/woff2");

  const wrongPath = await fetch(`${BASE}/authorize?` + new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: "http://127.0.0.1:7777/other", code_challenge: "x", code_challenge_method: "S256" }));
  assert.equal(wrongPath.status, 400, "unregistered redirect gets an error page, not a redirect");

  const noPkce = await fetch(`${BASE}/authorize?` + new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT }), { redirect: "manual" });
  assert.equal(noPkce.status, 302);
  assert.match(noPkce.headers.get("location"), /error=invalid_request/);

  const rejected = await submitKey(auth.request, "wrong-key");
  assert.equal(rejected.status, 400);
  assert.match(await rejected.text(), /accept that key/);

  const tampered = await submitKey(auth.request.replace(/^./, (c) => (c === "e" ? "f" : "e")), GOOD_KEY);
  assert.equal(tampered.status, 400, "a tampered signed request is refused");

  const denied = await submitKey(auth.request, "", "deny");
  assert.equal(denied.status, 302);
  assert.match(denied.headers.get("location"), /error=access_denied/);

  const approved = await submitKey(auth.request, GOOD_KEY);
  assert.equal(approved.status, 302);
  const location = new URL(approved.headers.get("location"));
  assert.equal(location.origin, "http://127.0.0.1:7777");
  assert.ok(location.searchParams.get("code"));
  assert.equal(location.searchParams.get("state"), "xyz");
  assert.equal(location.searchParams.get("iss"), BASE);
});

test("token endpoint: PKCE, single-use codes, rotation and reuse detection", async () => {
  const { body: client } = await register();

  // A failed PKCE check burns the code
  const first = await startAuthorization(client.client_id);
  const code = new URL((await submitKey(first.request, GOOD_KEY)).headers.get("location")).searchParams.get("code");
  const badPkce = await fetch(`${BASE}/token`, { method: "POST", headers: FORM, body: form({ grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: "x".repeat(43) }) });
  assert.equal(badPkce.status, 400);
  assert.equal((await badPkce.json()).error, "invalid_grant");

  const second = await startAuthorization(client.client_id);
  const code2 = new URL((await submitKey(second.request, GOOD_KEY)).headers.get("location")).searchParams.get("code");
  const exchange = () =>
    fetch(`${BASE}/token`, { method: "POST", headers: FORM, body: form({ grant_type: "authorization_code", code: code2, client_id: client.client_id, redirect_uri: REDIRECT, code_verifier: second.verifier, resource: RESOURCE }) });
  const issued = await exchange();
  assert.equal(issued.status, 200);
  assert.equal(issued.headers.get("cache-control"), "no-store");
  const tokens = await issued.json();
  assert.match(tokens.access_token, /^mmcp_at_/);
  assert.match(tokens.refresh_token, /^mmcp_rt_/);
  assert.equal((await exchange()).status, 400, "codes are single use");

  const refresh = (refreshToken) => fetch(`${BASE}/token`, { method: "POST", headers: FORM, body: form({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: client.client_id, resource: RESOURCE }) });
  const rotated = await (await refresh(tokens.refresh_token)).json();
  assert.notEqual(rotated.refresh_token, tokens.refresh_token);
  assert.equal((await mcp(rotated.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })).res.status, 200);

  const reuse = await refresh(tokens.refresh_token);
  assert.equal(reuse.status, 400);
  assert.equal((await reuse.json()).error, "invalid_grant");
  assert.equal((await mcp(rotated.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })).res.status, 401, "reuse revokes the whole grant");
});

test("MCP calls use the stored key; bad tokens and foreign origins are refused", async () => {
  const { body: client } = await register();
  const tokens = await signIn(client.client_id);

  const init = await mcp(tokens.access_token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } });
  assert.equal(init.json.result.serverInfo.name, "mess-mcp-iiith");

  const list = await mcp(tokens.access_token, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assert.equal(list.json.result.tools.length, 30);
  const schemas = JSON.stringify(list.json.result.tools.map((t) => t.inputSchema));
  assert.doesNotMatch(schemas, /\$schema|9007199254740991/, "tool schemas carry no zod noise");

  const call = await mcp(tokens.access_token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_user_info", arguments: {} } });
  assert.match(call.json.result.content[0].text, /Test Student/);

  assert.equal((await mcp("not-a-real-token", { jsonrpc: "2.0", id: 1, method: "tools/list" })).res.status, 401);
  assert.equal((await mcp(tokens.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { origin: "https://evil.example" })).res.status, 403);
});

test("a key revoked on the portal ends the grant so the client re-authenticates", async () => {
  const { body: client } = await register();
  const tokens = await signIn(client.client_id);
  portalKeyRevoked = true;
  try {
    const call = await mcp(tokens.access_token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_user_info", arguments: {} } });
    assert.equal(call.json.result.isError, true);
    assert.match(call.json.result.content[0].text, /Reconnect/);
    assert.equal((await mcp(tokens.access_token, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })).res.status, 401);
  } finally {
    portalKeyRevoked = false;
  }
});

test("metrics and dashboard: token required, counts what earlier cases did", async () => {
  const basic = (password) => ({ authorization: "Basic " + Buffer.from(`admin:${password}`).toString("base64") });

  const anonymous = await fetch(`${BASE}/metrics`);
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get("www-authenticate"), /^Basic realm=/, "browsers get a password prompt");
  assert.equal((await fetch(`${BASE}/metrics`, { headers: { authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await fetch(`${BASE}/dashboard`, { headers: basic("wrong") })).status, 401);

  const res = await fetch(`${BASE}/metrics`, { headers: { authorization: `Bearer ${METRICS_TOKEN}` } });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /^mess_mcp_tool_calls_total\{tool="get_user_info",outcome="ok"\} 1$/m);
  assert.match(text, /^mess_mcp_tool_calls_total\{tool="get_user_info",outcome="portal_rejected"\} 1$/m, "the revoked-key call");
  assert.match(text, /^mess_mcp_grants_revoked_total\{reason="portal_key_rejected"\} 1$/m);
  assert.match(text, /^mess_mcp_sign_ins_total\{outcome="rejected_key"\} 1$/m);
  assert.match(text, /^mess_mcp_sign_ins_total\{outcome="cancelled"\} 1$/m);
  assert.match(text, /^mess_mcp_tool_call_duration_seconds_count\{tool="get_user_info"\} 2$/m);
  assert.match(text, /^mess_mcp_active_users\{window="1d"\} 2$/m, "both grants that called a tool");
  assert.match(text, /^mess_mcp_connections\{app="E2E <b>Client<\/b>"\} \d+$/m, "grouped by app name, not per-registration client ID");
  assert.match(text, /^mess_mcp_http_requests_total\{route="\/token",method="POST",status="200"\} \d+$/m);
  assert.doesNotMatch(text, /mmcp_|good-key|Test Student/, "no tokens, keys or portal data");

  const page = await fetch(`${BASE}/dashboard?days=7`, { headers: basic(METRICS_TOKEN) });
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);
  const html = await page.text();
  assert.match(html, /<code>get_user_info<\/code><\/td><td class="n">2<\/td>/, "daily totals were saved and read back");
  assert.match(html, /aria-current="page">7 days/);
});

test("client metadata documents: private addresses are refused", async () => {
  for (const host of ["127.0.0.1", "[::ffff:127.0.0.1]", "10.10.32.26", "100.96.86.49", "192.168.1.1"]) {
    const res = await fetch(`${BASE}/authorize?` + new URLSearchParams({ response_type: "code", client_id: `https://${host}/client.json`, redirect_uri: REDIRECT, code_challenge: "x", code_challenge_method: "S256" }));
    assert.equal(res.status, 400, host);
  }
});

test("client metadata documents: Claude Code's published document resolves", async (t) => {
  const document = "https://claude.ai/oauth/claude-code-client-metadata";
  const online = await fetch(document, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok, () => false);
  if (!online) return t.skip("claude.ai is not reachable from here");
  const auth = await startAuthorization(document, "http://localhost:51234/callback");
  assert.equal(auth.res.status, 200);
  assert.match(auth.html, /<h1>Claude Code wants/);
});
