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
import { RevokeOnUnauthorized } from "./auth/revoke-on-unauthorized.js";
import { openDatabase } from "./auth/sqlite.js";
import { loadHttpConfig } from "./config.js";
import { createServer, SERVER_NAME } from "./server.js";

const DOCS_URL = "https://github.com/edwardEsmerson/mess-mcp-iiith#readme";

let config;
try {
  config = loadHttpConfig();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const db = openDatabase(config.databasePath);
const auth = createAuthorizationServer({
  issuer: config.publicOrigin,
  resource: config.resourceUrl.href,
  masterSecret: config.masterSecret,
  db,
  apiFor: (key) => new MessApiClient(key),
  documentation: DOCS_URL,
});

// A user's portal access for one request, built from the grant their token points to
function apiFor(authInfo: AuthInfo | undefined): MessApi {
  const grantId = authInfo?.extra?.grantId;
  const key = typeof grantId === "string" ? auth.grants.diningKeyFor(grantId) : undefined;
  if (!key) throw new Error("No dining key for this token. Reconnect this app.");
  return new RevokeOnUnauthorized(new MessApiClient(key), () => auth.grants.revoke(grantId as string));
}

const mcp = toNodeHandler(
  createMcpHandler(({ authInfo }) => createServer(apiFor(authInfo)), {
    // Never log request objects or headers: they carry tokens
    onerror: (error) => console.error("MCP error:", error.message),
  }),
);

// Host validation (DNS rebinding protection) applies everywhere. Origin validation applies to /mcp only:
// the sign-in page sends `Referrer-Policy: no-referrer`, so browsers submit its form with `Origin: null`,
// and that form is already protected by its signed request.
const app = express();
app.use(hostHeaderValidation(config.allowedHosts));
app.use(express.json());
app.set("trust proxy", config.trustProxy);

app.get("/healthz", (_req, res) => {
  res.type("text/plain").send("ok");
});

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

setInterval(() => auth.housekeeping.deleteExpired(Date.now()), 60 * 60 * 1000).unref();

app.listen(config.port, config.host, (error?: Error) => {
  if (error) {
    console.error(error.message);
    process.exit(1);
  }
  console.error(`${SERVER_NAME} listening on http://${config.host}:${config.port}/mcp (public: ${config.resourceUrl.href})`);
});
