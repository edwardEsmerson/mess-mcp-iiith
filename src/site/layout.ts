// Shared frame for the public pages (landing, privacy). Rendering only, no request handling.
// The look follows the sign-in page (auth/pages.ts): same font and colour tokens, with a wider column for reading.
// Nothing is loaded from other origins; the font is the one the sign-in page already serves.

import { createHash } from "node:crypto";
import { escapeHtml, FONT_PATH } from "../auth/pages.js";

export const GITHUB_URL = "https://github.com/edwardEsmerson/mess-mcp-iiith";
export const DINING_URL = "https://dining.iiit.ac.in";

const STYLE = `
@font-face { font-family: "Atkinson Hyperlegible Next"; font-weight: 200 800; font-display: swap; src: url(${FONT_PATH}) format("woff2"); }
:root {
  --bg: #f4f6f5; --fg: #14201a; --muted: #55635c; --line: #d6dfda; --field: #fff;
  --accent: #17694a; --on-accent: #fff; --warn-bg: #fbf1d3; --warn-fg: #4f3b00;
  --font: "Atkinson Hyperlegible Next", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #18201d; --fg: #e4ece8; --muted: #9aa8a1; --line: #303b36; --field: #1f2925;
    --accent: #86c4a5; --on-accent: #10261c; --warn-bg: #352d14; --warn-fg: #f0d88f; color-scheme: dark; }
}
* { box-sizing: border-box; }
body { margin: 0; padding: 8vh 20px 48px; background: var(--bg); color: var(--fg); font: 16px/1.55 var(--font); }
main { max-width: 640px; margin: 0 auto; display: flex; flex-direction: column; gap: 36px; }
header, section { display: flex; flex-direction: column; gap: 12px; }
h1 { margin: 0; font-size: 32px; line-height: 1.15; font-weight: 720; letter-spacing: -.02em; text-wrap: balance; }
h2 { margin: 0; font-size: 20px; line-height: 1.3; font-weight: 700; }
p { margin: 0; }
strong { font-weight: 650; }
a { color: var(--accent); text-underline-offset: 2px; }
a:focus-visible, button:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.lede { font-size: 18px; }
.fine { font-size: 14px; color: var(--muted); }
.warn { padding: 10px 14px; border-radius: 8px; background: var(--warn-bg); color: var(--warn-fg); }
ol, ul { margin: 0; padding-left: 1.3em; display: flex; flex-direction: column; gap: 6px; }
li::marker { color: var(--fg); font-weight: 650; }
.examples { list-style: none; padding: 0; gap: 8px; }
.examples li { padding: 2px 0 2px 14px; border-left: 3px solid var(--accent); color: var(--muted); }
code, pre { font: 14px/1.5 var(--mono); }
.url { display: flex; flex-wrap: wrap; align-items: stretch; gap: 8px; }
.url code { flex: 1 1 260px; min-width: 0; padding: 11px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--field);
  font-size: 15px; overflow-wrap: anywhere; -webkit-user-select: all; user-select: all; }
pre { margin: 0; padding: 12px 14px; border: 1px solid var(--line); border-radius: 6px; background: var(--field); overflow-x: auto; }
button, .button { display: inline-block; padding: 10px 20px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: var(--fg);
  font: 700 15px/1.2 var(--font); text-decoration: none; cursor: pointer; }
button:hover, .button:hover { border-color: var(--muted); }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
button.primary:hover { background: color-mix(in srgb, var(--accent) 88%, var(--fg)); }
button[hidden] { display: none; }
details { border: 1px solid var(--line); border-radius: 8px; }
summary { padding: 12px 16px; font-weight: 700; cursor: pointer; }
details[open] summary { border-bottom: 1px solid var(--line); }
.steps { display: flex; flex-direction: column; gap: 12px; padding: 14px 16px 16px; }
blockquote { margin: 0; padding: 2px 0 2px 14px; border-left: 3px solid var(--line); }
footer { display: flex; flex-direction: column; gap: 8px; padding-top: 20px; border-top: 1px solid var(--line); }
footer nav { display: flex; flex-wrap: wrap; gap: 8px 20px; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

export type SitePage = "home" | "privacy";

export interface PageFrame {
  title: string;
  description: string;
  current: SitePage;
  body: string;
}

export function layout(page: PageFrame): string {
  const link = (current: SitePage, href: string, label: string) => `<a href="${href}"${page.current === current ? ` aria-current="page"` : ""}>${label}</a>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="description" content="${escapeHtml(page.description)}">
<title>${escapeHtml(page.title)}</title>
<style>${STYLE}</style>
</head>
<body><main>${page.body}
<footer>
  <nav aria-label="More">${link("home", "/", "Setup")}${link("privacy", "/privacy", "Privacy")}<a href="${GITHUB_URL}" target="_blank" rel="noopener noreferrer">Source code on GitHub</a></nav>
  <p class="fine">An unofficial student project. Not run or endorsed by IIIT Hyderabad.</p>
</footer></main></body>
</html>`;
}

/**
 * Headers for a public page. The CSP blocks everything but inline styles and our own font. A page with a
 * script passes its exact text, and only a script with that hash may run.
 */
export function pageHeaders(script?: string): Record<string, string> {
  const scriptSrc = script ? `; script-src 'sha256-${createHash("sha256").update(script).digest("base64")}'` : "";
  return {
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; font-src 'self'${scriptSrc}; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "public, max-age=300",
  };
}
