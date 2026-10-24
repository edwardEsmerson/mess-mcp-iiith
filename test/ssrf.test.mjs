// The SSRF guard on client metadata documents (PublicHttpsJsonFetcher). Two halves:
//  - refusals, with an injected resolver standing in for DNS, including a rebinding domain that
//    answers with a public address first and a private one afterwards. A TCP listener on loopback
//    stands in for the campus network: it must never see a connection.
//  - everything else the fetcher promises (JSON parsing, no redirects, size cap, timeout), against a
//    local HTTPS server. Loopback is normally refused, so a child process swaps in an empty block list
//    and trusts a throwaway certificate through NODE_EXTRA_CA_CERTS. Skipped without openssl.

import { strict as assert } from "node:assert";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { PublicHttpsJsonFetcher } from "../dist/auth/clients.js";

const CLIENTS_MODULE = pathToFileURL(resolvePath("dist/auth/clients.js")).href;

/** A plain TCP listener that counts how often anything connects to it. */
async function listener() {
  let connections = 0;
  const server = net.createServer((socket) => {
    connections++;
    socket.destroy();
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return { port: server.address().port, connections: () => connections, close: () => server.close() };
}

/** Resolver that answers each call from a list, repeating the last answer. */
function scriptedResolver(...answers) {
  const calls = [];
  const resolver = async (hostname) => {
    calls.push(hostname);
    return answers[Math.min(calls.length, answers.length) - 1];
  };
  resolver.calls = calls;
  return resolver;
}

const v4 = (address) => ({ address, family: 4 });
const v6 = (address) => ({ address, family: 6 });

test("hostnames that resolve to non-public addresses are refused before any connection", async () => {
  const campus = await listener();
  try {
    const answers = [v4("127.0.0.1"), v4("10.1.2.3"), v4("172.16.0.9"), v4("192.168.1.1"), v4("100.96.86.49"), v4("169.254.169.254"), v4("0.0.0.0"), v6("::1"), v6("fe80::1"), v6("fd00::1"), v6("::ffff:127.0.0.1"), v6("::ffff:7f00:1")];
    for (const answer of answers) {
      const fetcher = new PublicHttpsJsonFetcher(10 * 1024, 2_000, scriptedResolver([answer]));
      await assert.rejects(fetcher.fetchJson(new URL(`https://private.example:${campus.port}/client.json`)), /non-public/, answer.address);
    }
    assert.equal(campus.connections(), 0);
  } finally {
    campus.close();
  }
});

test("one private address among public ones is enough to refuse", async () => {
  const campus = await listener();
  try {
    const fetcher = new PublicHttpsJsonFetcher(10 * 1024, 2_000, scriptedResolver([v4("203.0.113.7"), v4("127.0.0.1")]));
    await assert.rejects(fetcher.fetchJson(new URL(`https://mixed.example:${campus.port}/client.json`)), /non-public/);
    assert.equal(campus.connections(), 0);
  } finally {
    campus.close();
  }
});

test("DNS rebinding: a public answer given earlier doesn't excuse a name that has turned private", async () => {
  const campus = await listener();
  try {
    // A check-then-fetch design would have been shown the public answer, then connected to the private one
    const resolver = scriptedResolver([v4("203.0.113.7")], [v4("127.0.0.1")]);
    await resolver("rebind.example");
    const fetcher = new PublicHttpsJsonFetcher(10 * 1024, 2_000, resolver);
    await assert.rejects(fetcher.fetchJson(new URL(`https://rebind.example:${campus.port}/client.json`)), /non-public/);
    assert.equal(campus.connections(), 0, "the lookup that connects is the one that gets checked");
  } finally {
    campus.close();
  }
});

test("DNS rebinding: the name is looked up once, and only that answer can be connected to", async () => {
  const campus = await listener();
  try {
    // 203.0.113.0/24 is reserved for documentation, so the connection to the public answer goes nowhere
    const resolver = scriptedResolver([v4("203.0.113.7")], [v4("127.0.0.1")]);
    const fetcher = new PublicHttpsJsonFetcher(10 * 1024, 500, resolver);
    await assert.rejects(fetcher.fetchJson(new URL(`https://rebind.example:${campus.port}/client.json`)), (error) => !/non-public/.test(error.message), "it tried the public address and failed to connect");
    assert.equal(resolver.calls.length, 1, "no second lookup that could answer differently");
    assert.equal(campus.connections(), 0);
  } finally {
    campus.close();
  }
});

test("IP addresses in the URL are checked without any lookup; plain http is refused", async () => {
  const campus = await listener();
  try {
    const resolver = scriptedResolver([v4("203.0.113.7")]);
    const fetcher = new PublicHttpsJsonFetcher(10 * 1024, 2_000, resolver);
    for (const host of ["127.0.0.1", "[::1]", "[::ffff:127.0.0.1]", "10.10.32.26", "100.96.86.49", "192.168.1.1", "169.254.169.254"]) {
      await assert.rejects(fetcher.fetchJson(new URL(`https://${host}:${campus.port}/client.json`)), /non-public/, host);
    }
    await assert.rejects(fetcher.fetchJson(new URL(`http://example.com:${campus.port}/client.json`)), /Only https/);
    assert.equal(resolver.calls.length, 0);
    assert.equal(campus.connections(), 0);
  } finally {
    campus.close();
  }
});

// --- the rest of the fetcher's behaviour, against a local HTTPS server ---

const CHILD = `
import { BlockList } from "node:net";
import { PublicHttpsJsonFetcher } from ${JSON.stringify(CLIENTS_MODULE)};
const [port, path, maxBytes, timeoutMs] = process.argv.slice(1);
const fetcher = new PublicHttpsJsonFetcher(Number(maxBytes), Number(timeoutMs), async () => [{ address: "127.0.0.1", family: 4 }]);
fetcher.blocked = new BlockList(); // the test server can only live on loopback
try {
  console.log(JSON.stringify({ document: await fetcher.fetchJson(new URL("https://docs.example:" + port + path)) }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
}
`;

let certDir;
let server;
let port;
let skip;
const requests = [];

before(async () => {
  try {
    certDir = mkdtempSync(join(tmpdir(), "mess-mcp-ssrf-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "2", "-subj", "/CN=docs.example", "-addext", "subjectAltName=DNS:docs.example", "-keyout", join(certDir, "key.pem"), "-out", join(certDir, "cert.pem")], { stdio: "ignore" });
  } catch {
    skip = "openssl isn't available to make a test certificate";
    return;
  }
  server = https.createServer({ key: readFileSync(join(certDir, "key.pem")), cert: readFileSync(join(certDir, "cert.pem")) }, (req, res) => {
    requests.push(req);
    switch (req.url) {
      case "/ok":
        return res.writeHead(200, { "content-type": "application/json" }).end('{"client_id":"https://docs.example/ok"}');
      case "/bom":
        return res.writeHead(200).end('﻿{"bom":true}');
      case "/redirect":
        return res.writeHead(302, { location: "/ok" }).end();
      case "/missing":
        return res.writeHead(404).end("{}");
      case "/declared-big":
        return res.writeHead(200, { "content-length": "20000" }).end("x".repeat(20000));
      case "/streamed-big":
        res.writeHead(200); // chunked, no length to check up front
        for (let i = 0; i < 20; i++) res.write(" ".repeat(1000));
        return res.end("{}");
      case "/gzip":
        return res.writeHead(200, { "content-encoding": "gzip" }).end("{}");
      case "/hangs":
        return res.writeHead(200).write("{"); // never finishes
    }
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  port = server.address().port;
});

after(() => {
  server?.closeAllConnections();
  server?.close();
  if (certDir) rmSync(certDir, { recursive: true, force: true });
});

async function fetchInChild(path, { maxBytes = 10 * 1024, timeoutMs = 3_000 } = {}) {
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", CHILD, String(port), path, String(maxBytes), String(timeoutMs)], {
    env: { ...process.env, NODE_EXTRA_CA_CERTS: join(certDir, "cert.pem") },
  });
  return JSON.parse(stdout);
}

test("a public document is fetched from the address that was checked, with the name's certificate", async (t) => {
  if (skip) return t.skip(skip);
  assert.deepEqual(await fetchInChild("/ok"), { document: { client_id: "https://docs.example/ok" } });
  const request = requests.find((r) => r.url === "/ok");
  assert.equal(request.headers.host, `docs.example:${port}`);
  assert.equal(request.headers.accept, "application/json");
  assert.deepEqual(await fetchInChild("/bom"), { document: { bom: true } }, "a byte order mark is tolerated");
});

test("redirects, errors, encodings, oversized and endless responses are refused", async (t) => {
  if (skip) return t.skip(skip);
  assert.match((await fetchInChild("/redirect")).error, /HTTP 302/);
  assert.match((await fetchInChild("/missing")).error, /HTTP 404/);
  assert.match((await fetchInChild("/gzip")).error, /content-encoding/);
  assert.match((await fetchInChild("/declared-big")).error, /too large/);
  assert.match((await fetchInChild("/streamed-big")).error, /too large/);
  assert.ok((await fetchInChild("/hangs", { timeoutMs: 400 })).error, "the timeout covers the body too");
});
