/**
 * Storage contract for the auth layer.
 *
 * Phase 3 ships only the in-memory implementation. Phase 6 adds database
 * adapters behind this same interface. Secrets (codes, tokens) are only ever
 * stored as SHA-256 hashes, so a leaked database can't be replayed.
 */

export interface ClientRecord {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  clientUri?: string;
  logoUri?: string;
  /** `cimd`: identity is proven by the HTTPS domain hosting the metadata. `dcr`: self-asserted. */
  source: "cimd" | "dcr";
  createdAt: number;
}

/** A customer's standing permission for one agent. Revoking it kills every token issued under it. */
export interface GrantRecord {
  id: string;
  userId: string;
  clientId: string;
  clientName: string;
  clientSource: ClientRecord["source"];
  scopes: string[];
  createdAt: number;
  revokedAt?: number;
}

export interface CodeRecord {
  hash: string;
  grantId: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  expiresAt: number;
}

export interface TokenRecord {
  hash: string;
  kind: "access" | "refresh";
  grantId: string;
  clientId: string;
  userId: string;
  resource: string;
  expiresAt: number;
}

/**
 * A destructive call waiting for the customer's approval (ADR 0005). It is
 * bound to one grant, one tool and one exact input, and can be used once.
 */
export interface ConfirmationRecord {
  /** Unguessable id; also the path segment of the approval page. */
  id: string;
  grantId: string;
  userId: string;
  clientName: string;
  tool: string;
  /** SHA-256 of the canonical JSON input. A retry with different arguments needs a new approval. */
  inputHash: string;
  /** Plain-words description shown to the customer. */
  summary: string;
  /** Pretty-printed input, shown to the customer. */
  details: string;
  status: "pending" | "approved" | "denied";
  createdAt: number;
  expiresAt: number;
  decidedAt?: number;
}

/** Result of atomically consuming a single-use secret. `firstUse: false` signals replay. */
export interface Consumed<T> {
  record: T;
  firstUse: boolean;
}

export interface AuthStore {
  getClient(clientId: string): Promise<ClientRecord | null>;
  saveClient(client: ClientRecord): Promise<void>;

  saveGrant(grant: GrantRecord): Promise<void>;
  getGrant(id: string): Promise<GrantRecord | null>;
  findActiveGrant(userId: string, clientId: string): Promise<GrantRecord | null>;
  listGrants(userId: string): Promise<GrantRecord[]>;
  revokeGrant(id: string, at: number): Promise<void>;
  /** Replaces the tools a grant allows. Takes effect on the agent's next call. */
  updateGrantScopes(id: string, scopes: string[]): Promise<void>;

  saveCode(code: CodeRecord): Promise<void>;
  /** Must be atomic: exactly one caller ever sees `firstUse: true`. */
  consumeCode(hash: string): Promise<Consumed<CodeRecord> | null>;

  saveToken(token: TokenRecord): Promise<void>;
  getToken(hash: string): Promise<TokenRecord | null>;
  /** Must be atomic: exactly one caller ever sees `firstUse: true` (refresh-token rotation). */
  consumeRefreshToken(hash: string): Promise<Consumed<TokenRecord> | null>;

  saveConfirmation(confirmation: ConfirmationRecord): Promise<void>;
  getConfirmation(id: string): Promise<ConfirmationRecord | null>;
  /** The most recent unexpired, unconsumed confirmation for this exact call, if any. */
  findConfirmation(grantId: string, tool: string, inputHash: string, now: number): Promise<ConfirmationRecord | null>;
  /** Moves a pending confirmation to approved or denied. Returns false if it wasn't pending. */
  decideConfirmation(id: string, status: "approved" | "denied", at: number): Promise<boolean>;
  /** Must be atomic: returns true for exactly one caller, after which the confirmation is gone. */
  consumeConfirmation(id: string): Promise<boolean>;
}

/**
 * In-memory store, for development and tests only. Everything is lost on
 * restart and isn't shared across instances.
 */
export function memoryStore(): AuthStore {
  const clients = new Map<string, ClientRecord>();
  const grants = new Map<string, GrantRecord>();
  const codes = new Map<string, CodeRecord & { used: boolean }>();
  const tokens = new Map<string, TokenRecord & { used: boolean }>();
  const confirmations = new Map<string, ConfirmationRecord>();

  return {
    async getClient(id) {
      return clients.get(id) ?? null;
    },
    async saveClient(client) {
      clients.set(client.clientId, client);
    },
    async saveGrant(grant) {
      grants.set(grant.id, grant);
    },
    async getGrant(id) {
      return grants.get(id) ?? null;
    },
    async findActiveGrant(userId, clientId) {
      for (const grant of grants.values()) {
        if (grant.userId === userId && grant.clientId === clientId && !grant.revokedAt) return grant;
      }
      return null;
    },
    async listGrants(userId) {
      return [...grants.values()].filter((g) => g.userId === userId);
    },
    async revokeGrant(id, at) {
      const grant = grants.get(id);
      if (grant && !grant.revokedAt) grant.revokedAt = at;
    },
    async updateGrantScopes(id, scopes) {
      const grant = grants.get(id);
      if (grant) grant.scopes = [...scopes];
    },
    async saveCode(code) {
      codes.set(code.hash, { ...code, used: false });
    },
    async consumeCode(hash) {
      const entry = codes.get(hash);
      if (!entry) return null;
      const firstUse = !entry.used;
      entry.used = true;
      const { used: _, ...record } = entry;
      return { record, firstUse };
    },
    async saveToken(token) {
      tokens.set(token.hash, { ...token, used: false });
    },
    async getToken(hash) {
      const entry = tokens.get(hash);
      if (!entry) return null;
      const { used: _, ...record } = entry;
      return record;
    },
    async consumeRefreshToken(hash) {
      const entry = tokens.get(hash);
      if (!entry || entry.kind !== "refresh") return null;
      const firstUse = !entry.used;
      entry.used = true;
      const { used: _, ...record } = entry;
      return { record, firstUse };
    },
    async saveConfirmation(confirmation) {
      confirmations.set(confirmation.id, { ...confirmation });
    },
    async getConfirmation(id) {
      const entry = confirmations.get(id);
      return entry ? { ...entry } : null;
    },
    async findConfirmation(grantId, tool, inputHash, now) {
      let latest: ConfirmationRecord | null = null;
      for (const c of confirmations.values()) {
        if (c.grantId !== grantId || c.tool !== tool || c.inputHash !== inputHash || c.expiresAt < now) continue;
        if (!latest || c.createdAt >= latest.createdAt) latest = c;
      }
      return latest ? { ...latest } : null;
    },
    async decideConfirmation(id, status, at) {
      const entry = confirmations.get(id);
      if (!entry || entry.status !== "pending") return false;
      entry.status = status;
      entry.decidedAt = at;
      return true;
    },
    async consumeConfirmation(id) {
      return confirmations.delete(id);
    },
  };
}
