import type {
  AuthStore,
  ClientRecord,
  CodeRecord,
  ConfirmationRecord,
  GrantRecord,
  TokenRecord,
} from "../auth/store.js";
import type { AuditQuery, QueryableAuditSink } from "../plugins/audit-log.js";
import type { RateLimitStore } from "../plugins/rate-limit.js";
import type { UsherEvent } from "../plugins/types.js";

/**
 * The only thing Usher needs from your database driver (ADR 0007): run one
 * statement with positional parameters and return its rows. Write it with
 * `?` placeholders; Usher rewrites them to `$1, $2…` for Postgres.
 *
 * Ready-made wrappers: {@link postgresExecutor} (pg, PGlite, Neon,
 * Vercel Postgres) and {@link sqliteExecutor} (node:sqlite, better-sqlite3, Bun).
 */
export interface SqlExecutor {
  dialect: "postgres" | "sqlite";
  query(sql: string, params: unknown[]): Promise<Record<string, unknown>[]>;
}

/** Wraps any client with `query(text, params) → { rows }`: pg Pool/Client, PGlite, @neondatabase/serverless. */
export function postgresExecutor(client: {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}): SqlExecutor {
  return {
    dialect: "postgres",
    async query(sql, params) {
      let i = 0;
      const text = sql.replace(/\?/g, () => `$${++i}`);
      return (await client.query(text, params)).rows as Record<string, unknown>[];
    },
  };
}

/** Wraps any client with `prepare(sql).all(...params)`: node:sqlite, better-sqlite3, bun:sqlite. */
export function sqliteExecutor(db: {
  prepare(sql: string): { all(...params: any[]): unknown[] };
}): SqlExecutor {
  return {
    dialect: "sqlite",
    async query(sql, params) {
      return db.prepare(sql).all(...(params as any[])) as Record<string, unknown>[];
    },
  };
}

export interface SqlStorageOptions {
  /** Prefix for every table Usher creates. Default: `usher_`. */
  tablePrefix?: string;
}

/**
 * Versioned schema. Each statement is idempotent (`IF NOT EXISTS`), so
 * migrating from several instances at once, or over a pooled connection
 * without a transaction, is safe. Never edit a shipped version: add one.
 */
function migrations(dialect: SqlExecutor["dialect"], p: string): { version: number; statements: string[] }[] {
  const serial = dialect === "postgres" ? "BIGSERIAL PRIMARY KEY" : "INTEGER PRIMARY KEY AUTOINCREMENT";
  return [
    {
      version: 1,
      statements: [
        `CREATE TABLE IF NOT EXISTS ${p}clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  client_uri TEXT,
  logo_uri TEXT,
  source TEXT NOT NULL,
  created_at BIGINT NOT NULL
)`,
        `CREATE TABLE IF NOT EXISTS ${p}grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  client_source TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  revoked_at BIGINT
)`,
        `CREATE INDEX IF NOT EXISTS ${p}grants_user_client ON ${p}grants (user_id, client_id)`,
        `CREATE TABLE IF NOT EXISTS ${p}codes (
  hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  resource TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
)`,
        `CREATE TABLE IF NOT EXISTS ${p}tokens (
  hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
)`,
        `CREATE INDEX IF NOT EXISTS ${p}tokens_expires ON ${p}tokens (expires_at)`,
        `CREATE TABLE IF NOT EXISTS ${p}confirmations (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  tool TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  summary TEXT NOT NULL,
  details TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  decided_at BIGINT
)`,
        `CREATE INDEX IF NOT EXISTS ${p}confirmations_call ON ${p}confirmations (grant_id, tool, input_hash)`,
        `CREATE TABLE IF NOT EXISTS ${p}audit_events (
  id ${serial},
  at BIGINT NOT NULL,
  type TEXT NOT NULL,
  user_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  event TEXT NOT NULL
)`,
        `CREATE INDEX IF NOT EXISTS ${p}audit_events_user ON ${p}audit_events (user_id, id)`,
        `CREATE INDEX IF NOT EXISTS ${p}audit_events_grant ON ${p}audit_events (grant_id, id)`,
        `CREATE TABLE IF NOT EXISTS ${p}rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at BIGINT NOT NULL
)`,
      ],
    },
  ];
}

const PREFIX = /^[A-Za-z_][A-Za-z0-9_]{0,30}$/;

function prefixOf(options: SqlStorageOptions): string {
  const prefix = options.tablePrefix ?? "usher_";
  if (!PREFIX.test(prefix)) throw new Error("[usher] tablePrefix must match /^[A-Za-z_][A-Za-z0-9_]*$/");
  return prefix;
}

/** The full schema as SQL text, for teams that run migrations with their own tool (`npx usherjs sql`). */
export function schemaSql(dialect: SqlExecutor["dialect"], options: SqlStorageOptions = {}): string {
  const p = prefixOf(options);
  return migrations(dialect, p)
    .flatMap((m) => [`-- usher migration ${m.version}`, ...m.statements.map((s) => `${s};`)])
    .join("\n\n");
}

const num = (value: unknown) => Number(value);
const optNum = (value: unknown) => (value === null || value === undefined ? undefined : Number(value));
const optStr = (value: unknown) => (value === null || value === undefined ? undefined : String(value));

/**
 * Durable storage for everything Usher keeps (ADR 0007): grants, tokens,
 * approvals, audit events and rate-limit counters, in your own database.
 *
 * ```ts
 * const storage = sqlStorage(postgresExecutor(pool));
 * await storage.migrate();
 * createUsher({ store: storage.store, plugins: [auditLog({ sink: storage.auditSink })], ... });
 * ```
 */
export function sqlStorage(db: SqlExecutor, options: SqlStorageOptions = {}) {
  const p = prefixOf(options);
  const q = (sql: string, params: unknown[] = []) => db.query(sql, params);
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0] ?? null;

  const toClient = (r: Record<string, unknown>): ClientRecord => ({
    clientId: String(r.client_id),
    clientName: String(r.client_name),
    redirectUris: JSON.parse(String(r.redirect_uris)),
    ...(r.client_uri != null ? { clientUri: String(r.client_uri) } : {}),
    ...(r.logo_uri != null ? { logoUri: String(r.logo_uri) } : {}),
    source: r.source as ClientRecord["source"],
    createdAt: num(r.created_at),
  });
  const toGrant = (r: Record<string, unknown>): GrantRecord => ({
    id: String(r.id),
    userId: String(r.user_id),
    clientId: String(r.client_id),
    clientName: String(r.client_name),
    clientSource: r.client_source as GrantRecord["clientSource"],
    scopes: JSON.parse(String(r.scopes)),
    createdAt: num(r.created_at),
    ...(r.revoked_at != null ? { revokedAt: num(r.revoked_at) } : {}),
  });
  const toCode = (r: Record<string, unknown>): CodeRecord => ({
    hash: String(r.hash),
    grantId: String(r.grant_id),
    clientId: String(r.client_id),
    userId: String(r.user_id),
    redirectUri: String(r.redirect_uri),
    codeChallenge: String(r.code_challenge),
    resource: String(r.resource),
    expiresAt: num(r.expires_at),
  });
  const toToken = (r: Record<string, unknown>): TokenRecord => ({
    hash: String(r.hash),
    kind: r.kind as TokenRecord["kind"],
    grantId: String(r.grant_id),
    clientId: String(r.client_id),
    userId: String(r.user_id),
    resource: String(r.resource),
    expiresAt: num(r.expires_at),
  });
  const toConfirmation = (r: Record<string, unknown>): ConfirmationRecord => ({
    id: String(r.id),
    grantId: String(r.grant_id),
    userId: String(r.user_id),
    clientName: String(r.client_name),
    tool: String(r.tool),
    inputHash: String(r.input_hash),
    summary: String(r.summary),
    details: String(r.details),
    status: r.status as ConfirmationRecord["status"],
    createdAt: num(r.created_at),
    expiresAt: num(r.expires_at),
    ...(r.decided_at != null ? { decidedAt: num(r.decided_at) } : {}),
  });

  /**
   * Atomic single use: the conditional UPDATE succeeds for exactly one
   * caller. Everyone else sees the row as already used (a replay).
   */
  async function consume<T>(table: string, extra: string, hash: string, map: (r: Record<string, unknown>) => T) {
    const won = await one(`UPDATE ${p}${table} SET used = 1 WHERE hash = ? AND used = 0${extra} RETURNING *`, [hash]);
    if (won) return { record: map(won), firstUse: true };
    const seen = await one(`SELECT * FROM ${p}${table} WHERE hash = ?${extra}`, [hash]);
    return seen ? { record: map(seen), firstUse: false } : null;
  }

  const store: AuthStore = {
    async getClient(clientId) {
      const row = await one(`SELECT * FROM ${p}clients WHERE client_id = ?`, [clientId]);
      return row ? toClient(row) : null;
    },
    async saveClient(c) {
      await q(
        `INSERT INTO ${p}clients (client_id, client_name, redirect_uris, client_uri, logo_uri, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (client_id) DO UPDATE SET client_name = excluded.client_name, redirect_uris = excluded.redirect_uris,
           client_uri = excluded.client_uri, logo_uri = excluded.logo_uri, source = excluded.source`,
        [c.clientId, c.clientName, JSON.stringify(c.redirectUris), c.clientUri ?? null, c.logoUri ?? null, c.source, c.createdAt],
      );
    },

    async saveGrant(g) {
      await q(
        `INSERT INTO ${p}grants (id, user_id, client_id, client_name, client_source, scopes, created_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [g.id, g.userId, g.clientId, g.clientName, g.clientSource, JSON.stringify(g.scopes), g.createdAt, g.revokedAt ?? null],
      );
    },
    async getGrant(id) {
      const row = await one(`SELECT * FROM ${p}grants WHERE id = ?`, [id]);
      return row ? toGrant(row) : null;
    },
    async findActiveGrant(userId, clientId) {
      const row = await one(
        `SELECT * FROM ${p}grants WHERE user_id = ? AND client_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`,
        [userId, clientId],
      );
      return row ? toGrant(row) : null;
    },
    async listGrants(userId) {
      return (await q(`SELECT * FROM ${p}grants WHERE user_id = ? ORDER BY created_at`, [userId])).map(toGrant);
    },
    async revokeGrant(id, at) {
      await q(`UPDATE ${p}grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, [at, id]);
    },
    async updateGrantScopes(id, scopes) {
      await q(`UPDATE ${p}grants SET scopes = ? WHERE id = ?`, [JSON.stringify(scopes), id]);
    },

    async saveCode(c) {
      await q(
        `INSERT INTO ${p}codes (hash, grant_id, client_id, user_id, redirect_uri, code_challenge, resource, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [c.hash, c.grantId, c.clientId, c.userId, c.redirectUri, c.codeChallenge, c.resource, c.expiresAt],
      );
    },
    consumeCode: (hash) => consume("codes", "", hash, toCode),

    async saveToken(t) {
      await q(
        `INSERT INTO ${p}tokens (hash, kind, grant_id, client_id, user_id, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [t.hash, t.kind, t.grantId, t.clientId, t.userId, t.resource, t.expiresAt],
      );
    },
    async getToken(hash) {
      const row = await one(`SELECT * FROM ${p}tokens WHERE hash = ?`, [hash]);
      return row ? toToken(row) : null;
    },
    consumeRefreshToken: (hash) => consume("tokens", " AND kind = 'refresh'", hash, toToken),

    async saveConfirmation(c) {
      await q(
        `INSERT INTO ${p}confirmations (id, grant_id, user_id, client_name, tool, input_hash, summary, details, status, created_at, expires_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [c.id, c.grantId, c.userId, c.clientName, c.tool, c.inputHash, c.summary, c.details, c.status, c.createdAt, c.expiresAt, c.decidedAt ?? null],
      );
    },
    async getConfirmation(id) {
      const row = await one(`SELECT * FROM ${p}confirmations WHERE id = ?`, [id]);
      return row ? toConfirmation(row) : null;
    },
    async findConfirmation(grantId, tool, inputHash, now) {
      const row = await one(
        `SELECT * FROM ${p}confirmations WHERE grant_id = ? AND tool = ? AND input_hash = ? AND expires_at >= ?
         ORDER BY created_at DESC LIMIT 1`,
        [grantId, tool, inputHash, now],
      );
      return row ? toConfirmation(row) : null;
    },
    async decideConfirmation(id, status, at) {
      return (
        (await q(`UPDATE ${p}confirmations SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending' RETURNING id`, [
          status,
          at,
          id,
        ])).length === 1
      );
    },
    async consumeConfirmation(id) {
      return (await q(`DELETE FROM ${p}confirmations WHERE id = ? RETURNING id`, [id])).length === 1;
    },
  };

  const auditSink: QueryableAuditSink = {
    async write(event) {
      await q(`INSERT INTO ${p}audit_events (at, type, user_id, grant_id, event) VALUES (?, ?, ?, ?, ?)`, [
        event.at,
        event.type,
        event.userId,
        event.grantId,
        JSON.stringify(event),
      ]);
    },
    async list({ userId, grantId, type, limit = 100 }: AuditQuery = {}) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (userId) (where.push("user_id = ?"), params.push(userId));
      if (grantId) (where.push("grant_id = ?"), params.push(grantId));
      if (type) (where.push("type = ?"), params.push(type));
      params.push(Math.max(1, Math.min(1000, Math.floor(limit))));
      const rows = await q(
        `SELECT event FROM ${p}audit_events${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`,
        params,
      );
      return rows.map((r) => JSON.parse(String(r.event)) as UsherEvent);
    },
  };

  const rateLimitStore: RateLimitStore = {
    // One atomic upsert: start a new window if the old one ended, otherwise count.
    async hit(key, windowSeconds, now) {
      const resetAt = now + windowSeconds * 1000;
      const row = await one(
        `INSERT INTO ${p}rate_limits (key, count, reset_at) VALUES (?, 1, ?)
         ON CONFLICT (key) DO UPDATE SET
           count = CASE WHEN ${p}rate_limits.reset_at <= ? THEN 1 ELSE ${p}rate_limits.count + 1 END,
           reset_at = CASE WHEN ${p}rate_limits.reset_at <= ? THEN excluded.reset_at ELSE ${p}rate_limits.reset_at END
         RETURNING count, reset_at`,
        [key, resetAt, now, now],
      );
      return { count: num(row!.count), resetAt: num(row!.reset_at) };
    },
  };

  return {
    store,
    auditSink,
    rateLimitStore,

    /** Creates or upgrades Usher's tables. Idempotent: safe on every boot and from several instances at once. */
    async migrate(): Promise<{ applied: number[] }> {
      await q(`CREATE TABLE IF NOT EXISTS ${p}migrations (version INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)`);
      const done = new Set((await q(`SELECT version FROM ${p}migrations`)).map((r) => num(r.version)));
      const applied: number[] = [];
      for (const migration of migrations(db.dialect, p)) {
        if (done.has(migration.version)) continue;
        for (const statement of migration.statements) await q(statement);
        await q(`INSERT INTO ${p}migrations (version, applied_at) VALUES (?, ?) ON CONFLICT (version) DO NOTHING`, [
          migration.version,
          Date.now(),
        ]);
        applied.push(migration.version);
      }
      return { applied };
    },

    /**
     * Deletes what can never be used again. Run it on a schedule (hourly is
     * plenty). Codes and tokens are kept for a day past expiry, so replays
     * of recently expired secrets are still recognized.
     */
    async prune({ now = Date.now(), auditRetentionDays }: { now?: number; auditRetentionDays?: number } = {}) {
      const seconds = Math.floor(now / 1000);
      const grace = seconds - 24 * 3600;
      const count = async (sql: string, params: unknown[]) => (await q(`${sql} RETURNING 1`, params)).length;
      return {
        codes: await count(`DELETE FROM ${p}codes WHERE expires_at < ?`, [grace]),
        tokens: await count(`DELETE FROM ${p}tokens WHERE expires_at < ?`, [grace]),
        confirmations: await count(`DELETE FROM ${p}confirmations WHERE expires_at < ?`, [seconds]),
        rateLimits: await count(`DELETE FROM ${p}rate_limits WHERE reset_at <= ?`, [now]),
        auditEvents:
          auditRetentionDays === undefined
            ? 0
            : await count(`DELETE FROM ${p}audit_events WHERE at < ?`, [now - auditRetentionDays * 86_400_000]),
      };
    },
  };
}
