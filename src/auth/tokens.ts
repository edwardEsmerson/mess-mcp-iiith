// Authorization codes, access tokens and refresh tokens. All are opaque random strings;
// only their SHA-256 hashes are stored. Refresh tokens rotate on every use, and presenting
// an already-used one revokes the whole grant (OAuth 2.1 refresh token reuse detection).

import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import type { AuthInfo, OAuthTokens, OAuthTokenVerifier } from "@modelcontextprotocol/server";
import { randomToken, sha256, verifyPkceS256 } from "./crypto.js";
import type { Clock, CodeRepository, Grant, GrantRepository, TokenRepository } from "./model.js";

export interface TokenLifetimes {
  codeMs: number;
  accessMs: number;
  refreshMs: number;
}

export const DEFAULT_LIFETIMES: TokenLifetimes = {
  codeMs: 5 * 60 * 1000,
  accessMs: 60 * 60 * 1000,
  refreshMs: 60 * 24 * 60 * 60 * 1000,
};

export const ACCESS_TOKEN_PREFIX = "mmcp_at_";
const REFRESH_TOKEN_PREFIX = "mmcp_rt_";
const CODE_PREFIX = "mmcp_ac_";

export class TokenService implements OAuthTokenVerifier {
  constructor(
    private readonly codes: CodeRepository,
    private readonly tokens: TokenRepository,
    private readonly grants: GrantRepository,
    private readonly clock: Clock,
    private readonly lifetimes: TokenLifetimes = DEFAULT_LIFETIMES,
  ) {}

  issueCode(grant: Grant, redirectUri: string, codeChallenge: string): string {
    const code = randomToken(CODE_PREFIX);
    this.codes.save({
      codeHash: sha256(code),
      grantId: grant.id,
      clientId: grant.clientId,
      redirectUri,
      codeChallenge,
      expiresAt: this.clock() + this.lifetimes.codeMs,
    });
    return code;
  }

  exchangeCode(input: { code: string; clientId: string; redirectUri: string; codeVerifier: string; resource?: string }): OAuthTokens {
    const record = this.codes.take(sha256(input.code));
    const invalid = new OAuthError(OAuthErrorCode.InvalidGrant, "Authorization code is invalid or expired");
    if (!record || record.expiresAt < this.clock()) throw invalid;

    const grant = this.grants.find(record.grantId);
    const ok =
      grant !== undefined &&
      record.clientId === input.clientId &&
      record.redirectUri === input.redirectUri &&
      verifyPkceS256(input.codeVerifier, record.codeChallenge) &&
      (input.resource === undefined || sameResource(input.resource, grant.resource));
    if (!ok) {
      // A failed redemption may be an attacker holding a stolen code; the grant is unusable either way
      if (grant) this.grants.delete(grant.id);
      throw invalid;
    }
    return this.issueTokens(grant);
  }

  refresh(input: { refreshToken: string; clientId: string; resource?: string }): OAuthTokens {
    const hash = sha256(input.refreshToken);
    const record = this.tokens.find(hash);
    const invalid = new OAuthError(OAuthErrorCode.InvalidGrant, "Refresh token is invalid or expired");
    if (!record || record.kind !== "refresh" || record.expiresAt < this.clock()) throw invalid;

    const grant = this.grants.find(record.grantId);
    if (!grant || grant.clientId !== input.clientId) throw invalid;
    if (record.usedAt !== undefined) {
      this.grants.delete(grant.id);
      throw invalid;
    }
    if (input.resource !== undefined && !sameResource(input.resource, grant.resource)) {
      throw new OAuthError(OAuthErrorCode.InvalidTarget, "Token was not issued for this resource");
    }

    this.tokens.markUsed(hash, this.clock());
    return this.issueTokens(grant);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const invalid = new OAuthError(OAuthErrorCode.InvalidToken, "Access token is invalid or expired");
    if (!token.startsWith(ACCESS_TOKEN_PREFIX)) throw invalid;
    const record = this.tokens.find(sha256(token));
    if (!record || record.kind !== "access" || record.expiresAt < this.clock()) throw invalid;
    const grant = this.grants.find(record.grantId);
    if (!grant) throw invalid;
    return {
      token,
      clientId: grant.clientId,
      scopes: grant.scopes,
      expiresAt: Math.floor(record.expiresAt / 1000),
      resource: new URL(grant.resource),
      extra: { grantId: grant.id },
    };
  }

  /** RFC 7009: revoking either token ends the whole grant. Unknown tokens are ignored. */
  revoke(token: string, clientId: string): void {
    const record = this.tokens.find(sha256(token));
    if (!record) return;
    const grant = this.grants.find(record.grantId);
    if (grant && grant.clientId === clientId) this.grants.delete(grant.id);
  }

  private issueTokens(grant: Grant): OAuthTokens {
    const now = this.clock();
    const accessToken = randomToken(ACCESS_TOKEN_PREFIX);
    const refreshToken = randomToken(REFRESH_TOKEN_PREFIX);
    this.tokens.save({ tokenHash: sha256(accessToken), grantId: grant.id, kind: "access", expiresAt: now + this.lifetimes.accessMs });
    this.tokens.save({ tokenHash: sha256(refreshToken), grantId: grant.id, kind: "refresh", expiresAt: now + this.lifetimes.refreshMs });
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: Math.floor(this.lifetimes.accessMs / 1000),
      refresh_token: refreshToken,
      scope: grant.scopes.join(" ") || undefined,
    };
  }
}

/** Compare resource indicators ignoring one trailing slash, as the SDK's bearer check does. */
export function sameResource(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/#.*$/, "").replace(/\/$/, "");
  return norm(a) === norm(b);
}
