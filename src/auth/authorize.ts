// GET/POST /authorize: validates the client's request, shows the key-paste page,
// checks the pasted key with the portal and redirects back with a code.
//
// The validated request travels from GET to POST inside a signed, expiring blob, so the
// POST handler never trusts form fields it didn't produce itself.

import express, { Router, type Request, type Response } from "express";
import { isLoopbackHost, redirectUriAllowed, type CompositeClientResolver } from "./clients.js";
import type { Signer } from "./crypto.js";
import type { DiningKeyValidator, GrantService } from "./grants.js";
import type { Clock, OAuthClient } from "./model.js";
import { renderConsentPage, renderErrorPage } from "./pages.js";
import { sameResource, type TokenService } from "./tokens.js";

export interface AuthorizeDeps {
  issuer: string;
  resource: string;
  clients: CompositeClientResolver;
  grants: GrantService;
  tokens: TokenService;
  keyValidator: DiningKeyValidator;
  signer: Signer;
  clock: Clock;
}

interface PendingAuthorization {
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  expiresAt: number;
}

const PENDING_LIFETIME_MS = 15 * 60 * 1000;

export function authorizeRouter(deps: AuthorizeDeps): Router {
  const router = Router();

  router.get("/authorize", async (req, res) => {
    const q = stringParams(req.query);

    const client = q.client_id ? await deps.clients.resolve(q.client_id) : undefined;
    if (!client) return showError(res, "This app isn't recognised (unknown or invalid client_id).");

    const redirectUri = q.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
    if (!redirectUri || !redirectUriAllowed(client, redirectUri)) {
      return showError(res, "The app sent an unregistered redirect address, so it isn't safe to continue.");
    }

    // From here on, errors go back to the client per RFC 6749 section 4.1.2.1
    const fail = (error: string, description: string) => redirectWithParams(res, redirectUri, { error, error_description: description, state: q.state, iss: deps.issuer });
    if (q.response_type !== "code") return fail("unsupported_response_type", "Only response_type=code is supported");
    if (!q.code_challenge || q.code_challenge_method !== "S256") return fail("invalid_request", "PKCE with code_challenge_method=S256 is required");
    if (q.resource && !sameResource(q.resource, deps.resource)) return fail("invalid_target", `This server only issues tokens for ${deps.resource}`);

    const pending: PendingAuthorization = {
      clientId: client.clientId,
      clientName: displayName(client),
      redirectUri,
      codeChallenge: q.code_challenge,
      state: q.state,
      expiresAt: deps.clock() + PENDING_LIFETIME_MS,
    };
    showConsent(res, pending, signPending(deps.signer, pending));
  });

  router.post("/authorize", express.urlencoded({ extended: false, limit: "10kb" }), async (req, res) => {
    const body = stringParams(req.body ?? {});
    const pending = body.request ? verifyPending(deps.signer, body.request) : undefined;
    if (!pending || pending.expiresAt < deps.clock()) return showError(res, "This page has expired.");

    const back = (params: Record<string, string | undefined>) => redirectWithParams(res, pending.redirectUri, { ...params, state: pending.state, iss: deps.issuer });
    if (body.action !== "approve") return back({ error: "access_denied", error_description: "The user cancelled" });

    const diningKey = body.dining_key?.trim();
    if (!diningKey) return showConsent(res, pending, body.request!, "Paste your dining auth key.");

    try {
      if ((await deps.keyValidator.check(diningKey)) === "rejected") {
        return showConsent(res, pending, body.request!, "The mess portal didn't accept that key. Check you copied all of it, or create a new one.");
      }
    } catch {
      return showConsent(res, pending, body.request!, "Couldn't reach the mess portal to check your key. Try again in a minute.");
    }

    const grant = deps.grants.create({ clientId: pending.clientId, resource: deps.resource, scopes: [], diningKey });
    const code = deps.tokens.issueCode(grant, pending.redirectUri, pending.codeChallenge);
    back({ code });
  });

  return router;
}

function showConsent(res: Response, pending: PendingAuthorization, signedRequest: string, error?: string) {
  const redirect = new URL(pending.redirectUri);
  securityHeaders(res, redirect);
  res.status(error ? 400 : 200).type("html").send(
    renderConsentPage({
      clientName: pending.clientName,
      redirectHost: redirect.host,
      loopbackOnly: isLoopbackHost(redirect.hostname),
      signedRequest,
      error,
    }),
  );
}

function showError(res: Response, message: string) {
  securityHeaders(res);
  res.status(400).type("html").send(renderErrorPage(message));
}

function securityHeaders(res: Response, redirect?: URL) {
  // form-action must allow the redirect target too, or browsers block the post-submit redirect
  const formAction = ["'self'", redirect?.origin].filter(Boolean).join(" ");
  res.set({
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  });
}

function redirectWithParams(res: Response, target: string, params: Record<string, string | undefined>) {
  const url = new URL(target);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
  res.set("Cache-Control", "no-store").redirect(302, url.href);
}

function signPending(signer: Signer, pending: PendingAuthorization): string {
  const payload = Buffer.from(JSON.stringify(pending)).toString("base64url");
  return `${payload}.${signer.sign(payload)}`;
}

function verifyPending(signer: Signer, signed: string): PendingAuthorization | undefined {
  const [payload, signature] = signed.split(".");
  if (!payload || !signature || !signer.verify(payload, signature)) return undefined;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as PendingAuthorization;
  } catch {
    return undefined;
  }
}

function displayName(client: OAuthClient): string {
  if (client.clientName) return client.clientName;
  return client.clientId.startsWith("https://") ? new URL(client.clientId).host : "An unnamed app";
}

/** Keeps only single string values; repeated parameters are dropped as invalid. */
function stringParams(source: Request["query"] | Record<string, unknown>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source)) if (typeof value === "string") out[key] = value;
  return out;
}
