// HTML for the authorization page. Rendering only: no request handling or validation here.

export interface ConsentPage {
  clientName: string;
  redirectHost: string;
  loopbackOnly: boolean;
  signedRequest: string;
  error?: string;
}

/** Served by the authorize router; the page's CSP allows fonts from 'self' only. */
export const FONT_PATH = "/authorize/font.woff2";

// One left-aligned column: the request as the headline, what it allows, how to get a key, the key field.
// Atkinson Hyperlegible is the only face: the page's job is reading permissions and copying a key.
const STYLE = `
@font-face { font-family: "Atkinson Hyperlegible Next"; font-weight: 200 800; font-display: swap; src: url(${FONT_PATH}) format("woff2"); }
:root {
  --bg: #f4f6f5; --fg: #14201a; --muted: #55635c; --line: #d6dfda; --field: #fff;
  --accent: #17694a; --on-accent: #fff; --danger: #b42318; --warn-bg: #fbf1d3; --warn-fg: #4f3b00;
  --font: "Atkinson Hyperlegible Next", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #18201d; --fg: #e4ece8; --muted: #9aa8a1; --line: #303b36; --field: #1f2925;
    --accent: #86c4a5; --on-accent: #10261c; --danger: #ff9b8d; --warn-bg: #352d14; --warn-fg: #f0d88f; color-scheme: dark; }
}
* { box-sizing: border-box; }
body { margin: 0; padding: 10vh 20px 48px; background: var(--bg); color: var(--fg); font: 16px/1.5 var(--font); }
main { max-width: 440px; margin: 0 auto; display: flex; flex-direction: column; gap: 32px; }
section { display: flex; flex-direction: column; gap: 12px; }
h1 { margin: 0 0 4px; font-size: 30px; line-height: 1.15; font-weight: 720; letter-spacing: -.02em; text-wrap: balance; overflow-wrap: anywhere; }
h2 { margin: 0; font-size: 16px; font-weight: 700; }
p { margin: 0; color: var(--muted); }
strong { color: var(--fg); font-weight: 650; }
a { color: var(--accent); text-underline-offset: 2px; }
.scope { padding: 14px 16px; border: 1px solid var(--line); border-radius: 8px; }
.scope dl { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; }
.scope dt { font-weight: 650; }
.scope dd { margin: 0; color: var(--muted); min-width: 0; }
.scope p { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); font-size: 14px; }
.warn { padding: 10px 14px; border-radius: 8px; background: var(--warn-bg); color: var(--warn-fg); }
ol { margin: 0; padding-left: 1.3em; color: var(--muted); display: flex; flex-direction: column; gap: 4px; }
li::marker { color: var(--fg); font-weight: 650; }
form { display: flex; flex-direction: column; gap: 8px; }
label { font-weight: 700; }
input[type=password] { width: 100%; padding: 11px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--field); color: var(--fg);
  font: 16px/1.4 var(--font); letter-spacing: .1em; transition: border-color .15s, box-shadow .15s; }
input[type=password]:hover { border-color: var(--muted); }
input[type=password]:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent); }
input[aria-invalid=true] { border-color: var(--danger); }
.error { color: var(--danger); }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
button { padding: 10px 20px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: var(--fg); font: 700 15px/1.2 var(--font); cursor: pointer; }
button:hover { border-color: var(--muted); }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
button.primary:hover { background: color-mix(in srgb, var(--accent) 88%, var(--fg)); }
button:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.fine { font-size: 14px; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

export function renderConsentPage(page: ConsentPage): string {
  const name = escapeHtml(page.clientName);
  const host = escapeHtml(page.redirectHost);
  return layout(
    "Connect IIITH Mess",
    `
<section>
  <h1>${name} wants to use your mess account</h1>
  <p>This connects it to your IIIT Hyderabad dining account. When you're done, you'll go back to <strong>${host}</strong>.</p>
  <div class="scope">
    <dl>
      <dt>Can see</dt><dd>Menus, your registrations, bills and preferences</dd>
      <dt>Can change</dt><dd>Meal registrations and cancellations, extras, preferences and your QR code</dd>
    </dl>
    <p>Registrations are added to your bill, and cancellations count toward your monthly limit.</p>
  </div>
  ${page.loopbackOnly ? `<p class="warn">This app runs on your own computer. Only continue if you started this connection yourself.</p>` : ""}
</section>
<section>
  <h2>Get a key</h2>
  <ol>
    <li>Open <a href="https://dining.iiit.ac.in" target="_blank" rel="noopener noreferrer">dining.iiit.ac.in</a> and go to Settings → Auth Keys.</li>
    <li>Create a new key just for this, so you can delete it later without affecting anything else.</li>
    <li>Paste it below.</li>
  </ol>
</section>
<form method="post" action="/authorize" autocomplete="off">
  <input type="hidden" name="request" value="${escapeHtml(page.signedRequest)}">
  <label for="dining_key">Dining auth key</label>
  <input type="password" id="dining_key" name="dining_key" autofocus spellcheck="false"${page.error ? ` aria-invalid="true" aria-describedby="key_error"` : ""}>
  ${page.error ? `<p class="error" id="key_error" role="alert">${escapeHtml(page.error)}</p>` : ""}
  <!-- Connect comes first so pressing Enter approves -->
  <div class="actions">
    <button type="submit" name="action" value="approve" class="primary">Connect</button>
    <button type="submit" name="action" value="deny">Cancel</button>
  </div>
</form>
<p class="fine">The key is stored encrypted on this server and used only to call the mess portal for you. To disconnect, delete the key on dining.iiit.ac.in.</p>`,
  );
}

export function renderErrorPage(message: string): string {
  return layout(
    "Can't connect",
    `<section><h1>Can't connect</h1><p class="error">${escapeHtml(message)}</p><p>Go back to the app you came from and try connecting again.</p></section>`,
  );
}
