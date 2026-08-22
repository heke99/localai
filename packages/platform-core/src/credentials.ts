import type { ScopedCredential } from "./tools";

export interface CredentialIssuer {
  issue(input: { actorId: string; connectionId: string; resource: string; capabilities: string[]; ttlSeconds: number }): Promise<ScopedCredential>;
  revoke(token: string): Promise<void>;
}

export class CredentialBroker {
  constructor(private readonly issuer: CredentialIssuer, private readonly maximumTtlSeconds = 900) {}

  async lease(input: { actorId: string; connectionId: string; resource: string; capabilities: string[]; ttlSeconds: number }): Promise<ScopedCredential> {
    if (!input.actorId || !input.connectionId || !input.resource || input.capabilities.length === 0) throw new Error("invalid_credential_scope");
    if (input.ttlSeconds < 1 || input.ttlSeconds > this.maximumTtlSeconds) throw new Error("credential_ttl_exceeded");
    return this.issuer.issue(input);
  }
}
