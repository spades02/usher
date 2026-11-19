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

  saveCode(code: CodeRecord): Promise<void>;
  /** Must be atomic: exactly one caller ever sees `firstUse: true`. */
  consumeCode(hash: string): Promise<Consumed<CodeRecord> | null>;

  saveToken(token: TokenRecord): Promise<void>;
  getToken(hash: string): Promise<TokenRecord | null>;
  /** Must be atomic: exactly one caller ever sees `firstUse: true` (refresh-token rotation). */
  consumeRefreshToken(hash: string): Promise<Consumed<TokenRecord> | null>;
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
  };
}
