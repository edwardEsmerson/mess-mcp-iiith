#!/usr/bin/env node
// Local mode: the client starts this process and talks over stdin/stdout.
// The API key comes from the MESS_API_KEY environment variable.

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { MessApiClient } from "./api/client.js";
import { createServer } from "./server.js";

const apiKey = process.env.MESS_API_KEY;
if (!apiKey) {
  console.error("MESS_API_KEY is not set. Create a key at dining.iiit.ac.in -> Settings -> Auth Keys.");
  process.exit(1);
}

const api = new MessApiClient(apiKey);
serveStdio(() => createServer(api), { onerror: (error) => console.error(error.message) });
// stdout carries the protocol, so logs go to stderr
console.error("mess-mcp-iiith running on stdio");
