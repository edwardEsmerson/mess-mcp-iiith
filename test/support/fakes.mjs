// Small stand-ins for the things auth services talk to, plus a helper to serve an Express router in-process.

import { once } from "node:events";
import http from "node:http";

/** A clock the test moves by hand. */
export function manualClock(start = 1_700_000_000_000) {
  let now = start;
  const clock = () => now;
  clock.advance = (ms) => void (now += ms);
  return clock;
}

/**
 * A MessApi that answers every call with `handler(method, endpoint, argument)`: return a value to
 * resolve with, throw to reject. Each call is recorded in `calls`.
 */
export function fakeApi(handler = () => ({})) {
  const calls = [];
  const answer = (method) => async (endpoint, argument) => {
    calls.push({ method, endpoint, argument });
    return handler(method, endpoint, argument);
  };
  return { calls, get: answer("GET"), post: answer("POST"), put: answer("PUT"), delete: answer("DELETE") };
}

/** A JsonFetcher serving documents by URL. A URL with no document fails like an unreachable host; an Error value is thrown. */
export function fakeFetcher(documents = {}) {
  const fetched = [];
  return {
    documents,
    fetched,
    async fetchJson(url) {
      fetched.push(url.href);
      const document = documents[url.href];
      if (document === undefined) throw new Error(`no document at ${url.href}`);
      if (document instanceof Error) throw document;
      return structuredClone(document);
    },
  };
}

/** Serves an Express app (or any request listener) on an ephemeral loopback port. */
export async function serve(app) {
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close() {
      server.close();
      server.closeAllConnections();
    },
  };
}
