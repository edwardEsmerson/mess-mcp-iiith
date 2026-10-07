// Domain types and the storage interfaces the auth services depend on.
// Services take these interfaces, never a concrete database, so storage can be swapped or faked.

export interface OAuthClient {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
}

/** One user's consent for one client: holds their sealed dining key. Revoking it kills every token issued under it. */
export interface Grant {
  id: string;
  clientId: string;
  resource: string;
  scopes: string[];
  sealedKey: string;
  createdAt: number;
}

export interface AuthorizationCode {
  codeHash: string;
  grantId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  expiresAt: number;
}

export type TokenKind = "access" | "refresh";

export interface TokenRecord {
  tokenHash: string;
  grantId: string;
  kind: TokenKind;
  expiresAt: number;
  usedAt?: number;
}

export interface ClientRepository {
  find(clientId: string): OAuthClient | undefined;
  save(client: OAuthClient): void;
}

export interface GrantRepository {
  save(grant: Grant): void;
  find(id: string): Grant | undefined;
  delete(id: string): void;
}

export interface CodeRepository {
  save(code: AuthorizationCode): void;
  /** Returns and deletes the code, so it can only be redeemed once. */
  take(codeHash: string): AuthorizationCode | undefined;
}

export interface TokenRepository {
  save(token: TokenRecord): void;
  find(tokenHash: string): TokenRecord | undefined;
  markUsed(tokenHash: string, at: number): void;
}

export interface Housekeeping {
  deleteExpired(now: number): void;
}

export type Clock = () => number;
export const systemClock: Clock = () => Date.now();
