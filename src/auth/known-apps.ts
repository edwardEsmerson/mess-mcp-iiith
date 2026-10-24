// Which app is asking to connect, judged only by facts this server can check. The sign-in page
// headlines the result, so a student pasting their key sees who would really get access.
//
// An app's own name (client_name in its metadata document or /register) is free text: anyone can host
// a document called "Claude" and send students a link to /authorize. It never decides what the page
// says. What can be trusted instead:
//  - The redirect URI. The authorization code is delivered there, so its origin is who gets access.
//    An https redirect to exactly a known app's origin means the code goes to that app, whatever the
//    client calls itself. An impostor redirecting to claude.ai only hands the code to Claude.
//  - For metadata-document (CIMD) clients, the client_id URL. We fetched the document from that exact
//    https URL, so only its operator decides who the app is and where it redirects. This recognises
//    native apps, whose loopback redirect says nothing about which app it is. /register only issues
//    UUIDs, so an app registered there can never hold one of these ids.
//
// Matching is exact: the whole origin of the parsed redirect URI (https, the host spelled out, the default
// port), or the whole client_id string. claude.ai.evil.example, evilclaude.ai, claude.ai@evil.example,
// sub.claude.ai, http://claude.ai and claude.ai:8443 are all different origins. Subdomains are not
// included implicitly: list a host only when it belongs to the app's operator.
//
// Loopback redirects (http://localhost, 127.0.0.1, [::1]) stay on the student's own computer.
// Everything else, including every app registered through /register, is unrecognised.

import { isLoopbackHost } from "./clients.js";

export interface KnownApp {
  name: string;
  /** Client ID Metadata Document URLs the app publishes. Only needed for apps that redirect to a loopback address. */
  clientIds: string[];
  /** Origins its web callback pages live on. */
  origins: string[];
}

export const KNOWN_APPS: KnownApp[] = [
  { name: "Claude", clientIds: [], origins: ["https://claude.ai", "https://claude.com"] },
  { name: "ChatGPT", clientIds: [], origins: ["https://chatgpt.com"] },
  { name: "Claude Code", clientIds: ["https://claude.ai/oauth/claude-code-client-metadata"], origins: [] },
  { name: "Visual Studio Code", clientIds: ["https://vscode.dev/oauth/client-metadata.json"], origins: ["https://vscode.dev", "https://insiders.vscode.dev"] },
];

export type AppIdentity =
  /** A web app we recognise; the code goes to its own site. */
  | { kind: "known"; name: string }
  /** The code goes to a loopback address, so only this computer gets it. `name` is set when the client_id is a known app's. */
  | { kind: "local"; name?: string }
  /** The code goes to a site we don't know. */
  | { kind: "unknown" };

export function identifyApp(clientId: string, redirectUri: string): AppIdentity {
  let redirect: URL;
  try {
    redirect = new URL(redirectUri);
  } catch {
    return { kind: "unknown" };
  }

  const web = KNOWN_APPS.find((app) => app.origins.includes(redirect.origin));
  if (web) return { kind: "known", name: web.name };

  if (redirect.protocol === "http:" && isLoopbackHost(redirect.hostname)) {
    return { kind: "local", name: KNOWN_APPS.find((app) => app.clientIds.includes(clientId))?.name };
  }
  return { kind: "unknown" };
}
