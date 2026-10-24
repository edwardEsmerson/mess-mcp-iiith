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
// Loopback redirects (http://localhost, 127.0.0.1, [::1]) stay on the student's own computer. So do
// redirects to a private-use scheme such as cursor:// (RFC 8252 section 7.1): the browser hands the URI to
// whichever app on that device registered the scheme, so the code never travels to a server someone else
// runs, and PKCE makes it useless to any other local program that gets hold of it. Unlike a loopback port,
// which any program can open, a scheme is claimed per app, so on a normal install it does say which app
// receives the code, and the page names it. That is why a listed scheme needs no client_id to be named:
// a phisher who registers a cursor:// redirect gets nothing, because the code goes to the student's own Cursor.
// The schemes listed here must be the ones clients.ts accepts (PRIVATE_USE_SCHEMES); a unit test keeps
// the two lists in step.
// Everything else, including every app registered through /register, is unrecognised.

import { isLoopbackHost, isPrivateUseRedirect } from "./clients.js";

export interface KnownApp {
  name: string;
  /** Client ID Metadata Document URLs the app publishes. Only needed for apps that redirect to a loopback address. */
  clientIds: string[];
  /** Origins its web callback pages live on. */
  origins: string[];
  /** Private-use URI schemes (with the colon) the app registers with the operating system and redirects to. */
  schemes: string[];
}

export const KNOWN_APPS: KnownApp[] = [
  { name: "Claude", clientIds: [], origins: ["https://claude.ai", "https://claude.com"], schemes: [] },
  { name: "ChatGPT", clientIds: [], origins: ["https://chatgpt.com"], schemes: [] },
  { name: "Claude Code", clientIds: ["https://claude.ai/oauth/claude-code-client-metadata"], origins: [], schemes: [] },
  { name: "Visual Studio Code", clientIds: ["https://vscode.dev/oauth/client-metadata.json"], origins: ["https://vscode.dev", "https://insiders.vscode.dev"], schemes: [] },
  // The desktop app redirects to cursor://anysphere.cursor-mcp/oauth/callback or http://localhost:8787/callback, cloud agents to the web address
  { name: "Cursor", clientIds: [], origins: ["https://www.cursor.com"], schemes: ["cursor:"] },
];

export type AppIdentity =
  /** A web app we recognise; the code goes to its own site. */
  | { kind: "known"; name: string }
  /** The code goes to a loopback address or an app's own URI scheme, so only this computer gets it. `name` is set when the client_id or the scheme is a known app's. */
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
  if (isPrivateUseRedirect(redirect)) {
    return { kind: "local", name: KNOWN_APPS.find((app) => app.schemes.includes(redirect.protocol))?.name };
  }
  return { kind: "unknown" };
}
