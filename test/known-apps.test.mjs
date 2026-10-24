// Unit tests for the rules that decide whether the sign-in page recognises an app (auth/known-apps.ts).
// The page is rendered from this result, so a wrong "known" here is what a phisher needs.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { identifyApp, KNOWN_APPS } from "../dist/auth/known-apps.js";

const UUID = "0b1d3c5e-6c56-4c63-9f43-6d6a5e0c2f10";
const CLAUDE_CODE = "https://claude.ai/oauth/claude-code-client-metadata";
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
