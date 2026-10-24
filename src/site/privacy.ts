// HTML for GET /privacy. Rendering only. Every claim here is read off the code:
//   keys sealed with AES-256-GCM, tokens and codes stored as SHA-256 hashes ... auth/crypto.ts, auth/grants.ts, auth/tokens.ts
//   tables, what each row holds, when rows are deleted ... auth/sqlite.ts, auth/revoke-on-unauthorized.ts
//   usage statistics (only with DASHBOARD_PASSWORD) ... metrics/recorder.ts, metrics/sqlite.ts
// Change the code's behaviour and this page needs the same change.

import { escapeHtml } from "../auth/pages.js";
import { ACCESS_TOKEN_LIFETIME, ACTIVE_LIST_RETENTION, CODE_LIFETIME, REFRESH_TOKEN_LIFETIME } from "./facts.js";
import { DINING_URL, GITHUB_URL, layout } from "./layout.js";

export interface PrivacyPage {
  /** Whether this server records usage statistics (the operator set DASHBOARD_PASSWORD). */
  metricsEnabled: boolean;
  /** The operator's own description of how the server is hosted (HOSTING_NOTE). Plain text. */
  hostingNote?: string;
}

export function renderPrivacy(page: PrivacyPage): string {
  const statistics = page.metricsEnabled
    ? `<li><strong>Usage statistics (turned on for this server).</strong> Daily totals only: how many times each tool was used and how often it failed, how many sign-ins worked or failed, and how many connections were ended because the portal rejected a key. To count active users it also keeps a list of which connection IDs made a request on each day. Those IDs are random and aren't tied to your name or roll number.</li>`
    : `<li><strong>Usage statistics (turned off for this server).</strong> This server doesn't count or record how it is used.</li>`;
  const statisticsRetention = page.metricsEnabled
    ? `<li><strong>Usage statistics:</strong> the daily lists of connection IDs are deleted after ${ACTIVE_LIST_RETENTION}, and the daily totals after a little over a year.</li>`
    : "";

  const hosting = page.hostingNote
    ? `
<section>
  <h2>How this server is hosted</h2>
  <p>The person running this server describes its setup like this:</p>
  <blockquote><p>${escapeHtml(page.hostingNote)}</p></blockquote>
</section>`
    : "";
  const hostingMissing = page.hostingNote ? "" : `<p>The person running this server hasn't described its setup here. Ask them if you need to know.</p>`;

  return layout({
    title: "Privacy - IIITH Mess",
    description: "What the IIITH Mess connector stores about you, who can see it, and how to delete it.",
    current: "privacy",
    body: `
<header>
  <h1>Privacy</h1>
  <p class="lede">What the IIITH Mess connector keeps about you, who can see it, and how to remove it. This is an unofficial student project, not an IIIT Hyderabad service.</p>
</header>

<section>
  <h2>The short version</h2>
  <ul>
    <li>You give this server one secret: your dining auth key. It keeps the key encrypted and uses it only to call the mess portal for you.</li>
    <li>It doesn't save your menus, registrations, bills, name or roll number, or anything you ask your app.</li>
    <li>Whoever runs this server can technically decrypt your key. Only connect if you trust them.</li>
    <li>You can end the connection yourself at any time. See <a href="#delete">Deleting your data</a>.</li>
  </ul>
</section>

<section>
  <h2>What this server stores</h2>
  <ul>
    <li><strong>Your dining key, encrypted.</strong> It is sealed with AES-256-GCM, using a key derived from a secret in the server's configuration (the secret is not in the database). It is saved with a random connection ID, which app you connected from, and when. To call the portal for you, the server decrypts it in memory for each request.</li>
    <li><strong>Fingerprints of sign-in codes and tokens.</strong> When an app connects it gets a one-time code, then an access token and a refresh token. The server keeps only a SHA-256 hash of each, with the connection ID and when it expires. Reading the database doesn't reveal the tokens themselves.</li>
    <li><strong>App registrations.</strong> Some apps register themselves with the server before they connect. The server saves the app's name, a random ID and its return addresses. This is about the app, not about you.</li>
    ${statistics}
  </ul>
</section>

<section>
  <h2>What it does not store</h2>
  <ul>
    <li>What you ask your app, and what the tools send or return (menus, registrations, bills, preferences). These pass through the server's memory on their way between your app and the portal. They are not saved.</li>
    <li>Your name or roll number. When you sign in, the server asks the portal whether the key works and throws the answer away.</li>
    <li>Keys or tokens in logs. The server keeps no request log. It writes only start-up lines and short error messages, never keys, tokens or what you asked for.</li>
    <li>Network addresses. They are held briefly in memory to slow down abuse and are not saved.</li>
  </ul>
  <p class="fine">Anything in front of the server, such as a proxy, may keep its own logs. See below.</p>
</section>

<section>
  <h2>How long things are kept</h2>
  <ul>
    <li><strong>Sign-in codes</strong> last ${CODE_LIFETIME}. <strong>Access tokens</strong> last ${ACCESS_TOKEN_LIFETIME}. <strong>Refresh tokens</strong> last ${REFRESH_TOKEN_LIFETIME}; your app gets a new one each time it uses one, so the clock restarts whenever your app connects. Expired tokens are cleaned up hourly.</li>
    <li><strong>Your encrypted key</strong> is kept until the connection ends. That happens when your app tells the server you disconnected, when the portal rejects the key and your app next uses the connector, if an old refresh token is used again more than 30 seconds after it was replaced (a sign it was copied), or automatically once your app hasn't connected for ${REFRESH_TOKEN_LIFETIME} and its last token has expired. A sign-in that was never finished is removed within a couple of hours.</li>
    <li><strong>App registrations</strong> stay until the person running the server removes them.</li>
    ${statisticsRetention}
    <li><strong>Backups:</strong> the person running the server may back up its database. A backup made before you disconnected still holds your encrypted key. If you have deleted the key on the dining portal, that copy no longer works.</li>
  </ul>
</section>

<section>
  <h2>Who can see your key</h2>
  <p>The server has to decrypt your key to use it, so whoever runs it can do the same: they control the secret and the code. They could read your key, or use it to see your bill, registrations and preferences and to register, cancel and change meals on your account. You can't check this from outside. The source code is public on GitHub, but that doesn't show what code a particular server is running.</p>
  <p><strong>Only connect if you trust whoever runs this server.</strong> Make a key just for this, and delete it on the dining portal when you're done.</p>
</section>

<section>
  <h2>Where it runs, and who can see the traffic</h2>
  <p>The mess portal can only be reached from the IIIT Hyderabad network, so a server like this runs on a machine on campus. Apps such as claude.ai connect over the internet, so the server is made reachable through a relay. What the relay can see depends on how it works:</p>
  <ul>
    <li>A tunnel that only passes encrypted traffic along, such as Tailscale Funnel, can't read it. The connection is decrypted on the server itself.</li>
    <li>A proxy that ends the secure connection itself, such as Cloudflare, can see everything that passes through, including the dining key you paste on the sign-in page and the portal's answers.</li>
  </ul>
  ${hostingMissing}
</section>
${hosting}
<section>
  <h2>The mess portal and your app</h2>
  <p>The dining portal is run by the institute. It sees every request this server makes with your key, and what it logs or keeps is outside this server's control. Those requests come from the server's address, not from your device.</p>
  <p>Your app (Claude, ChatGPT, Cursor and so on) receives everything the tools return, such as menus and bills, and handles it under its own privacy policy.</p>
</section>

<section id="delete">
  <h2>Deleting your data</h2>
  <ol>
    <li>Remove the connector in your app.</li>
    <li>Delete the key on <a href="${DINING_URL}" target="_blank" rel="noopener noreferrer">dining.iiit.ac.in</a> under Settings → Auth Keys. This is the step that matters most: it makes every copy of the key useless straight away, including any in backups.</li>
  </ol>
  <p>The server deletes its own copy when your app tells it you disconnected (not every app does), the next time anything uses the key after the portal has stopped accepting it, or automatically about ${REFRESH_TOKEN_LIFETIME} after your app last connected. There is no account on this server to delete, and no way to see or export what it holds. To have your connection removed sooner, ask whoever runs the server.</p>
</section>

<section>
  <h2>Questions</h2>
  <p>If something here is unclear or looks wrong, <a href="${GITHUB_URL}/issues" target="_blank" rel="noopener noreferrer">open an issue on GitHub</a>. <strong>Never paste your dining key or any token into an issue</strong>, or anywhere else public. For questions about a particular server, ask whoever runs it.</p>
</section>`,
  });
}
