#!/usr/bin/env node
// Hosted mode: Streamable HTTP on POST /mcp.
// Each request carries the user's own dining portal key as `Authorization: Bearer <key>`.
// The server is stateless: it builds a fresh MCP server per request and never stores keys.

import type { NextFunction, Request, Response } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3000);
const ALLOWED_HOSTS = csv(process.env.ALLOWED_HOSTS);
const ALLOWED_ORIGINS = csv(process.env.ALLOWED_ORIGINS);

// Host header validation (DNS rebinding protection) comes from the SDK
const app = createMcpExpressApp({ host: HOST, allowedHosts: ALLOWED_HOSTS.length ? ALLOWED_HOSTS : undefined });

function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function jsonRpcError(res: Response, status: number, message: string) {
  res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

// The spec requires validating Origin; server-to-server clients (claude.ai, Claude Code) send none
function checkOrigin(req: Request, res: Response, next: NextFunction) {
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.includes(origin)) return jsonRpcError(res, 403, `Origin ${origin} is not allowed`);
  next();
}

function bearerKey(req: Request): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
  return match?.[1].trim() || undefined;
}

app.get("/healthz", (_req, res) => {
  res.type("text/plain").send("ok");
});

app.post("/mcp", checkOrigin, async (req, res) => {
  const apiKey = bearerKey(req);
  if (!apiKey) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="mess-mcp-iiith"');
    return jsonRpcError(
      res,
      401,
      "Missing API key. Send `Authorization: Bearer <key>` with a key from dining.iiit.ac.in -> Settings -> Auth Keys.",
    );
  }

  const server = createServer(apiKey);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    // Never log request headers: they contain the user's key
    console.error("Error handling /mcp request:", error instanceof Error ? error.message : error);
    if (!res.headersSent) jsonRpcError(res, 500, "Internal server error");
  }
});

// Stateless server: no SSE stream to open and no session to delete
app.all("/mcp", (_req, res) => {
  res.setHeader("Allow", "POST");
  jsonRpcError(res, 405, "Method not allowed. This server is stateless; use POST.");
});

app.listen(PORT, HOST, (error?: Error) => {
  if (error) {
    console.error(error.message);
    process.exit(1);
  }
  console.error(`mess-mcp-iiith listening on http://${HOST}:${PORT}/mcp`);
});
