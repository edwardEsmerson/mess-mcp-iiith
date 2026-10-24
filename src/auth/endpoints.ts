// POST /token, /revoke and /register. Clients are public (no secret), so client_id identifies them
// and PKCE plus refresh token rotation do the work a secret would.

import { randomUUID } from "node:crypto";
import express, { Router, type Response } from "express";
import { OAuthError, OAuthErrorCode, type OAuthMetadata } from "@modelcontextprotocol/server";
import { isAcceptableRedirectUri, PRIVATE_USE_SCHEMES } from "./clients.js";
import type { ClientRepository } from "./model.js";
import type { TokenService } from "./tokens.js";

export function tokenRouter(tokens: TokenService): Router {
  const router = Router();
  router.use(["/token", "/revoke"], express.urlencoded({ extended: false, limit: "10kb" }));

  router.post("/token", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const param = (name: string) => (typeof body[name] === "string" ? (body[name] as string) : undefined);
    res.set({ "Cache-Control": "no-store", Pragma: "no-cache" });

    try {
      const clientId = param("client_id");
      if (!clientId) throw new OAuthError(OAuthErrorCode.InvalidClient, "client_id is required");

      switch (param("grant_type")) {
        case "authorization_code": {
          const code = param("code");
          const redirectUri = param("redirect_uri");
          const codeVerifier = param("code_verifier");
          if (!code || !redirectUri || !codeVerifier) {
            throw new OAuthError(OAuthErrorCode.InvalidRequest, "code, redirect_uri and code_verifier are required");
          }
          return res.json(tokens.exchangeCode({ code, clientId, redirectUri, codeVerifier, resource: param("resource") }));
        }
        case "refresh_token": {
          const refreshToken = param("refresh_token");
          if (!refreshToken) throw new OAuthError(OAuthErrorCode.InvalidRequest, "refresh_token is required");
          return res.json(tokens.refresh({ refreshToken, clientId, resource: param("resource") }));
        }
        default:
          throw new OAuthError(OAuthErrorCode.UnsupportedGrantType, "Supported grant types: authorization_code, refresh_token");
      }
    } catch (error) {
      sendOAuthError(res, error);
    }
  });

  router.post("/revoke", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.token === "string" && typeof body.client_id === "string") tokens.revoke(body.token, body.client_id);
    // RFC 7009: answer 200 whether or not the token existed
    res.status(200).end();
  });

  return router;
}

/** RFC 7591 Dynamic Client Registration, kept for clients that don't support metadata documents yet. */
export function registrationRouter(clients: ClientRepository): Router {
  const router = Router();

  router.post("/register", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const redirectUris = body.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > 10 || !redirectUris.every(isAcceptableRedirectUri)) {
      return res.status(400).json({ error: "invalid_redirect_uri", error_description: `redirect_uris must be https, http on localhost/127.0.0.1, or use the ${PRIVATE_USE_SCHEMES.join(" or ")} scheme` });
    }
    const authMethod = body.token_endpoint_auth_method ?? "none";
    if (authMethod !== "none") {
      return res.status(400).json({ error: "invalid_client_metadata", error_description: "Only public clients (token_endpoint_auth_method=none) are supported" });
    }

    const client = {
      clientId: randomUUID(),
      clientName: typeof body.client_name === "string" ? body.client_name.slice(0, 100) : undefined,
      redirectUris,
    };
    clients.save(client);
    res.status(201).json({
      client_id: client.clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  return router;
}

export function authorizationServerMetadata(issuer: string, documentation?: string): OAuthMetadata {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    revocation_endpoint: `${issuer}/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: documentation,
  };
}

function sendOAuthError(res: Response, error: unknown) {
  const oauth = error instanceof OAuthError ? error : new OAuthError(OAuthErrorCode.ServerError, "Internal server error");
  const status = oauth.code === OAuthErrorCode.InvalidClient ? 401 : oauth.code === OAuthErrorCode.ServerError ? 500 : 400;
  if (status === 500) console.error("Token endpoint error:", error instanceof Error ? error.message : error);
  res.status(status).json(oauth.toResponseObject());
}
