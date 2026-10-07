// Decorates a MessApi so that a portal 401 (key revoked or expired) also ends the OAuth grant.
// The client's next request then gets a 401 from us and it sends the user through sign-in again.

import { MessApiError, type MessApi, type Params } from "../api/client.js";

export class RevokeOnUnauthorized implements MessApi {
  constructor(
    private readonly inner: MessApi,
    private readonly onUnauthorized: () => void,
  ) {}

  get<T>(endpoint: string, params?: Params): Promise<T> {
    return this.guard(() => this.inner.get<T>(endpoint, params));
  }

  post<T>(endpoint: string, body?: unknown): Promise<T> {
    return this.guard(() => this.inner.post<T>(endpoint, body));
  }

  put<T>(endpoint: string, body?: unknown): Promise<T> {
    return this.guard(() => this.inner.put<T>(endpoint, body));
  }

  delete<T>(endpoint: string, params?: Params): Promise<T> {
    return this.guard(() => this.inner.delete<T>(endpoint, params));
  }

  private async guard<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof MessApiError && error.status === 401) {
        this.onUnauthorized();
        throw new MessApiError(`${error.message} Reconnect this app to sign in with a new key.`, 401);
      }
      throw error;
    }
  }
}
