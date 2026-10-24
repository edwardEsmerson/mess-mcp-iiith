// Decorates a MessApi so that a rejected portal key (revoked or expired) also ends the OAuth grant.
// The client's next request then gets a 401 from us and it sends the user through sign-in again.
//
// One 401 isn't proof the key is dead: a single endpoint can answer 401 by mistake, and ending the
// grant makes the student sign in again. So after a 401 we ask the portal who the key belongs to
// (/auth/me, the same call that accepted the key at sign-in) and only revoke if that is refused too.

import { MessApiError, type MessApi, type Params } from "../api/client.js";

const IDENTITY_ENDPOINT = "/auth/me";

export class RevokeOnUnauthorized implements MessApi {
  // Shared by every failing call in this decorator's lifetime (one MCP request), so a tool that fans
  // out to several endpoints rechecks and revokes once, not once per call
  private recheck?: Promise<boolean>;

  constructor(
    private readonly inner: MessApi,
    private readonly onUnauthorized: () => void,
  ) {}

  get<T>(endpoint: string, params?: Params): Promise<T> {
    return this.guard(endpoint, () => this.inner.get<T>(endpoint, params));
  }

  post<T>(endpoint: string, body?: unknown): Promise<T> {
    return this.guard(endpoint, () => this.inner.post<T>(endpoint, body));
  }

  put<T>(endpoint: string, body?: unknown): Promise<T> {
    return this.guard(endpoint, () => this.inner.put<T>(endpoint, body));
  }

  delete<T>(endpoint: string, params?: Params): Promise<T> {
    return this.guard(endpoint, () => this.inner.delete<T>(endpoint, params));
  }

  private async guard<T>(endpoint: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof MessApiError) || error.status !== 401) throw error;
      // The identity check failing is already the answer, so don't ask the same question again
      const keyRejected = endpoint === IDENTITY_ENDPOINT ? this.revoke() : await this.keyIsRejected();
      if (keyRejected) throw new MessApiError(`${error.message} Reconnect this app to sign in with a new key.`, 401);
      throw error;
    }
  }

  private keyIsRejected(): Promise<boolean> {
    // Only a second 401 counts. A network error or a portal 5xx says nothing about the key.
    this.recheck ??= this.inner.get(IDENTITY_ENDPOINT).then(
      () => false,
      (error) => (error instanceof MessApiError && error.status === 401 ? this.revoke() : false),
    );
    return this.recheck;
  }

  private revoke(): true {
    this.onUnauthorized();
    return true;
  }
}
