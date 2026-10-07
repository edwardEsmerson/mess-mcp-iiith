// Builds an MCP server bound to one user's API key. Both transports use this:
// stdio creates one at startup, HTTP creates one per request.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MessApiClient } from "./api/client.js";
import { registerTools } from "./tools.js";

export const SERVER_NAME = "mess-mcp-iiith";
export const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS = `Manages the user's meals on the IIIT Hyderabad mess (dining) portal.
Dates are YYYY-MM-DD and "today" means today in IST. Mess IDs come from get_mess_info. Money is in paise (divide by 100 for rupees).
register_meal, register_extra and create_monthly_registration add charges to the user's bill, and cancel_meal uses up a limited monthly cancellation, so confirm these with the user unless they asked for that exact change.`;

export function createServer(apiKey: string): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  registerTools(server, new MessApiClient(apiKey));
  return server;
}
