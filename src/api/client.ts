// HTTP client for the mess portal API. One instance per API key, so a single
// HTTP server process can serve many users without sharing credentials.

interface ApiError {
  error?: { code?: string; message?: string };
}

export const DEFAULT_API_URL = "https://mess.iiit.ac.in/api";

export type Params = Record<string, string | number | undefined>;

// What the tools need from the portal. Tools depend on this, not on the HTTP client,
// so other layers can wrap it (see RevokeOnUnauthorized in auth/).
export interface MessApi {
  get<T>(endpoint: string, params?: Params): Promise<T>;
  post<T>(endpoint: string, body?: unknown): Promise<T>;
  put<T>(endpoint: string, body?: unknown): Promise<T>;
  delete<T>(endpoint: string, params?: Params): Promise<T>;
}

export class MessApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "MessApiError";
  }
}

export class MessApiClient implements MessApi {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = process.env.MESS_API_URL || DEFAULT_API_URL,
  ) {}

  get<T>(endpoint: string, params?: Params): Promise<T> {
    return this.request<T>("GET", endpoint, params);
  }

  post<T>(endpoint: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", endpoint, undefined, body);
  }

  put<T>(endpoint: string, body?: unknown): Promise<T> {
    return this.request<T>("PUT", endpoint, undefined, body);
  }

  delete<T>(endpoint: string, params?: Params): Promise<T> {
    return this.request<T>("DELETE", endpoint, params);
  }

  private async request<T>(method: string, endpoint: string, params?: Params, body?: unknown): Promise<T> {
    const url = new URL(this.baseUrl.replace(/\/$/, "") + endpoint);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: { Authorization: this.apiKey, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      // Most often the server is not on the IIITH network, so the portal is unreachable
      const reason = error instanceof Error ? error.message : String(error);
      throw new MessApiError(`Could not reach the mess portal at ${url.origin} (${reason}). It is only reachable from the IIITH network or VPN.`, 0);
    }

    if (!response.ok) {
      const errorBody = (await response.json().catch(() => ({}))) as ApiError;
      const message = errorBody.error?.message || `Mess portal returned ${response.status} ${response.statusText}`;
      if (response.status === 401) {
        throw new MessApiError(`The mess portal rejected the API key (${message}). It may be revoked or expired; create a new one at dining.iiit.ac.in -> Settings -> Auth Keys.`, 401);
      }
      throw new MessApiError(message, response.status);
    }

    if (response.status === 204) return {} as T;
    return (await response.json()) as T;
  }
}
