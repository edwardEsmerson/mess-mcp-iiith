// HTML for GET /: what this is and how to connect it, for students who aren't technical. Rendering only.
// The one script is a copy button. Without JavaScript the button stays hidden and the URL is still
// select-all on click, so the page works either way.

import { escapeHtml } from "../auth/pages.js";
import { REFRESH_TOKEN_LIFETIME } from "./facts.js";
import { DINING_URL, layout } from "./layout.js";

export const VIDEO_URL = "https://youtu.be/A3CGL5TJSxs";

export interface LandingPage {
  /** The MCP endpoint apps connect to, e.g. https://iiith-mess-mcp.tech/mcp. */
  connectorUrl: string;
}

/** The text between the script tags. The page's CSP allows exactly this text (see pageHeaders), so it must not change per request. */
export const LANDING_SCRIPT = `
const url = document.getElementById("connector-url");
const copy = document.getElementById("copy");
const status = document.getElementById("copy-status");
copy.hidden = false;
copy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(url.textContent);
    status.textContent = "Copied.";
  } catch {
    const range = document.createRange();
    range.selectNodeContents(url);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    status.textContent = "Selected. Press Ctrl+C (or long-press) to copy it.";
  }
});
`;

export function renderLanding(page: LandingPage): string {
  const url = escapeHtml(page.connectorUrl);
  return layout({
    title: "IIITH Mess for Claude, ChatGPT and other apps",
    description: "Connect your IIIT Hyderabad dining account to Claude, ChatGPT or another app, then check menus, change your mess, cancel meals and see your bill by chatting.",
    current: "home",
    body: `
<header>
  <h1>Manage your IIITH mess by chatting</h1>
  <p class="lede">Connect your dining account to Claude, ChatGPT or another app that supports connectors. Then just ask it to check menus, change your mess, cancel meals or show your bill.</p>
  <ul class="examples">
    <li>"What's for dinner at Kadamba tonight?"</li>
    <li>"Cancel my lunch on Friday and register me at Yuktahar for dinner instead."</li>
    <li>"How much is my mess bill this month?"</li>
  </ul>
  <p><a class="button" href="${VIDEO_URL}" target="_blank" rel="noopener noreferrer">Watch the video guide</a> <span class="fine">Opens YouTube.</span></p>
</header>

<section>
  <h2>1. Get a dining key</h2>
  <ol>
    <li>Open <a href="${DINING_URL}" target="_blank" rel="noopener noreferrer">dining.iiit.ac.in</a> and go to Settings → Auth Keys.</li>
    <li>Press <strong>Create</strong>. Make a new key just for this, so you can delete it later without affecting anything else.</li>
    <li>Keep it handy. Your app will send you to a sign-in page on this server where you paste it once.</li>
  </ol>
  <p class="warn">Treat the key like a password: anyone with it can register, cancel and change meals on your account. Paste it only on the sign-in page your app opens, never into the chat.</p>
</section>

<section>
  <h2>2. Add the connector to your app</h2>
  <p>Every app asks for this address.</p>
  <div class="url">
    <code id="connector-url">${url}</code>
    <button type="button" id="copy" class="primary" hidden>Copy</button>
  </div>
  <p class="fine" id="copy-status" role="status"></p>

  <details open>
    <summary>Claude (claude.ai and the desktop app)</summary>
    <div class="steps">
      <ol>
        <li>Open Settings → Connectors.</li>
        <li>Choose <strong>Add custom connector</strong>. Name it "IIITH Mess" and paste the address above.</li>
        <li>Click <strong>Add</strong>, then <strong>Connect</strong>.</li>
        <li>A sign-in page from this server opens. Paste your dining key and press <strong>Connect</strong>.</li>
        <li>Start a new chat and ask about your meals.</li>
      </ol>
      <p class="fine">It also works in the Claude mobile app. If you can't find Add custom connector on your phone, add it from a computer first.</p>
    </div>
  </details>

  <details>
    <summary>ChatGPT</summary>
    <div class="steps">
      <ol>
        <li>On the ChatGPT website, open Settings → Apps (called Connectors in some versions) → Advanced settings, and turn on <strong>Developer mode</strong>.</li>
        <li>Go back and choose <strong>Create</strong>. Name it "IIITH Mess", paste the address above, and if it asks for authentication choose OAuth. Tick the box saying you trust this app, then create it.</li>
        <li>A sign-in page from this server opens. Paste your dining key and press <strong>Connect</strong>.</li>
        <li>In a new chat, use the + button under the message box to turn on IIITH Mess.</li>
      </ol>
      <p class="fine">ChatGPT changes these menus often, and custom connectors need a plan that includes developer mode, so names may differ. OpenAI's help pages have the current steps.</p>
    </div>
  </details>

  <details>
    <summary>Claude Code</summary>
    <div class="steps">
      <ol>
        <li>Run this in a terminal:
<pre><code>claude mcp add --transport http mess ${url} -s user</code></pre></li>
        <li>Start Claude Code, type <code>/mcp</code> and pick <strong>mess</strong>.</li>
        <li>Choose to sign in. A page from this server opens in your browser: paste your dining key and press <strong>Connect</strong>.</li>
      </ol>
    </div>
  </details>

  <details>
    <summary>Cursor, VS Code and other apps</summary>
    <div class="steps">
      <p>Add a remote MCP server (sometimes called HTTP or Streamable HTTP) with the address above. It needs no other settings. When the app asks you to sign in or authorise, paste your dining key on the page that opens.</p>
      <p>For Cursor, put this in <code>~/.cursor/mcp.json</code>:</p>
      <pre><code>{ "mcpServers": { "mess": { "url": "${url}" } } }</code></pre>
      <p>For VS Code, put this in <code>.vscode/mcp.json</code>:</p>
      <pre><code>{ "servers": { "mess": { "type": "http", "url": "${url}" } } }</code></pre>
    </div>
  </details>
</section>

<section>
  <h2>What happens to your key</h2>
  <p>You paste it once, on a page served by this server. The server stores it encrypted and uses it only to talk to the mess portal for you. It doesn't save what you ask or what the portal answers.</p>
  <p>Whoever runs the server could technically read the stored key, so use a key made just for this and delete it when you're done. <a href="/privacy">Read the privacy details</a>.</p>
  <p>Your app can register and cancel meals for you. Registrations are added to your bill and cancellations count toward your monthly limit, so read what it plans to do before you say yes.</p>
</section>

<section>
  <h2>Disconnecting</h2>
  <ol>
    <li>Remove the connector in your app's connector settings.</li>
    <li>Delete the key on <a href="${DINING_URL}" target="_blank" rel="noopener noreferrer">dining.iiit.ac.in</a> under Settings → Auth Keys. The key stops working everywhere straight away, including the copy stored on this server.</li>
  </ol>
  <p>The server deletes its own copy when your app tells it you disconnected (not every app does), the next time anything uses the key after the portal has stopped accepting it, or automatically about ${REFRESH_TOKEN_LIFETIME} after your app last connected. <a href="/privacy#delete">More on deleting your data</a>.</p>
</section>

<script>${LANDING_SCRIPT}</script>`,
  });
}
