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

// E2E_PORT lets several checkouts run the suite at once
const PORT = Number(process.env.E2E_PORT ?? 3999);
const BASE = `http://localhost:${PORT}`;
const RESOURCE = `${BASE}/mcp`;
const REDIRECT = "http://127.0.0.1:7777/callback";
// Browsers submit the sign-in form with `Origin: null` because the page sets no-referrer
const FORM = { "content-type": "application/x-www-form-urlencoded", origin: "null" };
const GOOD_KEY = "good-key";
const DASHBOARD_PASSWORD = "correct horse battery staple";
// Real values seen on the portal: registering closes 4 days ahead, cancelling 2
const PORTAL_CONFIG = {
  "/config/registration-window": 345600,
  "/config/cancellation-window": 172800,
  "/config/extras-window": 86400,
  "/config/registration-max-date": "2099-12-31",
};

let portal;
let portalKeyRevoked = false;
let server;
let dataDir;

before(async () => {
  portal = http.createServer((req, res) => {
    const ok = req.headers.authorization === GOOD_KEY && !portalKeyRevoked;
    res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
    const data = PORTAL_CONFIG[new URL(req.url, "http://portal").pathname] ?? { name: "Test Student" };
    res.end(JSON.stringify(ok ? { data } : { error: { message: "Please login to view this page." } }));
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
      DASHBOARD_PASSWORD,
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
  assert.equal(list.json.result.tools.length, 31);
  const schemas = JSON.stringify(list.json.result.tools.map((t) => t.inputSchema));
  assert.doesNotMatch(schemas, /\$schema|9007199254740991/, "tool schemas carry no zod noise");

  const call = await mcp(tokens.access_token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_user_info", arguments: {} } });
  assert.match(call.json.result.content[0].text, /Test Student/);

  const deadlines = await mcp(tokens.access_token, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_deadlines", arguments: {} } });
  const { today, register_or_change_mess, cancel_or_uncancel, add_extras } = JSON.parse(deadlines.json.result.content[0].text);
  const daysAfterToday = (d) => (Date.parse(d) - Date.parse(today)) / 86400000;
  assert.deepEqual([daysAfterToday(register_or_change_mess.from), daysAfterToday(cancel_or_uncancel.from), daysAfterToday(add_extras.from)], [4, 2, 1]);
  assert.equal(register_or_change_mess.to, "2099-12-31");

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

test("metrics and dashboard: password required, counts what earlier cases did", async () => {
  const anonymous = await fetch(`${BASE}/metrics`);
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get("www-authenticate"), /^Bearer /);
  assert.equal((await fetch(`${BASE}/metrics`, { headers: { authorization: "Bearer wrong" } })).status, 401);

  const res = await fetch(`${BASE}/metrics`, { headers: { authorization: `Bearer ${DASHBOARD_PASSWORD}` } });
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

  // Browsers get a sign-in form, not a password popup
  const signInPage = await fetch(`${BASE}/dashboard`);
  assert.equal(signInPage.status, 401);
  assert.equal(signInPage.headers.get("www-authenticate"), null);
  assert.match(await signInPage.text(), /<form method="post" action="\/dashboard">/);

  const signIn = (password) => fetch(`${BASE}/dashboard`, { method: "POST", headers: FORM, body: new URLSearchParams({ password }), redirect: "manual" });
  const wrong = await signIn("wrong");
  assert.equal(wrong.status, 401);
  assert.match(await wrong.text(), /role="alert">That password isn/);
  const right = await signIn(DASHBOARD_PASSWORD);
  assert.equal(right.status, 303);
  const setCookie = right.headers.get("set-cookie");
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  const cookie = setCookie.split(";")[0];
  assert.equal((await fetch(`${BASE}/dashboard`, { headers: { cookie: cookie.replace(/.$/, "x") } })).status, 401, "a tampered cookie is refused");

  const page = await fetch(`${BASE}/dashboard?days=7`, { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);
  const html = await page.text();
  assert.match(html, /<code>get_user_info<\/code><\/td><td class="n">2<\/td>/, "daily totals were saved and read back");
  assert.match(html, /aria-current="page">7 days/);

  const signOut = await fetch(`${BASE}/dashboard/sign-out`, { method: "POST", headers: { ...FORM, cookie }, redirect: "manual" });
  assert.equal(signOut.status, 303);
  assert.match(signOut.headers.get("set-cookie"), /mess_mcp_dashboard=;/);
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

test("client metadata documents: ChatGPT's published document resolves", async (t) => {
  // ChatGPT prefers private_key_jwt but also supports "none", which is all we accept
  const document = "https://chatgpt.com/oauth/client.json";
  const online = await fetch(document, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok, () => false);
  if (!online) return t.skip("chatgpt.com is not reachable from here");
  const auth = await startAuthorization(document, "https://chatgpt.com/connector_platform_oauth_redirect");
  assert.equal(auth.res.status, 200);
  assert.match(auth.html, /<h1>ChatGPT wants/);
});

// Public pages. A second server (own port, own data dir) is used where a case needs different settings.
async function withServer(env, run) {
  const { createServer } = await import("node:net");
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  probe.close();
  await once(probe, "close");

  const dir = mkdtempSync(join(tmpdir(), "mess-mcp-e2e-"));
  const child = spawn(process.execPath, ["dist/http.js"], {
    env: { ...process.env, PUBLIC_URL: `http://localhost:${port}`, PORT: String(port), MCP_SECRET: randomBytes(32).toString("base64"), DATA_DIR: dir, DASHBOARD_PASSWORD: "", METRICS_TOKEN: "", HOSTING_NOTE: "", ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    await new Promise((resolve, reject) => {
      child.stderr.on("data", (chunk) => String(chunk).includes("listening") && resolve());
      child.on("exit", (code) => reject(new Error(`server exited with ${code}`)));
    });
    await run(`http://localhost:${port}`);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("privacy page: what is stored, for how long, and who can see the traffic", async () => {
  const res = await fetch(`${BASE}/privacy`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/html/);
  assert.match(res.headers.get("content-security-policy"), /^default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; /);
  const html = await res.text();
  assert.match(html, /<title>Privacy/);
  assert.match(html, /AES-256-GCM/);
  assert.match(html, /SHA-256 hash/);
  assert.match(html, /Sign-in codes<\/strong> last 5 minutes/);
  assert.match(html, /Access tokens<\/strong> last 1 hour/);
  assert.match(html, /Refresh tokens<\/strong> last 60 days/);
  assert.match(html, /Usage statistics \(turned on for this server\)/, "this server runs with a dashboard password");
  assert.match(html, /deleted after 90 days/);
  assert.match(html, /Whoever runs this server can technically decrypt your key/);
  assert.match(html, /Only connect if you trust whoever runs this server/);
  assert.match(html, /Tailscale Funnel/);
  assert.match(html, /Cloudflare[^<]*can see everything/);
  assert.match(html, /not an IIIT Hyderabad service/);
  assert.match(html, /href="https:\/\/dining\.iiit\.ac\.in"/);
  assert.match(html, /href="https:\/\/github\.com\/edwardEsmerson\/mess-mcp-iiith\/issues"/);
  assert.match(html, /Never paste your dining key or any token into an issue/);
  assert.doesNotMatch(html, /How this server is hosted/, "no operator note without HOSTING_NOTE");
  assert.match(html, /hasn't described its setup/);
  assert.doesNotMatch(html, /<script|<iframe|<img|<link|\bsrc=|@import|url\(https?:/, "nothing is loaded from elsewhere");
  assert.doesNotMatch(html, /good-key|mmcp_/);
});

test("privacy page: the operator's hosting note is escaped, and statistics show as off", async () => {
  await withServer({ HOSTING_NOTE: `Runs on a <b>laptop</b> & "Wi-Fi" <script>alert(1)</script>` }, async (base) => {
    const html = await (await fetch(`${base}/privacy`)).text();
    assert.match(html, /<h2>How this server is hosted<\/h2>/);
    assert.ok(html.includes("Runs on a &lt;b&gt;laptop&lt;/b&gt; &amp; &quot;Wi-Fi&quot; &lt;script&gt;alert(1)&lt;/script&gt;"), "plain text, HTML-escaped");
    assert.doesNotMatch(html, /<b>laptop|<script/);
    assert.doesNotMatch(html, /hasn't described its setup/);
    assert.match(html, /Usage statistics \(turned off for this server\)/);
    assert.doesNotMatch(html, /deleted after 90 days/, "no retention line for statistics that aren't kept");
  });
});

test("privacy page: a blank hosting note shows no section", async () => {
  await withServer({ HOSTING_NOTE: "   " }, async (base) => {
    assert.doesNotMatch(await (await fetch(`${base}/privacy`)).text(), /How this server is hosted/);
  });
});

test("landing page: connector URL, steps for each app, video, disconnecting and links", async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/html/);
  const html = await res.text();
  assert.match(html, /<code id="connector-url">http:\/\/localhost:\d+\/mcp<\/code>/);
  assert.ok(html.includes(`<code id="connector-url">${RESOURCE}</code>`), "the configured connector URL, not a hard-coded one");
  assert.ok(html.includes(`claude mcp add --transport http mess ${RESOURCE} -s user`));
  assert.match(html, /Add custom connector/);
  assert.match(html, /Developer mode/);
  assert.match(html, /Cursor, VS Code and other apps/);
  assert.match(html, /Settings → Auth Keys/);
  assert.match(html, /href="https:\/\/youtu\.be\/A3CGL5TJSxs"/);
  assert.match(html, /href="\/privacy"/);
  assert.match(html, /href="https:\/\/github\.com\/edwardEsmerson\/mess-mcp-iiith"/);
  assert.match(html, /<h2>Disconnecting<\/h2>/);
  assert.match(html, /about 60 days after your app last connected/);
  assert.match(html, /<button type="button" id="copy" class="primary" hidden>/, "the copy button only appears once the script runs");
  assert.doesNotMatch(html, /<iframe|<img|<link|\bsrc=|@import|url\(https?:/, "nothing is loaded from elsewhere");

  // The CSP lets exactly one script run: the page's own copy button
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  const hash = createHash("sha256").update(scripts[0][1]).digest("base64");
  const csp = res.headers.get("content-security-policy");
  assert.ok(csp.includes(`script-src 'sha256-${hash}'`), "the CSP hash matches the inline script");
  assert.match(csp, /default-src 'none'/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe/);

  const privacy = await fetch(`${BASE}/privacy`);
  assert.doesNotMatch(privacy.headers.get("content-security-policy"), /script-src/, "the privacy page runs no script");

  const head = await fetch(`${BASE}/`, { method: "HEAD" });
  assert.equal(head.status, 200);
});

test("landing page: the dashboard counts it as a known route", async () => {
  const text = await (await fetch(`${BASE}/metrics`, { headers: { authorization: `Bearer ${DASHBOARD_PASSWORD}` } })).text();
  assert.match(text, /^mess_mcp_http_requests_total\{route="\/",method="GET",status="200"\} \d+$/m);
  assert.match(text, /^mess_mcp_http_requests_total\{route="\/privacy",method="GET",status="200"\} \d+$/m);
});

test("responses don't advertise the framework", async () => {
  // A page, a plain 404, the OAuth metadata and the 401 challenge from /mcp all come through Express
  for (const path of ["/healthz", "/authorize", "/nothing-here", "/.well-known/oauth-authorization-server", "/mcp"]) {
    const res = await fetch(`${BASE}${path}`);
    assert.equal(res.headers.get("x-powered-by"), null, path);
  }
});
