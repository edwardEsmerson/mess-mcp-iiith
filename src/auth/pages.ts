// HTML for the authorization page. Rendering only: no request handling or validation here.

export interface ConsentPage {
  clientName: string;
  redirectHost: string;
  loopbackOnly: boolean;
  signedRequest: string;
  error?: string;
}

const STYLE = `
:root { --bg: #f6f7f9; --card: #fff; --text: #1b1f24; --muted: #5b6470; --accent: #2457d6; --border: #d9dde3; --danger: #b42318; --warn-bg: #fff6e0; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #111418; --card: #1a1f25; --text: #e8eaed; --muted: #9aa3ad; --accent: #7aa2ff; --border: #2c333b; --danger: #ff8a80; --warn-bg: #2d2617; }
}
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--text);
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { width: 100%; max-width: 440px; background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 28px; }
h1 { font-size: 1.3rem; margin: 0 0 8px; }
p, li { color: var(--muted); }
strong { color: var(--text); }
ol { padding-left: 20px; }
label { display: block; font-weight: 600; margin: 16px 0 6px; }
input[type=password] { width: 100%; padding: 10px 12px; font: inherit; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text); }
.actions { display: flex; flex-direction: row-reverse; gap: 10px; margin-top: 20px; }
button { flex: 1; padding: 10px; font: inherit; font-weight: 600; border-radius: 8px; cursor: pointer; border: 1px solid var(--border); background: transparent; color: var(--text); }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.error { color: var(--danger); font-weight: 600; }
.warn { background: var(--warn-bg); padding: 10px 12px; border-radius: 8px; color: var(--text); }
a { color: var(--accent); }
`;

function escapeHtml(value: string): string {
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
<h1>Connect your mess account</h1>
<p><strong>${name}</strong> wants to manage your IIIT Hyderabad mess account: view menus and bills, and register, cancel or change meals on your behalf.</p>
<p>After you approve, you'll be sent to <strong>${host}</strong>.</p>
${page.loopbackOnly ? `<p class="warn">This app runs on your own computer. Only continue if you started this connection yourself.</p>` : ""}
<ol>
  <li>Open <a href="https://dining.iiit.ac.in" target="_blank" rel="noopener noreferrer">dining.iiit.ac.in</a> → Settings → Auth Keys.</li>
  <li>Create a key just for this, so you can revoke it later without affecting anything else.</li>
  <li>Paste it below.</li>
</ol>
<form method="post" action="/authorize" autocomplete="off">
  <input type="hidden" name="request" value="${escapeHtml(page.signedRequest)}">
  <label for="dining_key">Dining auth key</label>
  <input type="password" id="dining_key" name="dining_key" autofocus spellcheck="false">
  ${page.error ? `<p class="error" role="alert">${escapeHtml(page.error)}</p>` : ""}
  <!-- Connect comes first so pressing Enter approves; row-reverse puts it on the right -->
  <div class="actions">
    <button type="submit" name="action" value="approve" class="primary">Connect</button>
    <button type="submit" name="action" value="deny">Cancel</button>
  </div>
</form>
<p>Your key is stored encrypted on this server and only used to call the mess portal for you.</p>`,
  );
}

export function renderErrorPage(message: string): string {
  return layout("Can't connect", `<h1>Can't connect</h1><p class="error">${escapeHtml(message)}</p><p>Go back to the app you came from and try connecting again.</p>`);
}
