// In-memory versions of the repository interfaces in src/auth/model.ts, for unit tests that
// shouldn't need a database. They behave like the SQLite ones (see test/repositories.test.mjs):
// stored values are copies, a code can be taken once, and deleting a grant removes its codes and tokens.

const copy = (value) => (value === undefined ? undefined : structuredClone(value));

export class MemoryClientRepository {
  clients = new Map();

  find(clientId) {
    return copy(this.clients.get(clientId));
  }

  save(client) {
    this.clients.set(client.clientId, copy(client));
  }
}

export class MemoryGrantRepository {
  grants = new Map();
  /** Told when a grant goes, so its codes and tokens can go with it (ON DELETE CASCADE in SQLite). */
  onDelete = [];

  save(grant) {
    this.grants.set(grant.id, copy(grant));
  }

  find(id) {
    return copy(this.grants.get(id));
  }

  delete(id) {
    this.grants.delete(id);
    for (const cascade of this.onDelete) cascade(id);
  }
}

export class MemoryCodeRepository {
  codes = new Map();

  save(code) {
    this.codes.set(code.codeHash, copy(code));
  }

  take(codeHash) {
    const code = this.codes.get(codeHash);
    this.codes.delete(codeHash);
    return copy(code);
  }
}

export class MemoryTokenRepository {
  tokens = new Map();

  save(token) {
    this.tokens.set(token.tokenHash, copy(token));
  }

  find(tokenHash) {
    return copy(this.tokens.get(tokenHash));
  }

  markUsed(tokenHash, at) {
    const token = this.tokens.get(tokenHash);
    if (token) token.usedAt = at;
  }
}

/** One set of repositories sharing a store, wired so that deleting a grant cascades. */
export function memoryRepositories() {
  const clients = new MemoryClientRepository();
  const grants = new MemoryGrantRepository();
  const codes = new MemoryCodeRepository();
  const tokens = new MemoryTokenRepository();
  grants.onDelete.push((grantId) => {
    for (const [hash, code] of codes.codes) if (code.grantId === grantId) codes.codes.delete(hash);
    for (const [hash, token] of tokens.tokens) if (token.grantId === grantId) tokens.tokens.delete(hash);
  });
  return { clients, grants, codes, tokens };
}
