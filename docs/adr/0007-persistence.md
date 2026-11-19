# ADR 0007 — Persistence: one SQL adapter over a two-method executor, proven by a shared conformance suite

- **Status:** Accepted
- **Date:** 2026-11-20
- **Phase:** 6

## Context

Everything Usher remembers lived in memory: grants, tokens, approvals,
audit events and rate-limit counters. That means:

- a restart disconnects every customer's agent;
- two instances behind a load balancer disagree. A token issued on A is
  unknown on B, an approval made on B is invisible to A, and each instance
  keeps its own rate limit;
- the audit log disappears.

Phases 3–5 already put every bit of state behind interfaces (`AuthStore`,
`AuditSink`, `RateLimitStore`). Phase 6 decides how to implement them
durably.

The constraints:

1. **Use the app's own database.** Usher is in-process (ADR 0001) and
   should not demand new infrastructure. It also must not lock developers
   into an ORM.
2. **Security depends on atomicity.** Three properties only hold if the
   database enforces them, not the application:
   - a code or refresh token is consumed exactly once (replay detection);
   - an approval runs exactly once;
   - a confirmation is decided exactly once.
3. **It runs everywhere**: Node, Bun, Deno, edge runtimes, serverless with
   pooled connections.

## Options considered

### 1. One adapter per ORM (Drizzle, Prisma, Kysely, TypeORM...)
This is Better Auth's approach.
- ✅ Feels native in each stack, and the schema lives in the ORM's files.
- ❌ N adapters × M dialects to build, test and keep consistent. Each ORM
  has its own way of doing atomic updates, which is exactly where bugs
  would hide.
- ❌ Teams on Rails, Django or plain `pg` get nothing.

### 2. Key-value only (Redis, Upstash, Cloudflare KV)
- ✅ Native TTLs and fast atomic counters.
- ❌ Grants are relational: "list this customer's agents", "find the newest
  approval for this exact call". On KV we'd hand-maintain secondary indexes.
- ❌ Not durable enough for an audit log, and usually *not* the app's
  primary database.

### 3. One SQL adapter over a minimal executor (chosen)
Usher writes portable SQL. The app hands over a two-member object:

```ts
interface SqlExecutor {
  dialect: "postgres" | "sqlite";
  query(sql: string, params: unknown[]): Promise<Record<string, unknown>[]>;
}
```

- ✅ One implementation, with every atomic operation written once as a
  single SQL statement.
- ✅ Works with any driver, and alongside any ORM: Drizzle, Prisma and
  Kysely all expose raw queries on the same connection.
- ❌ Usher's tables aren't declared in the ORM's schema files. The ORM's
  migration tool doesn't know about them unless the SQL is pasted in.

## Decision

**Option 3**, plus a **conformance suite** that defines the storage contract
for every implementation.

```ts
import { sqlStorage, postgresExecutor, auditLog, rateLimit, createUsher } from "usherjs";

const storage = sqlStorage(postgresExecutor(pool)); // pg, PGlite, Neon...
await storage.migrate();                            // idempotent; safe on every boot

createUsher({
  store: storage.store,
  plugins: [
    auditLog({ sink: storage.auditSink }),
    rateLimit({ limit: 60, windowSeconds: 60, store: storage.rateLimitStore }),
  ],
  ...
});

setInterval(() => storage.prune({ auditRetentionDays: 90 }), 60 * 60 * 1000);
```

| Area | Choice |
|---|---|
| Dialects | **Postgres** and **SQLite**. SQL is written with `?` and rewritten to `$n` for Postgres |
| Drivers | `postgresExecutor(client)` for anything with `query(text, params) → { rows }` (pg, PGlite, Neon, Vercel Postgres). `sqliteExecutor(db)` for anything with `prepare(sql).all(...)` (node:sqlite, better-sqlite3, bun:sqlite). Anything else is two lines |
| Single-use secrets | `UPDATE … SET used = 1 WHERE hash = ? AND used = 0 RETURNING *`. The database picks exactly one winner. A loser re-reads the row and sees a replay |
| Approvals | Decided with `UPDATE … WHERE status = 'pending' RETURNING id`, consumed with `DELETE … RETURNING id` |
| Rate limits | One atomic `INSERT … ON CONFLICT DO UPDATE … RETURNING` per hit. The window rolls inside the statement |
| Value encoding | Times as `BIGINT`. Arrays (scopes, redirect URIs) and audit events as JSON text. No dialect-specific types |
| Migrations | Versioned lists of idempotent statements (`IF NOT EXISTS`), recorded in `{prefix}migrations`. No transaction needed, so it's safe over pooled connections and from several instances at once. A shipped migration is never edited |
| Own migration tool | `npx usherjs sql postgres --prefix usher_` prints the schema for Drizzle Kit, Prisma Migrate, Flyway or Rails |
| Table names | Prefix `usher_` by default, validated against `/^[A-Za-z_][A-Za-z0-9_]*$/`, so it's never an injection point |
| Cleanup | `prune()` removes expired codes and tokens (after a 1-day grace period, so replays of just-expired secrets are still caught), expired approvals and finished rate-limit windows. Audit retention is opt-in |
| Contract | `usherjs/testing` exports `authStoreConformance()`, `rateLimitStoreConformance()` and `auditSinkConformance()`. These are framework-free cases that throw readable errors. The memory, SQLite and Postgres implementations all run them in CI |
| API change | `QueryableAuditSink.list()` is now async for every sink, memory included |

## Why

1. **Atomicity belongs in one statement, written once.** Replay detection
   and single-use approvals are the security properties Phases 3–4 rely
   on. Expressing each as one conditional `UPDATE`/`DELETE … RETURNING`
   makes the database the arbiter. One adapter means one place to get it
   right, instead of one per ORM.
2. **The executor is the smallest common denominator.** Every driver and
   every ORM can run a parameterized query. Two members make an adapter
   trivial to write for anything we didn't anticipate, including D1 and
   PlanetScale.
3. **A conformance suite is the real interface.** A TypeScript interface
   says what methods exist. The suite says what they *mean*: "the second
   consume is a replay", "exactly one of eight concurrent consumers wins",
   "a used refresh token stays readable for revocation". It already pinned
   down the memory store's behavior, and third-party adapters (Mongo,
   DynamoDB, Redis) get the same bar for free.
4. **Idempotent migrations fit serverless.** There's no migration lock or
   transaction to manage, `migrate()` at cold start is safe, and teams with
   strict DDL policies use the printed SQL instead.
5. **Tested against the real engines without servers.** SQLite comes from
   Node's built-in `node:sqlite`, and Postgres from PGlite (real Postgres
   compiled to WebAssembly). The dialect SQL is exercised on actual
   databases, not mocks.

## Trade-offs

| We give up | Impact | Mitigation |
|---|---|---|
| ORM-native schema | Usher's tables don't appear in Prisma or Drizzle schema files | `npx usherjs sql` output pastes into their migration. Typed ORM table definitions can be generated later from the same source |
| MySQL / MariaDB | Not supported yet. `RETURNING` and `ON CONFLICT` differ there | The executor and conformance suite make it an additive dialect. Waiting for demand |
| True multi-connection concurrency in CI | PGlite and node:sqlite each serialize on one connection, so "exactly one winner" is shown by the SQL's semantics but not stress-tested across real connections | Single-statement conditional updates are atomic under Postgres's default READ COMMITTED isolation (it re-checks the row after a concurrent update). A concurrency test against a real Postgres server comes with CI (Phase 9) |
| Redis rate limiting | High-traffic apps may want counters out of the primary database | `RateLimitStore` is one method. A Redis adapter is straightforward and must pass the same conformance cases |
| JSON-as-text columns | Can't index into scopes or event payloads in SQL | Queried columns (`user_id`, `grant_id`, `type`, `at`) are real columns with indexes |
| Automatic cleanup | Expired rows accumulate until `prune()` runs | One call on a schedule. Phase 7 framework adapters can wire a cron route |
| Audit writes on the request path | Each audit event is an `INSERT` before the agent gets its answer (ADR 0006) | Indexed append-only table. A batching sink can wrap it if needed |

## What was built in this phase

```text
src/storage/sql.ts          SqlExecutor, postgresExecutor, sqliteExecutor, sqlStorage
                            (store, auditSink, rateLimitStore, migrate, prune), schemaSql
src/testing/conformance.ts  Public conformance cases (usherjs/testing)
src/cli.ts                  npx usherjs sql <postgres|sqlite> [--prefix …]
```

- `package.json` gains the `usherjs/testing` subpath and a `usherjs` bin.
- `memoryAuditSink().list()` is now async, the same as every sink.
- Tests (138 total, 43 new):
  - **Conformance:** 11 cases × 3 backends (memory, SQLite, Postgres via
    PGlite). Plus a check that conformance failures say what broke.
  - **Migrations:** idempotence on both dialects, custom prefixes,
    rejection of injection attempts, and the printed SQL and CLI.
  - **Two instances on one database (SQLite and Postgres).** The token
    issued on A works on B; B serves the approval page for a confirmation
    A created; single use holds across instances; one shared rate limit;
    one audit trail written by both; disconnecting on B kicks the agent
    off A immediately.
  - **Prune:** deletes exactly the dead rows, keeps the replay grace
    window, and audit retention is opt-in.
  - **Mutation-checked.** These changes were made one at a time, and tests
    failed each time: dropping the `used = 0` condition, deciding
    approvals twice, an off-by-one in the rate-limit window, revoked grants
    counted as active, and approvals not consumed.

## Revisit when

- Design partners run MySQL → add the dialect behind the same suite.
- An ORM ecosystem asks for native schema files → generate Drizzle/Prisma
  table definitions from the migration source.
- Rate-limit load shows up in the primary database → ship a Redis
  `RateLimitStore` (and prove it with `rateLimitStoreConformance()`).
- Phase 9 CI → add a concurrency stress run against a real Postgres server.
