// Builds an MCP server for one user's portal access. Both transports use this:
// stdio builds one per connection, HTTP one per request.

import { McpServer } from "@modelcontextprotocol/server";
import type { MessApi } from "./api/client.js";
import { registerTools, type ToolCallObserver } from "./tools.js";

export const SERVER_NAME = "mess-mcp-iiith";
export const SERVER_VERSION = "0.3.0";

const INSTRUCTIONS = `Manages the user's meals on the IIIT Hyderabad mess (dining) portal.

Conventions: dates are YYYY-MM-DD (left out means today) and "today" is today in IST. A meal is breakfast, lunch, snacks or dinner. A mess is its exact ID from get_mess_info, such as yuktahar or kadamba-veg; a wrong one is rejected with the valid IDs. Money is in paise (divide by 100 for rupees).

How meals work:
- Each meal on a date has at most one mess. With none set, the portal allocates a vegetarian meal at some mess.
- cancel_meal opts out of a meal: no charge, but only a few cancellations per meal type per month. skip_meal says you won't come: the meal is still charged and no cancellation is used.
- Setting a mess, cancelling and skipping each close a different time before the meal. Call get_deadlines for the exact cutoffs and the cancellations left before changing anything.

Confirm with the user before set_meal_mess, register_extra or create_monthly_registration (they add charges) and cancel_meal (it uses a limited monthly cancellation), unless they asked for that exact change.`;

export interface CreateServerOptions {
  /** The clock tools read "today" from. Tests pin it; it defaults to the real time. */
  now?: () => Date;
}

export function createServer(api: MessApi, onToolCall?: ToolCallObserver, options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  registerTools(server, api, onToolCall, { now: options.now ?? (() => new Date()) });
  return server;
}
