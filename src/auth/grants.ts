// Grants hold a user's sealed dining key for one client. This is the only place keys are sealed or unsealed.

import { randomUUID } from "node:crypto";
import type { MessApi } from "../api/client.js";
import { MessApiError } from "../api/client.js";
import type { SecretBox } from "./crypto.js";
import type { Clock, Grant, GrantRepository } from "./model.js";

export class GrantService {
  constructor(
    private readonly grants: GrantRepository,
    private readonly box: SecretBox,
    private readonly clock: Clock,
  ) {}

  create(input: { clientId: string; resource: string; scopes: string[]; diningKey: string }): Grant {
    const grant: Grant = {
      id: randomUUID(),
      clientId: input.clientId,
      resource: input.resource,
      scopes: input.scopes,
      sealedKey: this.box.seal(input.diningKey),
      createdAt: this.clock(),
    };
    this.grants.save(grant);
    return grant;
  }

  diningKeyFor(grantId: string): string | undefined {
    const grant = this.grants.find(grantId);
    return grant && this.box.open(grant.sealedKey);
  }

  revoke(grantId: string): void {
    this.grants.delete(grantId);
  }
}

export type KeyCheck = "valid" | "rejected";

export interface DiningKeyValidator {
  /** "rejected" if the portal refuses the key; throws if the portal can't be asked. */
  check(diningKey: string): Promise<KeyCheck>;
}

export class PortalKeyValidator implements DiningKeyValidator {
  constructor(private readonly apiFor: (diningKey: string) => MessApi) {}

  async check(diningKey: string): Promise<KeyCheck> {
    try {
      await this.apiFor(diningKey).get("/auth/me");
      return "valid";
    } catch (error) {
      if (error instanceof MessApiError && (error.status === 401 || error.status === 403)) return "rejected";
      throw error;
    }
  }
}
