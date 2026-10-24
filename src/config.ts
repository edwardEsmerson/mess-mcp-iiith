// HTTP mode configuration, read once from the environment and validated up front
// so a misconfigured server fails at startup rather than on a user's first sign-in.

import { join } from "node:path";
import { parseMasterSecret } from "./auth/crypto.js";
import { isLoopbackHost } from "./auth/clients.js";

export interface HttpConfig {
  host: string;
  port: number;
  /** Public origin, e.g. https://ayaansh-hoeserver.tail730cfd.ts.net (also the OAuth issuer). */
  publicOrigin: string;
  /** The MCP endpoint's canonical URL: publicOrigin + /mcp. */
  resourceUrl: URL;
  allowedHosts: string[];
  allowedOrigins: string[];
  masterSecret: Buffer;
  databasePath: string;
  trustProxy: string;
  /** Shared with the Cloudflare Worker, which then vouches for each visitor's IP (see client-ip.ts). */
  proxySecret?: string;
  /** True only for http://localhost development setups. */
  insecureLocalIssuer: boolean;
  /** Enables /metrics and /dashboard when set. */
  dashboardPassword?: string;
  /** Plain text the operator wants shown on /privacy under "How this server is hosted". */
  hostingNote?: string;
}

export function loadHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  if (!env.PUBLIC_URL) throw new Error("PUBLIC_URL is not set. Set it to the https:// address clients use to reach this server.");
  const publicUrl = new URL(env.PUBLIC_URL);
  const insecureLocalIssuer = publicUrl.protocol === "http:" && isLoopbackHost(publicUrl.hostname);
  if (publicUrl.protocol !== "https:" && !insecureLocalIssuer) throw new Error("PUBLIC_URL must use https:// (http:// is only allowed for localhost).");
  if (publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) throw new Error("PUBLIC_URL must be an origin only, e.g. https://example.com");

  // METRICS_TOKEN is the old name, still read so existing configs keep working
  const dashboardPassword = env.DASHBOARD_PASSWORD || env.METRICS_TOKEN || undefined;
  if (dashboardPassword && dashboardPassword.length < 10) throw new Error("DASHBOARD_PASSWORD must be at least 10 characters: the dashboard is on the public internet.");

  const proxySecret = env.PROXY_SECRET?.trim() || undefined;
  if (proxySecret && (proxySecret.length < 20 || !/^[\x21-\x7e]+$/.test(proxySecret))) {
    throw new Error("PROXY_SECRET must be at least 20 characters with no spaces. Generate one with: openssl rand -hex 32");
  }

  const publicOrigin = publicUrl.origin;
  const dataDir = env.STATE_DIRECTORY?.split(":")[0] || env.DATA_DIR || "./data";

  return {
    host: env.HOST || "127.0.0.1",
    port: Number(env.PORT || 3000),
    publicOrigin,
    resourceUrl: new URL("/mcp", publicOrigin),
    allowedHosts: unique([publicUrl.hostname, "localhost", "127.0.0.1", ...csv(env.ALLOWED_HOSTS)]),
    // The authorize form posts from our own origin, so it must be allowed alongside any extras
    allowedOrigins: unique([publicUrl.hostname, ...csv(env.ALLOWED_ORIGINS).map(originHostname)]),
    masterSecret: parseMasterSecret(env.MCP_SECRET),
    databasePath: join(dataDir, "mess-mcp.db"),
    trustProxy: env.TRUST_PROXY || "loopback",
    proxySecret,
    insecureLocalIssuer,
    dashboardPassword,
    hostingNote: env.HOSTING_NOTE?.trim() || undefined,
  };
}

function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Accepts either a full origin (https://app.example.com) or a bare hostname. */
function originHostname(value: string): string {
  return value.includes("://") ? new URL(value).hostname : value;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
