// Client IPs behind the Cloudflare Worker: rate limits tell visitors apart by the address the Worker
// reports, but only when the shared PROXY_SECRET matches. Runs dist/http.js with PROXY_SECRET set
// (no portal needed: the endpoints used here never call it).

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { loadHttpConfig } from "../dist/config.js";
import worker from "../deploy/cloudflare-worker/worker.js";

// Next to the e2e suite's port, so both can run at once
const PORT = Number(process.env.E2E_PORT ?? 3999) + 50;
const BASE = `http://localhost:${PORT}`;
const SECRET = randomBytes(24).toString("hex");
const DASHBOARD_PASSWORD = "correct horse battery staple";
const FORM = { "content-type": "application/x-www-form-urlencoded", origin: "null" };

let server;
let dataDir;
let stderr = "";

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "mess-mcp-proxy-"));
  server = spawn(process.execPath, ["dist/http.js"], {
    env: {
      ...process.env,
      PUBLIC_URL: BASE,
      PORT: String(PORT),
      MCP_SECRET: randomBytes(32).toString("base64"),
      DATA_DIR: dataDir,
      DASHBOARD_PASSWORD,
      PROXY_SECRET: SECRET,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  // The "Client IPs" line is the last one logged at startup
  await new Promise((resolve, reject) => {
    server.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.includes("Client IPs")) resolve();
    });
    server.on("exit", (code) => reject(new Error(`server exited with ${code}\n${stderr}`)));
  });
});

after(() => {
  server?.kill();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

/** Headers the Worker sends: the visitor's address plus the shared secret. */
const fromWorker = (ip, secret = SECRET) => ({ "x-mess-client-ip": ip, "x-mess-proxy-secret": secret });

// /register allows 60 requests per hour per client; an invalid body is the cheapest way to count one
const register = async (headers) => (await fetch(`${BASE}/register`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" })).status;
const guessPassword = async (headers) =>
  (await fetch(`${BASE}/dashboard`, { method: "POST", headers: { ...FORM, ...headers }, body: new URLSearchParams({ password: "wrong" }) })).status;

async function exhaust(send, headers, allowed) {
  for (let i = 0; i < allowed; i++) assert.notEqual(await send(headers), 429, `request ${i + 1} of ${allowed} is within the limit`);
  assert.equal(await send(headers), 429, "the next one is refused");
}

test("with the right secret, each reported address has its own rate limit", async () => {
  await exhaust(register, fromWorker("203.0.113.1"), 60);
  assert.notEqual(await register(fromWorker("203.0.113.2")), 429, "another visitor is unaffected");
  assert.equal(await register(fromWorker("203.0.113.1")), 429, "the first is still limited");
});

test("IPv6 visitors are limited per /56, not per address", async () => {
  await exhaust(register, fromWorker("2001:db8:aa:0::1"), 60);
  assert.equal(await register(fromWorker("2001:db8:aa:0:1234::9")), 429, "another address in the same /56");
  assert.notEqual(await register(fromWorker("2001:db8:bb::1")), 429, "a different /56");
});

test("a wrong or missing secret means the address header is ignored", async () => {
  // Every request claims a different visitor, but they all arrive from this machine, so they share one limit
  for (let i = 0; i < 30; i++) assert.notEqual(await register(fromWorker(`198.51.100.${i + 1}`, "not-the-secret")), 429, `wrong secret ${i + 1}`);
  for (let i = 0; i < 30; i++) assert.notEqual(await register({ "x-mess-client-ip": `198.51.100.${i + 100}` }), 429, `no secret ${i + 1}`);
  assert.equal(await register(fromWorker("198.51.100.200", "not-the-secret")), 429, "spoofed addresses didn't give a fresh limit");
  assert.equal(await register({ "x-mess-client-ip": "198.51.100.201" }), 429);
  assert.equal(await register({}), 429, "and it's the same limit as requests with no headers at all");
});

test("dashboard sign-in guesses are limited per reported address too", async () => {
  await exhaust(guessPassword, fromWorker("203.0.113.50"), 30);
  assert.equal(await guessPassword(fromWorker("203.0.113.51")), 401, "another visitor can still try");
});

test("the log says whether the secret matched, without addresses or the secret", () => {
  assert.match(stderr, /Client IPs: trusting the Worker's address header/);
  assert.match(stderr, /Client IPs: the proxy secret matched/);
  assert.match(stderr, /doesn't match PROXY_SECRET/);
  assert.doesNotMatch(stderr, new RegExp(SECRET), "the secret is never logged");
  assert.doesNotMatch(stderr, /203\.0\.113\.|198\.51\.100\.|2001:db8/, "no visitor addresses");
});

test("PROXY_SECRET is validated at startup", () => {
  const env = { PUBLIC_URL: "https://example.com", MCP_SECRET: randomBytes(32).toString("base64") };
  assert.equal(loadHttpConfig(env).proxySecret, undefined, "optional");
  assert.equal(loadHttpConfig({ ...env, PROXY_SECRET: `${SECRET}\n` }).proxySecret, SECRET, "surrounding whitespace is trimmed");
  assert.throws(() => loadHttpConfig({ ...env, PROXY_SECRET: "short" }), /PROXY_SECRET must be at least 20 characters/);
  assert.throws(() => loadHttpConfig({ ...env, PROXY_SECRET: "has a space inside it, long enough" }), /PROXY_SECRET/);
});

test("the Worker replaces the proxy headers and never passes a visitor's copies", async () => {
  const forward = async (headers, env) => {
    const realFetch = globalThis.fetch;
    let forwarded;
    globalThis.fetch = async (request) => ((forwarded = request), new Response("ok"));
    try {
      await worker.fetch(new Request("https://example.test/authorize?a=1", { headers }), { ORIGIN: "https://origin.example", ...env });
    } finally {
      globalThis.fetch = realFetch;
    }
    return forwarded;
  };
  const forged = { "X-Mess-Client-IP": "6.6.6.6", "x-mess-proxy-secret": "forged" };

  const sent = await forward({ ...forged, "CF-Connecting-IP": "203.0.113.9" }, { PROXY_SECRET: SECRET });
  assert.equal(sent.url, "https://origin.example/authorize?a=1");
  assert.equal(sent.headers.get("x-mess-client-ip"), "203.0.113.9");
  assert.equal(sent.headers.get("x-mess-proxy-secret"), SECRET);

  const noIp = await forward(forged, { PROXY_SECRET: SECRET });
  assert.equal(noIp.headers.get("x-mess-client-ip"), null, "forged copies are dropped even when Cloudflare reports no address");
  assert.equal(noIp.headers.get("x-mess-proxy-secret"), null);

  const noSecret = await forward({ ...forged, "CF-Connecting-IP": "203.0.113.9" }, {});
  assert.equal(noSecret.headers.get("x-mess-client-ip"), null, "nothing is sent until the Worker has a secret");
  assert.equal(noSecret.headers.get("x-mess-proxy-secret"), null);
});
