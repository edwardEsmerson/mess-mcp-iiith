// Drives the built MCP server in-process over a linked in-memory transport, for the token
// counter and the tool tests. Speaks plain JSON-RPC; no client package is needed.

import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createServer } from "../../dist/server.js";

/**
 * Connects a client to a fresh server built on `api` (any MessApi, e.g. a fake) and returns
 * helpers. `options` is passed to createServer (for example `{ now: () => new Date(...) }`).
 */
export async function connect(api, options) {
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer(api, undefined, options);
  await server.connect(serverSide);

  let nextId = 1;
  const pending = new Map();
  client.onmessage = (message) => {
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  };
  await client.start();

  const request = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (message) => (message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result)));
      client.send({ jsonrpc: "2.0", id, method, params }).catch(reject);
    });

  const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "in-process", version: "0" } });
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });

  return {
    instructions: init.instructions ?? "",
    listTools: async () => (await request("tools/list")).tools,
    /** Resolves to the raw tools/call result ({ content, isError? }). */
    callTool: (name, args = {}) => request("tools/call", { name, arguments: args }),
    close: () => Promise.all([client.close(), server.close()]),
  };
}

/** A MessApi that fails every call, for measuring tools/list where the portal is never reached. */
export const unreachableApi = {
  get: () => Promise.reject(new Error("unreachable")),
  post: () => Promise.reject(new Error("unreachable")),
  put: () => Promise.reject(new Error("unreachable")),
  delete: () => Promise.reject(new Error("unreachable")),
};
