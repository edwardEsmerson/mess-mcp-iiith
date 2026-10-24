#!/usr/bin/env node
// Hosted mode: Streamable HTTP on /mcp, protected by OAuth.
// This process is both the MCP resource server and its authorization server (see auth/).
// Users sign in once by pasting their dining key; clients then send our own access tokens.

import { createMcpHandler, getOAuthProtectedResourceMetadataUrl, type AuthInfo } from "@modelcontextprotocol/server";
import express from "express";
import { hostHeaderValidation, mcpAuthMetadataRouter, originValidation, requireBearerAuth } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { MessApiClient, type MessApi } from "./api/client.js";
import { createAuthorizationServer } from "./auth/index.js";
import { FONT_PATH } from "./auth/pages.js";
import { RevokeOnUnauthorized } from "./auth/revoke-on-unauthorized.js";
import { openDatabase } from "./auth/sqlite.js";
import { loadHttpConfig } from "./config.js";
import { MetricsRecorder } from "./metrics/recorder.js";
import { measureRequests, metricsRouter } from "./metrics/router.js";
import { SqliteMetricsStore } from "./metrics/sqlite.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { siteRouter } from "./site/router.js";

const DOCS_URL = "https://github.com/edwardEsmerson/mess-mcp-iiith#readme";

let config;
try {
  config = loadHttpConfig();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const db = openDatabase(config.databasePath);
// Metrics are opt-in: without DASHBOARD_PASSWORD nothing is recorded and /metrics, /dashboard don't exist
const metrics = config.dashboardPassword ? new MetricsRecorder(new SqliteMetricsStore(db)) : undefined;

const auth = createAuthorizationServer({
  issuer: config.publicOrigin,
  resource: config.resourceUrl.href,
  masterSecret: config.masterSecret,
  db,
  apiFor: (key) => new MessApiClient(key),
  documentation: DOCS_URL,
  events: metrics,
});

function grantIdOf(authInfo: AuthInfo | undefined): string | undefined {
  const grantId = authInfo?.extra?.grantId;
  return typeof grantId === "string" ? grantId : undefined;
}

// A user's portal access for one request, built from the grant their token points to
function apiFor(grantId: string | undefined): MessApi {
  const key = grantId ? auth.grants.diningKeyFor(grantId) : undefined;
  if (!grantId || !key) throw new Error("No dining key for this token. Reconnect this app.");
  return new RevokeOnUnauthorized(new MessApiClient(key), () => {
    auth.grants.revoke(grantId);
    metrics?.grantRevoked();
  });
}

const mcp = toNodeHandler(
  createMcpHandler(
    ({ authInfo }) => {
      const grantId = grantIdOf(authInfo);
      return createServer(apiFor(grantId), metrics && ((tool, ms, error) => metrics.toolCall(tool, ms, error, grantId)));
    },
    {
      // Never log request objects or headers: they carry tokens
      onerror: (error) => console.error("MCP error:", error.message),
    },
  ),
);

// Host validation (DNS rebinding protection) applies everywhere. Origin validation applies to /mcp only:
// the sign-in page sends `Referrer-Policy: no-referrer`, so browsers submit its form with `Origin: null`,
// and that form is already protected by its signed request.
const app = express();
app.use(hostHeaderValidation(config.allowedHosts));
if (metrics) {
  app.use(
    measureRequests(metrics, [
      "/mcp",
      "/authorize",
      FONT_PATH,
      "/token",
      "/revoke",
      "/register",
      "/",
      "/healthz",
      "/privacy",
      "/metrics",
      "/dashboard",
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource/mcp",
    ]),
  );
}
app.use(express.json());
app.set("trust proxy", config.trustProxy);

app.get("/healthz", (_req, res) => {
  res.type("text/plain").send("ok");
});

app.use(siteRouter({ connectorUrl: config.resourceUrl.href, metricsEnabled: metrics !== undefined, hostingNote: config.hostingNote }));

app.use(
  mcpAuthMetadataRouter({
    oauthMetadata: auth.metadata,
    resourceServerUrl: config.resourceUrl,
    resourceName: "IIITH Mess",
    serviceDocumentationUrl: new URL(DOCS_URL),
    dangerouslyAllowInsecureIssuerUrl: config.insecureLocalIssuer,
  }),
);
app.use(auth.router);
if (config.dashboardPassword && metrics) {
  app.use(
    metricsRouter({
      password: config.dashboardPassword,
      recorder: metrics,
      connections: auth.connections,
      version: SERVER_VERSION,
      host: new URL(config.publicOrigin).host,
      secureCookie: config.publicOrigin.startsWith("https:"),
    }),
  );
}

app.all(
  "/mcp",
  originValidation(config.allowedOrigins),
  requireBearerAuth({
    verifier: auth.verifier,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.resourceUrl),
    expectedResource: config.resourceUrl,
  }),
  (req, res) => mcp(req, res, req.body),
);

setInterval(() => {
  auth.housekeeping.deleteExpired(Date.now());
  metrics?.prune();
}, 60 * 60 * 1000).unref();

if (metrics) {
  const flush = () => {
    try {
      metrics.flush();
    } catch (error) {
      console.error("Couldn't save metrics:", error instanceof Error ? error.message : error);
    }
  };
  setInterval(flush, 60 * 1000).unref();
  // Save the last minute's counts when systemd stops the service
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      flush();
      process.exit(0);
    });
  }
}

app.listen(config.port, config.host, (error?: Error) => {
  if (error) {
    console.error(error.message);
    process.exit(1);
  }
  console.error(`${SERVER_NAME} listening on http://${config.host}:${config.port}/mcp (public: ${config.resourceUrl.href})`);
  console.error(metrics ? `Dashboard: ${config.publicOrigin}/dashboard` : "Dashboard off. Set DASHBOARD_PASSWORD to turn it on.");
});
