/**
 * The concurrency stress run promised in ADR 0007: a real Postgres server
 * (embedded-postgres downloads the official binaries), and a pool of real
 * connections racing on each atomic operation. PGlite and node:sqlite run
 * on one connection, so they can't prove "exactly one winner".
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postgresExecutor, sqlStorage } from "../src/index.js";

const RACERS = 24;
let server: EmbeddedPostgres;
let pool: pg.Pool;
let dir: string;
let n = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "usher-pg-"));
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  server = new EmbeddedPostgres({ databaseDir: dir, port, user: "usher", password: "usher", persistent: false, onLog: () => {} });
  await server.initialise();
  await server.start();
  pool = new pg.Pool({ host: "127.0.0.1", port, user: "usher", password: "usher", database: "postgres", max: RACERS });
  // Stopping the server in afterAll terminates connections (57P01). That is
  // expected teardown, not a test failure, so don't let it surface as unhandled.
  pool.on("error", () => {});
  pool.on("connect", (client) => client.on("error", () => {}));
  // Open every connection up front, so the races below really run in parallel.
  const clients = await Promise.all(Array.from({ length: RACERS }, () => pool.connect()));
  for (const c of clients) c.release();
}, 180_000);

afterAll(async () => {
  await pool?.end();
  // On Windows runners, stop() can wait on the postmaster's exit long after
  // the tests are done. Give it 30 s, then move on: the runner reaps it.
  await Promise.race([server?.stop().catch(() => {}), new Promise((r) => setTimeout(r, 30_000).unref())]);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}, 60_000);

async function storage() {
  const s = sqlStorage(postgresExecutor(pool), { tablePrefix: `c${n++}_` });
  await s.migrate();
  return s;
}
const race = <T>(fn: () => Promise<T>) => Promise.all(Array.from({ length: RACERS }, fn));

describe(`real Postgres, ${RACERS} parallel connections`, () => {
  it("concurrent migrate() from many instances on a fresh database", async () => {
    const prefix = `m${n++}_`;
    const results = await race(() => sqlStorage(postgresExecutor(pool), { tablePrefix: prefix }).migrate());
    expect(results.flatMap((r) => r.applied).length).toBeGreaterThanOrEqual(1);
    expect(await sqlStorage(postgresExecutor(pool), { tablePrefix: prefix }).migrate()).toEqual({ applied: [] });
  });

  it("an authorization code is consumed exactly once", async () => {
    const { store } = await storage();
    for (let round = 0; round < 5; round++) {
      const hash = `code_${round}`;
      await store.saveCode({
        hash,
        grantId: "g",
        clientId: "c",
        userId: "u",
        redirectUri: "r",
        codeChallenge: "x",
        resource: "r",
        expiresAt: 9e9,
      });
      const results = await race(() => store.consumeCode(hash));
      expect(results.filter((r) => r?.firstUse)).toHaveLength(1);
      expect(results.filter((r) => r && !r.firstUse)).toHaveLength(RACERS - 1); // Every loser sees a replay.
    }
  });

  it("a refresh token rotates exactly once", async () => {
    const { store } = await storage();
    for (let round = 0; round < 5; round++) {
      const hash = `rt_${round}`;
      await store.saveToken({ hash, kind: "refresh", grantId: "g", clientId: "c", userId: "u", resource: "r", expiresAt: 9e9 });
      const results = await race(() => store.consumeRefreshToken(hash));
      expect(results.filter((r) => r?.firstUse)).toHaveLength(1);
      expect(results.filter((r) => r && !r.firstUse)).toHaveLength(RACERS - 1);
    }
  });

  it("an approval is decided once and consumed once", async () => {
    const { store } = await storage();
    for (let round = 0; round < 5; round++) {
      const id = `cf_${round}`;
      await store.saveConfirmation({
        id,
        grantId: "g",
        userId: "u",
        clientName: "A",
        tool: "t",
        inputHash: "h",
        summary: "s",
        details: "d",
        status: "pending",
        createdAt: 1,
        expiresAt: 9e9,
      });
      // Half the racers approve, half deny: exactly one decision sticks, and it's the one that won.
      const decisions = await Promise.all(
        Array.from({ length: RACERS }, (_, i) => {
          const status = i % 2 ? "approved" : "denied";
          return store.decideConfirmation(id, status, 100 + i).then((won) => ({ won, status }));
        }),
      );
      const winners = decisions.filter((d) => d.won);
      expect(winners).toHaveLength(1);
      expect((await store.getConfirmation(id))?.status).toBe(winners[0]!.status);

      expect((await race(() => store.consumeConfirmation(id))).filter(Boolean)).toHaveLength(1);
    }
  });

  it("rate-limit counters never lose or double-count a hit", async () => {
    const { rateLimitStore } = await storage();
    const now = 1_800_000_000_000;
    const counts = (await race(() => rateLimitStore.hit("grant_1", 60, now))).map((r) => r.count).sort((a, b) => a - b);
    expect(counts).toEqual(Array.from({ length: RACERS }, (_, i) => i + 1));
  });

  it("revoking a grant while tokens are being checked never resurrects it", async () => {
    const { store } = await storage();
    await store.saveGrant({
      id: "g1",
      userId: "u",
      clientId: "c",
      clientName: "A",
      clientSource: "cimd",
      scopes: ["tool:x"],
      createdAt: 1,
    });
    await Promise.all([
      ...Array.from({ length: RACERS / 2 }, () => store.updateGrantScopes("g1", ["tool:x", "tool:y"])),
      store.revokeGrant("g1", 50),
    ]);
    expect((await store.getGrant("g1"))?.revokedAt).toBe(50);
  });
});
