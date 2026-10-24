// Unit tests for the rules that decide whether the sign-in page recognises an app (auth/known-apps.ts).
// The page is rendered from this result, so a wrong "known" here is what a phisher needs.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isAcceptableRedirectUri, PRIVATE_USE_SCHEMES } from "../dist/auth/clients.js";
import { identifyApp, KNOWN_APPS } from "../dist/auth/known-apps.js";

const UUID = "0b1d3c5e-6c56-4c63-9f43-6d6a5e0c2f10";
const CLAUDE_CODE = "https://claude.ai/oauth/claude-code-client-metadata";
const CURSOR_CALLBACK = "cursor://anysphere.cursor-mcp/oauth/callback";
const unknown = { kind: "unknown" };

test("a redirect to a known app's own site is recognised, whatever the client_id", () => {
  const claude = { kind: "known", name: "Claude" };
  assert.deepEqual(identifyApp(UUID, "https://claude.ai/api/mcp/auth_callback"), claude);
  assert.deepEqual(identifyApp("https://claude.ai/oauth/mcp-oauth-client-metadata", "https://claude.ai/api/mcp/auth_callback"), claude);
  assert.deepEqual(identifyApp(UUID, "https://claude.com/api/mcp/auth_callback"), claude);
  assert.deepEqual(identifyApp(UUID, "https://chatgpt.com/connector_platform_oauth_redirect"), { kind: "known", name: "ChatGPT" });
  assert.deepEqual(identifyApp(UUID, "https://vscode.dev/redirect"), { kind: "known", name: "Visual Studio Code" });
  assert.deepEqual(identifyApp(UUID, "https://CLAUDE.AI/cb?x=1#frag"), claude, "case, query and fragment don't matter: the origin does");
  assert.deepEqual(identifyApp(UUID, "https://claude.ai:443/cb"), claude, "the default port is the same origin");
});

test("lookalike redirects are not recognised", () => {
  for (const redirect of [
    "https://claude.ai.evil.example/cb", // known host as a prefix
    "https://evil.example/claude.ai", // known host in the path
    "https://evil.example/?next=https://claude.ai",
    "https://evilclaude.ai/cb", // known host as a suffix
    "https://not-claude.ai/cb",
    "https://claude.ai@evil.example/cb", // known host as credentials
    "https://claude.ai:evil@evil.example/cb",
    "https://sub.claude.ai/cb", // subdomains are not implied
    "https://www.chatgpt.com/cb",
    "https://claude.ai./cb", // trailing dot
    "https://claude.ai:8443/cb", // another port is another origin
    "http://claude.ai/cb", // web apps must use https
    "https://clаude.ai/cb", // Cyrillic a
    "https://claude.ai%2eevil.example/cb",
    "//claude.ai/cb",
    "claude.ai",
    "javascript://claude.ai/%0aalert(1)",
    "claude://callback",
    "",
  ]) {
    assert.deepEqual(identifyApp(UUID, redirect), unknown, redirect);
  }
});

test("loopback redirects are an app on this computer", () => {
  for (const redirect of ["http://127.0.0.1:7777/callback", "http://localhost/callback", "http://localhost:6274/oauth/callback", "http://[::1]:8080/cb"]) {
    assert.deepEqual(identifyApp(UUID, redirect), { kind: "local", name: undefined }, redirect);
  }
});

test("a lookalike loopback host is not on this computer", () => {
  for (const redirect of ["http://localhost.evil.example/cb", "http://127.0.0.1.evil.example/cb", "http://127.0.0.1@evil.example/cb", "http://evil.example/localhost", "https://localhost/cb", "https://127.0.0.1/cb"]) {
    assert.deepEqual(identifyApp(UUID, redirect), unknown, redirect);
  }
});

test("a known client_id names a loopback app, and only that", () => {
  assert.deepEqual(identifyApp(CLAUDE_CODE, "http://localhost:51234/callback"), { kind: "local", name: "Claude Code" });
  assert.deepEqual(identifyApp("https://vscode.dev/oauth/client-metadata.json", "http://127.0.0.1:33418/"), { kind: "local", name: "Visual Studio Code" });

  assert.deepEqual(identifyApp("https://evil.example/oauth/claude-code-client-metadata", "http://localhost:51234/callback"), { kind: "local", name: undefined }, "same path on another host");
  assert.deepEqual(identifyApp(`${CLAUDE_CODE}/`, "http://localhost:51234/callback"), { kind: "local", name: undefined }, "the id must match exactly");
  assert.deepEqual(identifyApp(CLAUDE_CODE.toUpperCase(), "http://localhost/callback"), { kind: "local", name: undefined });
  assert.deepEqual(identifyApp(UUID, "http://localhost:51234/callback"), { kind: "local", name: undefined }, "a registered client can't claim the name");

  // The id vouches for the app's own redirects, not for wherever the request says to go
  assert.deepEqual(identifyApp(CLAUDE_CODE, "https://evil.example/cb"), unknown);
});

test("the known-app list only holds https origins and exact client ids", () => {
  for (const app of KNOWN_APPS) {
    for (const origin of app.origins) {
      assert.equal(new URL(origin).origin, origin, `${app.name}: ${origin} is a bare origin`);
      assert.equal(new URL(origin).protocol, "https:", `${app.name}: ${origin}`);
    }
    for (const id of app.clientIds) assert.equal(new URL(id).protocol, "https:", `${app.name}: ${id}`);
  }
});

test("a redirect to Cursor's own scheme is Cursor on this computer, whatever the client_id", () => {
  const cursor = { kind: "local", name: "Cursor" };
  assert.deepEqual(identifyApp(UUID, CURSOR_CALLBACK), cursor);
  assert.deepEqual(identifyApp(UUID, "CURSOR://anysphere.cursor-mcp/oauth/callback?x=1"), cursor, "the scheme isn't case sensitive");
  assert.deepEqual(identifyApp(UUID, "cursor://anysphere.cursor-retrieval/oauth/callback"), cursor, "nor does the app id after it matter");
  // Unlike a loopback port, the scheme is what names the app, so no client_id is needed (or consulted)
  assert.deepEqual(identifyApp(CLAUDE_CODE, CURSOR_CALLBACK), cursor);
  assert.deepEqual(identifyApp("https://evil.example/client.json", CURSOR_CALLBACK), cursor);
});

test("Cursor's web callback is Cursor's own site", () => {
  assert.deepEqual(identifyApp(UUID, "https://www.cursor.com/agents/mcp/oauth/callback"), { kind: "known", name: "Cursor" });
});

test("lookalikes of Cursor's redirects are not recognised", () => {
  for (const redirect of [
    "https://cursor.com.evil.example/cb",
    "https://www.cursor.com.evil.example/cb",
    "https://evil.example/www.cursor.com",
    "https://www.cursor.com@evil.example/cb",
    "https://sub.www.cursor.com/cb", // subdomains are not implied
    "https://cursor.com/cb", // only the listed origin
    "http://www.cursor.com/cb",
    "https://www.cursor.com:8443/cb",
    "cursor:oauth/callback", // not in scheme://app-id form
    "cursor:///oauth/callback",
    "cursor://user@anysphere.cursor-mcp/oauth/callback",
    "cursors://anysphere.cursor-mcp/oauth/callback", // another scheme
    "xcursor://anysphere.cursor-mcp/oauth/callback",
    "cursor-mcp://anysphere.cursor-mcp/oauth/callback",
    "cursor.evil://anysphere.cursor-mcp/oauth/callback",
    "vscode://vscode.github-authentication/did-authenticate", // another app's scheme, not listed
  ]) {
    assert.deepEqual(identifyApp(UUID, redirect), unknown, redirect);
  }
});

test("private-use schemes are recognised exactly where clients.ts accepts them", () => {
  const listed = KNOWN_APPS.flatMap((app) => app.schemes);
  assert.deepEqual([...listed].sort(), [...PRIVATE_USE_SCHEMES].sort(), "the two lists name the same schemes");
  assert.equal(new Set(listed).size, listed.length, "and no scheme belongs to two apps");

  for (const scheme of listed) {
    assert.match(scheme, /^[a-z][a-z0-9+.-]*:$/, `${scheme} is a lowercase scheme with its colon`);
    assert.ok(!["http:", "https:", "javascript:", "data:", "file:", "vbscript:", "blob:", "about:", "ftp:", "ws:", "wss:"].includes(scheme), `${scheme} must not be a web or script scheme`);
    const redirect = `${scheme}//some.app-id/callback`;
    assert.equal(isAcceptableRedirectUri(redirect), true, redirect);
    assert.equal(identifyApp(UUID, redirect).kind, "local", redirect);
  }
});
