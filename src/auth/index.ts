// Assembles the authorization server from its parts. The only place concrete classes are chosen.

import type { DatabaseSync } from "node:sqlite";
import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import type { MessApi } from "../api/client.js";
import { authorizeRouter } from "./authorize.js";
import { CompositeClientResolver, MetadataDocumentClientResolver, PublicHttpsJsonFetcher, RegisteredClientResolver } from "./clients.js";
import { AesGcmBox, deriveKey, HmacSigner } from "./crypto.js";
import { authorizationServerMetadata, registrationRouter, tokenRouter } from "./endpoints.js";
import { GrantService, PortalKeyValidator } from "./grants.js";
import { systemClock, type Clock } from "./model.js";
import { SqliteClientRepository, SqliteCodeRepository, SqliteGrantRepository, SqliteHousekeeping, SqliteTokenRepository } from "./sqlite.js";
import { TokenService } from "./tokens.js";

export interface AuthorizationServerOptions {
  /** Issuer identifier: the public origin, no trailing slash. */
  issuer: string;
  /** Canonical URL of the MCP endpoint tokens are issued for. */
  resource: string;
  masterSecret: Buffer;
  db: DatabaseSync;
  /** Builds a portal client for a dining key (used to check pasted keys). */
  apiFor: (diningKey: string) => MessApi;
  documentation?: string;
  clock?: Clock;
}

export function createAuthorizationServer(options: AuthorizationServerOptions) {
  const clock = options.clock ?? systemClock;
  const clientRepository = new SqliteClientRepository(options.db);
  const grantRepository = new SqliteGrantRepository(options.db);

  const grants = new GrantService(grantRepository, new AesGcmBox(deriveKey(options.masterSecret, "dining-keys")), clock);
  const tokens = new TokenService(new SqliteCodeRepository(options.db), new SqliteTokenRepository(options.db), grantRepository, clock);
  const clients = new CompositeClientResolver([
    new MetadataDocumentClientResolver(new PublicHttpsJsonFetcher()),
    new RegisteredClientResolver(clientRepository),
  ]);

  const router = Router();
  // Claude's backend calls /token from a shared IP range, so that limit is per-IP but generous
  router.use("/authorize", rateLimit({ windowMs: 5 * 60_000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false }));
  router.use(["/token", "/revoke"], rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: "draft-8", legacyHeaders: false }));
  router.use("/register", rateLimit({ windowMs: 60 * 60_000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false }));

  router.use(
    authorizeRouter({
      issuer: options.issuer,
      resource: options.resource,
      clients,
      grants,
      tokens,
      keyValidator: new PortalKeyValidator(options.apiFor),
      signer: new HmacSigner(deriveKey(options.masterSecret, "authorize-request")),
      clock,
    }),
  );
  router.use(tokenRouter(tokens));
  router.use(registrationRouter(clientRepository));

  return {
    router,
    /** Verifies access tokens on /mcp. */
    verifier: tokens,
    grants,
    metadata: authorizationServerMetadata(options.issuer, options.documentation),
    housekeeping: new SqliteHousekeeping(options.db),
  };
}
