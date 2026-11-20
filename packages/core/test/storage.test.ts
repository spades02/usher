import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { main as cli } from "../src/cli.js";
import {
  auditLog,
  createUsher,
  defineTool,
  memoryAuditSink,
  memoryRateLimitStore,
  memoryStore,
  postgresExecutor,
  rateLimit,
  type SqlExecutor,
  schemaSql,
  sqliteExecutor,
  sqlStorage,
} from "../src/index.js";
import { auditSinkConformance, authStoreConformance, rateLimitStoreConformance } from "../src/testing/conformance.js";
import { authOptions, authorizeAgent, callTool, decideInBrowser, errorPayload, readRpc } from "./helpers.js";

// node:sqlite ships with Node 22.13+/24 but has no bundled types here.
const { DatabaseSync } = (await import("node:sqlite" as string)) as {
  DatabaseSync: new (path: string) => { prepare(sql: string): { all(...p: unknown[]): unknown[] } };
};

let pglite: PGlite;
beforeAll(async () => {
  pglite = new PGlite();
  await pglite.waitReady;
}, 60_000);

let n = 0;
/** A fresh, migrated storage per call: separate table prefixes share one database. */
const backends: Record<string, () => Promise<ReturnType<typeof sqlStorage>>> = {
  sqlite: async () => {
    const storage = sqlStorage(sqliteExecutor(new DatabaseSync(":memory:")));
    await storage.migrate();
    return storage;
  },
  postgres: async () => {
    const storage = sqlStorage(postgresExecutor(pglite), { tablePrefix: `t${n++}_` });
    await storage.migrate();
    return storage;
  },
};

// ------------------------------------------------------------- conformance

describe.each([
  ["memory", async () => ({ store: memoryStore(), rateLimitStore: memoryRateLimitStore(), auditSink: memoryAuditSink() })],
  ...Object.entries(backends),
] as const)("%s storage conforms to the contract", (_name, make) => {
  for (const c of authStoreConformance()) it(`AuthStore: ${c.name}`, async () => c.run((await make()).store));
  for (const c of rateLimitStoreConformance()) it(`RateLimitStore: ${c.name}`, async () => c.run((await make()).rateLimitStore));
  for (const c of auditSinkConformance()) it(`AuditSink: ${c.name}`, async () => c.run((await make()).auditSink));
});

it("conformance failures explain what broke", async () => {
  const broken = { ...memoryStore(), consumeCode: async () => null };
  const c = authStoreConformance().find((x) => x.name.startsWith("consumes an authorization code"))!;
  await expect(c.run(broken)).rejects.toThrow(/first consume wins[\s\S]*expected:/);
});

// -------------------------------------------------------------- migrations

describe("migrations", () => {
  it.each(Object.keys(backends))("%s: are idempotent and recorded", async (name) => {
    const storage = await backends[name]!();
    expect(await storage.migrate()).toEqual({ applied: [] });
  });

  it("apply under a custom prefix, and reject unsafe ones", async () => {
    const db = sqliteExecutor(new DatabaseSync(":memory:"));
    expect(await sqlStorage(db, { tablePrefix: "acme_agents_" }).migrate()).toEqual({ applied: [1] });
    const tables = await db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'acme_agents_%'", []);
    expect(tables.map((t) => t.name)).toContain("acme_agents_grants");
    expect(() => sqlStorage(db, { tablePrefix: "x; DROP TABLE users; --" })).toThrow(/tablePrefix/);
  });

  it("print as SQL for external migration tools (npx @usherjs/core sql)", () => {
    const pg = schemaSql("postgres", { tablePrefix: "app_" });
    expect(pg).toContain("CREATE TABLE IF NOT EXISTS app_grants");
    expect(pg).toContain("BIGSERIAL PRIMARY KEY");
    expect(schemaSql("sqlite")).toContain("INTEGER PRIMARY KEY AUTOINCREMENT");

    expect(cli(["sql", "postgres", "--prefix", "app_"])).toEqual({ code: 0, out: pg });
    expect(cli(["sql", "mysql"]).code).toBe(1);
    expect(cli(["sql", "sqlite", "--prefix", "bad prefix"])).toMatchObject({ code: 1, out: expect.stringMatching(/tablePrefix/) });
  });
});

// ------------------------------------------------- end to end, two instances

function makeApp(storage: ReturnType<typeof sqlStorage>, ran: { cancel: number }) {
  return createUsher({
    ...authOptions,
    app: { name: "Example Shop", version: "1.0.0" },
    store: storage.store,
    plugins: [auditLog({ sink: storage.auditSink }), rateLimit({ limit: 5, windowSeconds: 60, store: storage.rateLimitStore })],
    tools: [
      defineTool({ name: "list_orders", description: "List.", input: z.object({}), effect: "read", handler: () => ({ orders: ["o_1"] }) }),
      defineTool({
        name: "cancel_order",
        description: "Cancel.",
        input: z.object({ orderId: z.string() }),
        effect: "destructive",
        handler: ({ orderId }) => {
          ran.cancel++;
          return { cancelled: orderId };
        },
      }),
    ],
  });
}

describe.each(Object.keys(backends))("%s: state survives restarts and is shared across instances", (name) => {
  it("connections, approvals, audit events and rate limits", async () => {
    const storage = await backends[name]!();
    const ran = { cancel: 0 };

    // Instance A: the customer connects and the agent asks to cancel.
    const a = makeApp(storage, ran);
    const { accessToken } = await authorizeAgent(a);
    const pending = errorPayload(await readRpc(await callTool(a, accessToken, "cancel_order", { orderId: "o_1" })));

    // Instance B (a restart, or another server behind the load balancer).
    const b = makeApp(storage, ran);
    expect((await readRpc(await callTool(b, accessToken, "list_orders", {}))).result.structuredContent).toEqual({ orders: ["o_1"] });
    // The approval page is served by B for a confirmation A created.
    await decideInBrowser(b, pending.confirm_url);
    const done = await readRpc(await callTool(a, accessToken, "cancel_order", { orderId: "o_1" }));
    expect(done.result.structuredContent).toEqual({ cancelled: "o_1" });
    // Single use holds across instances.
    expect(errorPayload(await readRpc(await callTool(b, accessToken, "cancel_order", { orderId: "o_1" }))).code).toBe(
      "confirmation_required",
    );
    expect(ran.cancel).toBe(1);

    // Both instances count against one rate limit of 5: four calls so far, then one more is
    // allowed on A and the next one is over, wherever it lands.
    expect((await readRpc(await callTool(a, accessToken, "list_orders", {}))).result.isError).toBeFalsy();
    expect(errorPayload(await readRpc(await callTool(b, accessToken, "list_orders", {}))).code).toBe("rate_limited");

    // One durable audit trail, written by both.
    const events = await storage.auditSink.list({ userId: "user_1", limit: 50 });
    expect(events.filter((e) => e.type === "call")).toHaveLength(6);
    expect(events.some((e) => e.type === "confirmation.decided")).toBe(true);

    // Disconnecting on one instance takes effect on the other immediately.
    const [grant] = await b.grants.list("user_1");
    await b.grants.revoke("user_1", grant!.id);
    expect((await callTool(a, accessToken, "list_orders", {})).status).toBe(401);
  });
});

// ------------------------------------------------------------------ pruning

describe.each(Object.keys(backends))("%s: prune", (name) => {
  it("deletes only what can never be used again", async () => {
    const storage = await backends[name]!();
    const { store } = storage;
    const now = 1_800_000_000_000; // ms
    const s = now / 1000;
    const base = { grantId: "g", clientId: "c", userId: "u", resource: "r" };
    await store.saveToken({ ...base, hash: "old", kind: "refresh", expiresAt: s - 2 * 86400 });
    await store.saveToken({ ...base, hash: "recent", kind: "refresh", expiresAt: s - 3600 }); // within the replay grace day
    await store.saveToken({ ...base, hash: "live", kind: "access", expiresAt: s + 3600 });
    await store.saveCode({ ...base, hash: "c_old", redirectUri: "r", codeChallenge: "x", expiresAt: s - 2 * 86400 });
    const conf = {
      grantId: "g",
      userId: "u",
      clientName: "A",
      tool: "t",
      inputHash: "h",
      summary: "s",
      details: "d",
      status: "pending" as const,
      createdAt: s - 2000,
    };
    await store.saveConfirmation({ ...conf, id: "cf_old", expiresAt: s - 1 });
    await store.saveConfirmation({ ...conf, id: "cf_live", expiresAt: s + 600 });
    await storage.rateLimitStore.hit("rl_old", 60, now - 120_000);
    await storage.rateLimitStore.hit("rl_live", 60, now);
    const agent = { clientId: "c", name: "A", verified: true };
    await storage.auditSink.write({ type: "grant.created", at: now - 40 * 86_400_000, userId: "u", agent, grantId: "g", scopes: [] });
    await storage.auditSink.write({ type: "grant.created", at: now, userId: "u", agent, grantId: "g", scopes: [] });

    expect(await storage.prune({ now })).toEqual({ codes: 1, tokens: 1, confirmations: 1, rateLimits: 1, auditEvents: 0 });
    expect(await store.getToken("recent")).not.toBeNull();
    expect(await store.getToken("live")).not.toBeNull();
    expect(await store.getConfirmation("cf_live")).not.toBeNull();
    expect((await storage.rateLimitStore.hit("rl_live", 60, now)).count).toBe(2);

    expect((await storage.prune({ now, auditRetentionDays: 30 })).auditEvents).toBe(1);
    expect(await storage.auditSink.list()).toHaveLength(1);
  });
});

it("SqlExecutor is a two-member interface any driver can implement", () => {
  const custom: SqlExecutor = { dialect: "postgres", query: async () => [] };
  expect(() => sqlStorage(custom)).not.toThrow();
});
