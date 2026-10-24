// Working out who an OAuth client is. Two strategies, tried in order:
//  - Client ID Metadata Documents (the 2026 default): client_id is an HTTPS URL we fetch.
//  - Dynamic Client Registration (deprecated fallback): client_id was issued by our /register.
// Add a strategy by implementing ClientResolver; nothing else changes.

import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import type { ClientRepository, OAuthClient } from "./model.js";

export interface ClientResolver {
  /** Whether this strategy is responsible for the client_id at all. */
  handles(clientId: string): boolean;
  resolve(clientId: string): Promise<OAuthClient | undefined>;
}

export class CompositeClientResolver {
  constructor(private readonly strategies: ClientResolver[]) {}

  async resolve(clientId: string): Promise<OAuthClient | undefined> {
    const strategy = this.strategies.find((s) => s.handles(clientId));
    return strategy?.resolve(clientId);
  }
}

export class RegisteredClientResolver implements ClientResolver {
  constructor(private readonly clients: ClientRepository) {}

  handles(clientId: string): boolean {
    return !clientId.startsWith("https://");
  }

  async resolve(clientId: string): Promise<OAuthClient | undefined> {
    return this.clients.find(clientId);
  }
}

/** What to call a client on pages and dashboards. Metadata-document clients without a name go by their host. */
export function displayName(client: Pick<OAuthClient, "clientId" | "clientName">): string {
  if (client.clientName) return client.clientName;
  return client.clientId.startsWith("https://") ? new URL(client.clientId).host : "An unnamed app";
}

export interface JsonFetcher {
  fetchJson(url: URL): Promise<unknown>;
}

export class MetadataDocumentClientResolver implements ClientResolver {
  private readonly cache = new Map<string, { client: OAuthClient; until: number }>();

  constructor(
    private readonly fetcher: JsonFetcher,
    private readonly ttlMs = 60 * 60 * 1000,
    private readonly maxEntries = 500,
  ) {}

  handles(clientId: string): boolean {
    return clientId.startsWith("https://");
  }

  async resolve(clientId: string): Promise<OAuthClient | undefined> {
    const cached = this.cache.get(clientId);
    if (cached && cached.until > Date.now()) return cached.client;

    const url = parseClientIdUrl(clientId);
    if (!url) return undefined;

    let document: unknown;
    try {
      document = await this.fetcher.fetchJson(url);
    } catch {
      return undefined;
    }
    const client = parseClientMetadata(document, clientId);
    if (!client) return undefined;

    if (this.cache.size >= this.maxEntries) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(clientId, { client, until: Date.now() + this.ttlMs });
    return client;
  }
}

/** CIMD client IDs: https, a path, no fragment, credentials or dot segments. */
function parseClientIdUrl(clientId: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return undefined;
  }
  const valid =
    url.protocol === "https:" &&
    url.pathname.length > 1 &&
    !url.hash &&
    !url.username &&
    !url.password &&
    url.href === clientId &&
    !/\/\.\.?(\/|$)/.test(clientId);
  return valid ? url : undefined;
}

function parseClientMetadata(document: unknown, clientId: string): OAuthClient | undefined {
  if (!document || typeof document !== "object") return undefined;
  const doc = document as Record<string, unknown>;
  if (doc.client_id !== clientId) return undefined;
  const redirectUris = doc.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0 || !redirectUris.every(isAcceptableRedirectUri)) return undefined;
  // We only issue tokens to public clients, so the client must be able to use "none". ChatGPT prefers
  // private_key_jwt but lists "none" among its supported methods, and picks from the intersection with ours.
  const authMethod = doc.token_endpoint_auth_method;
  const supported = doc.token_endpoint_auth_methods_supported;
  const canUseNone = authMethod === undefined || authMethod === "none" || (Array.isArray(supported) && supported.includes("none"));
  if (!canUseNone) return undefined;
  return {
    clientId,
    clientName: typeof doc.client_name === "string" ? doc.client_name.slice(0, 100) : undefined,
    redirectUris,
  };
}

/** Redirect URIs must be https, or http on a loopback address (native apps such as Claude Code). */
export function isAcceptableRedirectUri(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    if (url.hash) return false;
    return url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname));
  } catch {
    return false;
  }
}

/** Exact match, except loopback redirects match on any port (RFC 8252 section 7.3). */
export function redirectUriAllowed(client: OAuthClient, requested: string): boolean {
  if (client.redirectUris.includes(requested)) return true;
  let req: URL;
  try {
    req = new URL(requested);
  } catch {
    return false;
  }
  if (req.protocol !== "http:" || !isLoopbackHost(req.hostname)) return false;
  return client.redirectUris.some((registered) => {
    try {
      const reg = new URL(registered);
      return (
        reg.protocol === "http:" &&
        reg.hostname === req.hostname &&
        reg.pathname === req.pathname &&
        reg.search === req.search
      );
    } catch {
      return false;
    }
  });
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** Every address a hostname currently points at (injectable so tests can simulate DNS rebinding). */
export type HostResolver = (hostname: string) => Promise<{ address: string; family: number }[]>;

const resolveWithDns: HostResolver = (hostname) => lookup(hostname, { all: true });

/**
 * Fetches small JSON documents from public HTTPS URLs only. Addresses in private, loopback,
 * link-local or CGNAT (Tailscale) ranges are refused, so a client_id can't be used to probe the
 * campus network or this machine.
 *
 * The check happens inside the socket's own name lookup, so the addresses that were checked are
 * the only ones it can connect to. Checking first and letting fetch resolve the name again would
 * let a DNS-rebinding domain answer with a public address once and a campus address the next time.
 */
export class PublicHttpsJsonFetcher implements JsonFetcher {
  private readonly blocked = new BlockList();

  constructor(
    private readonly maxBytes = 10 * 1024,
    private readonly timeoutMs = 5_000,
    private readonly resolve: HostResolver = resolveWithDns,
  ) {
    for (const [net, prefix] of [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.168.0.0", 16],
      ["224.0.0.0", 3],
    ] as const) {
      this.blocked.addSubnet(net, prefix, "ipv4");
    }
    for (const [net, prefix] of [
      ["::", 127],
      ["fc00::", 7],
      ["fe80::", 10],
      ["ff00::", 8],
    ] as const) {
      this.blocked.addSubnet(net, prefix, "ipv6");
    }
    // IPv4-mapped IPv6 addresses (::ffff:10.0.0.1) are checked against the IPv4 rules by BlockList itself
  }

  async fetchJson(url: URL): Promise<unknown> {
    if (url.protocol !== "https:") throw new Error("Only https is allowed");
    // An IP address in the URL is connected to without any name lookup, so check it here
    const literal = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(literal)) this.assertPublic([{ address: literal, family: isIP(literal) }]);

    const body = await this.get(url);
    return JSON.parse(new TextDecoder().decode(body));
  }

  private get(url: URL): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const req = request(
        url,
        {
          agent: false,
          lookup: this.publicLookup,
          signal: AbortSignal.timeout(this.timeoutMs),
          // Not compressed, because we read the bytes as they are. The User-Agent is what fetch used to send.
          headers: { Accept: "application/json", "Accept-Encoding": "identity", "User-Agent": "node" },
        },
        (res) => {
          const fail = (error: Error) => {
            res.destroy();
            reject(error);
          };
          // Redirects aren't followed: they could lead anywhere, and the client_id URL is the document's identity
          if (!res.statusCode || res.statusCode < 200 || res.statusCode > 299) return fail(new Error(`HTTP ${res.statusCode}`));
          const encoding = res.headers["content-encoding"];
          if (encoding && encoding !== "identity") return fail(new Error(`Unsupported content-encoding ${encoding}`));
          if (Number(res.headers["content-length"] ?? 0) > this.maxBytes) return fail(new Error("Document too large"));

          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > this.maxBytes) return fail(new Error("Document too large"));
            chunks.push(chunk);
          });
          res.on("end", () => resolve(Buffer.concat(chunks)));
          res.on("error", reject);
          res.on("close", () => reject(new Error("Connection closed early")));
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  /** The socket's name lookup: resolves, refuses unless every answer is public, then hands exactly those addresses to connect. */
  private readonly publicLookup: LookupFunction = (hostname, options, callback) => {
    this.resolve(hostname).then(
      (addresses) => {
        try {
          this.assertPublic(addresses);
        } catch (error) {
          return callback(error as NodeJS.ErrnoException, []);
        }
        const family = options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : options.family;
        const usable = family === 4 || family === 6 ? addresses.filter((a) => a.family === family) : addresses;
        if (usable.length === 0) return callback(Object.assign(new Error(`No IPv${family} address for ${hostname}`), { code: "ENOTFOUND" }), []);
        if (options.all) return callback(null, usable);
        callback(null, usable[0]!.address, usable[0]!.family);
      },
      (error: NodeJS.ErrnoException) => callback(error, []),
    );
  };

  private assertPublic(addresses: { address: string; family: number }[]): void {
    for (const { address, family } of addresses) {
      if (this.blocked.check(address, family === 6 ? "ipv6" : "ipv4")) throw new Error("Refusing to fetch a non-public address");
    }
  }
}
