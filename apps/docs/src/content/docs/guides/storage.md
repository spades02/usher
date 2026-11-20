---
title: Storage
description: Keep grants, tokens, approvals, audit events and rate limits in your own database.
---

By default Usher keeps everything in memory, which is fine for development.
In production, connected agents must survive restarts, and every instance
must agree. Use your database:

```ts
import { postgresExecutor, sqlStorage, sqliteExecutor } from "@usherjs/core";

const storage = sqlStorage(postgresExecutor(pool)); // pg, Neon, Vercel Postgres, PGlite
// or: sqlStorage(sqliteExecutor(db))               // node:sqlite, better-sqlite3, bun:sqlite
await storage.migrate();
```

Pass `storage.store` as `store`, `storage.auditSink` to `auditLog`, and
`storage.rateLimitStore` to `rateLimit`. The [Getting started](/getting-started/)
sample wires all three.

## Migrations

- **`migrate()` at boot** is safe on every start and from many instances at
  once. Every statement is idempotent, and a run that loses a concurrent
  `CREATE` race retries.
- **Your own migration tool**: print the SQL and paste it into a migration:

  ```sh
  npx @usherjs/core sql postgres --prefix usher_
  ```

Tables are prefixed `usher_` by default (`tablePrefix` option), so they live
next to yours without collisions.

## Cleanup

Expired codes, tokens and approvals accumulate until `prune()` runs. Run it
hourly:

```ts
setInterval(() => void storage.prune({ auditRetentionDays: 90 }), 60 * 60 * 1000).unref();
```

Codes and tokens are kept for a day after expiry, so a replay of a
just-expired secret is still recognized as one. Audit retention is opt-in.

## Other databases

Anything with a parameterized query is two lines:

```ts
const executor: SqlExecutor = {
  dialect: "postgres",
  query: async (sql, params) => (await client.query(sql, params)).rows,
};
```

For a non-SQL store (Mongo, DynamoDB, Redis), implement `AuthStore`,
`AuditSink` or `RateLimitStore`, and prove it with the same conformance
suite Usher's own stores pass:

```ts
import { authStoreConformance } from "@usherjs/core/testing";

for (const c of authStoreConformance()) test(c.name, () => c.run(myStore()));
```
