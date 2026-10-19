// SQLite implementations of the auth repositories, on Node's built-in node:sqlite.
// Only hashes of codes and tokens are stored; dining keys are stored sealed (see crypto.ts).

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AuthorizationCode,
  ClientRepository,
  CodeRepository,
  ConnectionCount,
  ConnectionStats,
  Grant,
  GrantRepository,
  Housekeeping,
  OAuthClient,
  TokenKind,
  TokenRecord,
  TokenRepository,
} from "./model.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT,
  redirect_uris TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  scopes TEXT NOT NULL,
  sealed_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS codes (
  code_hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS tokens_grant ON tokens(grant_id);
`;

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

type Row = Record<string, unknown>;

export class SqliteClientRepository implements ClientRepository {
  constructor(private readonly db: DatabaseSync) {}

  find(clientId: string): OAuthClient | undefined {
    const row = this.db.prepare("SELECT * FROM clients WHERE client_id = ?").get(clientId) as Row | undefined;
    if (!row) return undefined;
    return {
      clientId: row.client_id as string,
      clientName: (row.client_name as string | null) ?? undefined,
      redirectUris: JSON.parse(row.redirect_uris as string),
    };
  }

  save(client: OAuthClient): void {
    this.db
      .prepare("INSERT INTO clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)")
      .run(client.clientId, client.clientName ?? null, JSON.stringify(client.redirectUris), Date.now());
  }
}

export class SqliteGrantRepository implements GrantRepository {
  constructor(private readonly db: DatabaseSync) {}

  save(grant: Grant): void {
    this.db
      .prepare("INSERT INTO grants (id, client_id, resource, scopes, sealed_key, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(grant.id, grant.clientId, grant.resource, grant.scopes.join(" "), grant.sealedKey, grant.createdAt);
  }

  find(id: string): Grant | undefined {
    const row = this.db.prepare("SELECT * FROM grants WHERE id = ?").get(id) as Row | undefined;
    if (!row) return undefined;
    return {
      id: row.id as string,
      clientId: row.client_id as string,
      resource: row.resource as string,
      scopes: (row.scopes as string).split(" ").filter(Boolean),
      sealedKey: row.sealed_key as string,
      createdAt: row.created_at as number,
    };
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM grants WHERE id = ?").run(id);
  }
}

export class SqliteCodeRepository implements CodeRepository {
  constructor(private readonly db: DatabaseSync) {}

  save(code: AuthorizationCode): void {
    this.db
      .prepare("INSERT INTO codes (code_hash, grant_id, client_id, redirect_uri, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(code.codeHash, code.grantId, code.clientId, code.redirectUri, code.codeChallenge, code.expiresAt);
  }

  take(codeHash: string): AuthorizationCode | undefined {
    const row = this.db.prepare("DELETE FROM codes WHERE code_hash = ? RETURNING *").get(codeHash) as Row | undefined;
    if (!row) return undefined;
    return {
      codeHash: row.code_hash as string,
      grantId: row.grant_id as string,
      clientId: row.client_id as string,
      redirectUri: row.redirect_uri as string,
      codeChallenge: row.code_challenge as string,
      expiresAt: row.expires_at as number,
    };
  }
}

export class SqliteTokenRepository implements TokenRepository {
  constructor(private readonly db: DatabaseSync) {}

  save(token: TokenRecord): void {
    this.db
      .prepare("INSERT INTO tokens (token_hash, grant_id, kind, expires_at, used_at) VALUES (?, ?, ?, ?, ?)")
      .run(token.tokenHash, token.grantId, token.kind, token.expiresAt, token.usedAt ?? null);
  }

  find(tokenHash: string): TokenRecord | undefined {
    const row = this.db.prepare("SELECT * FROM tokens WHERE token_hash = ?").get(tokenHash) as Row | undefined;
    if (!row) return undefined;
    return {
      tokenHash: row.token_hash as string,
      grantId: row.grant_id as string,
      kind: row.kind as TokenKind,
      expiresAt: row.expires_at as number,
      usedAt: (row.used_at as number | null) ?? undefined,
    };
  }

  markUsed(tokenHash: string, at: number): void {
    this.db.prepare("UPDATE tokens SET used_at = ? WHERE token_hash = ?").run(at, tokenHash);
  }
}

export class SqliteHousekeeping implements Housekeeping {
  constructor(private readonly db: DatabaseSync) {}

  deleteExpired(now: number): void {
    this.db.prepare("DELETE FROM codes WHERE expires_at < ?").run(now);
    this.db.prepare("DELETE FROM tokens WHERE expires_at < ?").run(now);
    // A grant with no live tokens and no pending code can never be used again
    this.db
      .prepare(
        `DELETE FROM grants WHERE created_at < ?
           AND NOT EXISTS (SELECT 1 FROM tokens WHERE tokens.grant_id = grants.id)
           AND NOT EXISTS (SELECT 1 FROM codes WHERE codes.grant_id = grants.id)`,
      )
      .run(now - 60 * 60 * 1000);
  }
}

export class SqliteConnectionStats implements ConnectionStats {
  constructor(private readonly db: DatabaseSync) {}

  connectedByClient(now: number): ConnectionCount[] {
    const rows = this.db
      .prepare(
        `SELECT g.client_id, c.client_name, COUNT(DISTINCT g.id) AS n
           FROM grants g
           JOIN tokens t ON t.grant_id = g.id AND t.kind = 'refresh' AND t.used_at IS NULL AND t.expires_at > ?
           LEFT JOIN clients c ON c.client_id = g.client_id
          GROUP BY g.client_id`,
      )
      .all(now) as Row[];
    return rows.map((row) => ({
      clientId: row.client_id as string,
      clientName: (row.client_name as string | null) ?? undefined,
      count: row.n as number,
    }));
  }
}
