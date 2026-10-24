// Who is calling, for rate limits. Behind the Cloudflare Worker, Express's req.ip is a Cloudflare
// address shared by everyone routed through the same location, so one person could use up the
// limit for all of them. The Worker therefore passes the visitor's address in a header, together
// with a secret only it and this server know. The address is believed only when the secret matches;
// otherwise (a direct hit on the Funnel URL, a wrong or missing secret) req.ip is used, as before.

import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { NextFunction, Request, Response } from "express";
import { ipKeyGenerator } from "express-rate-limit";

/** Set by deploy/cloudflare-worker/worker.js, which overwrites any copy the visitor sent. */
export const CLIENT_IP_HEADER = "x-mess-client-ip";
export const PROXY_SECRET_HEADER = "x-mess-proxy-secret";

type Verdict = "off" | "absent" | "mismatch" | "match";

export class ClientIps {
  /** SHA-256 of PROXY_SECRET, so the comparison is constant-time whatever length the visitor sends. */
  private readonly secretDigest?: Buffer;
  private readonly reported = new Set<Verdict>();

  constructor(
    secret: string | undefined,
    private readonly log: (message: string) => void = console.error,
  ) {
    if (secret) this.secretDigest = createHash("sha256").update(secret).digest();
  }

  /** The caller's address: the proxy's header when its secret matches, otherwise what Express worked out. */
  of(req: Pick<Request, "headers" | "ip" | "socket">): string {
    if (this.verdict(req) === "match") {
      const claimed = req.headers[CLIENT_IP_HEADER];
      if (typeof claimed === "string" && isIP(claimed.trim())) return claimed.trim();
    }
    return req.ip ?? req.socket.remoteAddress ?? "unknown";
  }

  /** What rate limits count requests by: the caller's address, with IPv6 callers grouped by /56. */
  key = (req: Request): string => ipKeyGenerator(this.of(req));

  /** Says once in the log whether the proxy header is in use. Never logs addresses or the secret. */
  observe = (req: Request, _res: Response, next: NextFunction): void => {
    const verdict = this.verdict(req);
    if (!this.reported.has(verdict)) {
      this.reported.add(verdict);
      if (verdict === "match") this.log("Client IPs: the proxy secret matched, so rate limits use the address the Worker reports.");
      if (verdict === "mismatch") this.log("Client IPs: a request sent X-Mess-Proxy-Secret that doesn't match PROXY_SECRET, so its client address was ignored. Check the Worker's secret.");
    }
    next();
  };

  private verdict(req: Pick<Request, "headers">): Verdict {
    if (!this.secretDigest) return "off";
    const given = req.headers[PROXY_SECRET_HEADER];
    // Node joins repeated custom headers with commas, so a duplicate can never match
    if (typeof given !== "string") return "absent";
    const digest = createHash("sha256").update(given.trim()).digest();
    return timingSafeEqual(digest, this.secretDigest) ? "match" : "mismatch";
  }
}
