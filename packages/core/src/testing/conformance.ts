import { canonicalJson } from "../auth/crypto.js";
import type { AuthStore, ConfirmationRecord, GrantRecord, TokenRecord } from "../auth/store.js";
import type { QueryableAuditSink } from "../plugins/audit-log.js";
import type { RateLimitStore } from "../plugins/rate-limit.js";
import type { UsherEvent } from "../plugins/types.js";

/**
 * The storage contract as executable checks (ADR 0007). Every store Usher
 * ships passes these, and so must yours: run them from any test runner.
 *
 * ```ts
 * for (const c of authStoreConformance()) it(c.name, async () => c.run(await makeFreshStore()));
 * ```
 *
 * Each case gets its own fresh store and throws on failure. No dependency
 * on a test framework.
 */
export interface ConformanceCase<T> {
  name: string;
  run(subject: T): Promise<void>;
}

class ConformanceError extends Error {}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ConformanceError(message);
}

function same(actual: unknown, expected: unknown, message: string) {
  // Key order is not part of the contract.
  const a = canonicalJson(actual);
  const e = canonicalJson(expected);
  if (a !== e) throw new ConformanceError(`${message}\n  expected: ${e}\n  actual:   ${a}`);
}

let counter = 0;
const id = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(counter++).toString(36)}`;

const grant = (over: Partial<GrantRecord> = {}): GrantRecord => ({
  id: id("grant"),
  userId: "user_1",
  clientId: "https://agent.example/client.json",
  clientName: "Agent",
  clientSource: "cimd",
  scopes: ["tool:a", "tool:b"],
  createdAt: 1_700_000_000,
  ...over,
});

const token = (over: Partial<TokenRecord> = {}): TokenRecord => ({
  hash: id("hash"),
  kind: "refresh",
  grantId: "g",
  clientId: "c",
  userId: "u",
  resource: "https://app.example/mcp",
  expiresAt: 1_800_000_000,
  ...over,
});

const confirmation = (over: Partial<ConfirmationRecord> = {}): ConfirmationRecord => ({
  id: id("cf"),
  grantId: "g",
  userId: "u",
  clientName: "Agent",
  tool: "cancel",
  inputHash: "h1",
  summary: "Cancel order",
  details: '{\n  "id": "o_1"\n}',
  status: "pending",
  createdAt: 1_700_000_000,
  expiresAt: 1_700_000_900,
  ...over,
});

export function authStoreConformance(): ConformanceCase<AuthStore>[] {
  return [
    {
      name: "round-trips clients, including optional fields and upserts",
      async run(s) {
        const client = {
          clientId: "dcr_1",
          clientName: "Agent",
          redirectUris: ["https://a.example/cb", "http://127.0.0.1/cb"],
          clientUri: "https://a.example",
          source: "dcr" as const,
          createdAt: 1_700_000_000,
        };
        await s.saveClient(client);
        same(await s.getClient("dcr_1"), client, "getClient returns what was saved");
        await s.saveClient({ ...client, clientName: "Renamed" });
        same((await s.getClient("dcr_1"))?.clientName, "Renamed", "saveClient overwrites");
        same(await s.getClient("missing"), null, "unknown client is null");
      },
    },
    {
      name: "round-trips grants and finds only the active one",
      async run(s) {
        const old = grant({ userId: "u_g", createdAt: 1 });
        await s.saveGrant(old);
        same(await s.getGrant(old.id), old, "getGrant returns what was saved");
        await s.revokeGrant(old.id, 50);
        same((await s.getGrant(old.id))?.revokedAt, 50, "revokeGrant stamps revokedAt");
        await s.revokeGrant(old.id, 99);
        same((await s.getGrant(old.id))?.revokedAt, 50, "revoking twice keeps the first time");

        same(await s.findActiveGrant("u_g", old.clientId), null, "a revoked grant isn't active");
        const fresh = grant({ userId: "u_g", createdAt: 2 });
        await s.saveGrant(fresh);
        same((await s.findActiveGrant("u_g", old.clientId))?.id, fresh.id, "finds the active grant");
        same(await s.findActiveGrant("u_g", "other-client"), null, "scoped to the client");
        same(await s.findActiveGrant("someone-else", old.clientId), null, "scoped to the user");
        same((await s.listGrants("u_g")).map((g) => g.id).sort(), [old.id, fresh.id].sort(), "listGrants includes revoked ones");
        same(await s.getGrant("missing"), null, "unknown grant is null");
      },
    },
    {
      name: "replaces grant scopes",
      async run(s) {
        const g = grant();
        await s.saveGrant(g);
        await s.updateGrantScopes(g.id, ["tool:z"]);
        same((await s.getGrant(g.id))?.scopes, ["tool:z"], "scopes replaced");
      },
    },
    {
      name: "consumes an authorization code once, then reports replays",
      async run(s) {
        const code = {
          hash: id("code"),
          grantId: "g",
          clientId: "c",
          userId: "u",
          redirectUri: "https://a.example/cb",
          codeChallenge: "x".repeat(43),
          resource: "https://app.example/mcp",
          expiresAt: 1_700_000_060,
        };
        await s.saveCode(code);
        same(await s.consumeCode(code.hash), { record: code, firstUse: true }, "first consume wins");
        same(await s.consumeCode(code.hash), { record: code, firstUse: false }, "second consume is a replay");
        same(await s.consumeCode("missing"), null, "unknown code is null");
      },
    },
    {
      name: "gives exactly one concurrent consumer the first use",
      async run(s) {
        const code = { hash: id("code"), grantId: "g", clientId: "c", userId: "u", redirectUri: "r", codeChallenge: "c", resource: "r", expiresAt: 1 };
        await s.saveCode(code);
        const results = await Promise.all(Array.from({ length: 8 }, () => s.consumeCode(code.hash)));
        same(results.filter((r) => r?.firstUse).length, 1, "exactly one firstUse among concurrent consumers");
      },
    },
    {
      name: "rotates refresh tokens once, never consumes access tokens, and keeps used ones readable",
      async run(s) {
        const refresh = token({ kind: "refresh" });
        const access = token({ kind: "access" });
        await s.saveToken(refresh);
        await s.saveToken(access);
        same(await s.getToken(access.hash), access, "getToken returns what was saved");
        same(await s.consumeRefreshToken(access.hash), null, "access tokens can't be consumed as refresh tokens");
        same(await s.consumeRefreshToken(refresh.hash), { record: refresh, firstUse: true }, "first rotation wins");
        same(await s.consumeRefreshToken(refresh.hash), { record: refresh, firstUse: false }, "reuse is detected");
        same(await s.getToken(refresh.hash), refresh, "a used refresh token is still readable (for revocation)");
        const many = token({ kind: "refresh" });
        await s.saveToken(many);
        const results = await Promise.all(Array.from({ length: 8 }, () => s.consumeRefreshToken(many.hash)));
        same(results.filter((r) => r?.firstUse).length, 1, "exactly one concurrent rotation wins");
      },
    },
    {
      name: "finds the newest unexpired confirmation for an exact call",
      async run(s) {
        const grantId = id("g");
        const older = confirmation({ grantId, createdAt: 100, expiresAt: 1000 });
        const newer = confirmation({ grantId, createdAt: 200, expiresAt: 1000, summary: "newer" });
        await s.saveConfirmation(older);
        await s.saveConfirmation(newer);
        same(await s.getConfirmation(older.id), older, "getConfirmation returns what was saved");
        same((await s.findConfirmation(grantId, "cancel", "h1", 500))?.id, newer.id, "newest wins");
        same(await s.findConfirmation(grantId, "cancel", "h1", 1001), null, "expired ones are ignored");
        same(await s.findConfirmation(grantId, "cancel", "other-hash", 500), null, "bound to the input hash");
        same(await s.findConfirmation(grantId, "other-tool", "h1", 500), null, "bound to the tool");
        same(await s.findConfirmation("other-grant", "cancel", "h1", 500), null, "bound to the grant");
      },
    },
    {
      name: "decides a confirmation once and consumes it atomically",
      async run(s) {
        const c = confirmation();
        await s.saveConfirmation(c);
        check(await s.decideConfirmation(c.id, "approved", 123), "deciding a pending confirmation succeeds");
        check(!(await s.decideConfirmation(c.id, "denied", 124)), "a decided confirmation can't be decided again");
        const after = await s.getConfirmation(c.id);
        same([after?.status, after?.decidedAt], ["approved", 123], "status and time are recorded");

        const results = await Promise.all(Array.from({ length: 8 }, () => s.consumeConfirmation(c.id)));
        same(results.filter(Boolean).length, 1, "exactly one concurrent consumer wins");
        same(await s.getConfirmation(c.id), null, "a consumed confirmation is gone");
        check(!(await s.decideConfirmation("missing", "approved", 1)), "unknown confirmations can't be decided");
      },
    },
  ];
}

export function rateLimitStoreConformance(): ConformanceCase<RateLimitStore>[] {
  return [
    {
      name: "counts hits in a fixed window and starts a new one when it ends",
      async run(s) {
        const key = id("rl");
        same(await s.hit(key, 60, 1_000), { count: 1, resetAt: 61_000 }, "first hit opens a window");
        same(await s.hit(key, 60, 2_000), { count: 2, resetAt: 61_000 }, "later hits count in the same window");
        same(await s.hit(key, 60, 61_000), { count: 1, resetAt: 121_000 }, "a hit at reset time opens a new window");
        same((await s.hit(id("rl"), 60, 2_000)).count, 1, "keys are independent");
      },
    },
    {
      name: "loses no concurrent hits",
      async run(s) {
        const key = id("rl");
        await Promise.all(Array.from({ length: 10 }, () => s.hit(key, 60, 1_000)));
        same((await s.hit(key, 60, 1_000)).count, 11, "all concurrent hits counted");
      },
    },
  ];
}

export function auditSinkConformance(): ConformanceCase<QueryableAuditSink>[] {
  const agent = { clientId: "c", name: "Agent", verified: true };
  const event = (over: Partial<UsherEvent> & { userId: string; grantId: string }): UsherEvent =>
    ({ type: "grant.created", at: 1, agent, scopes: ["tool:a"], ...over }) as UsherEvent;
  return [
    {
      name: "returns events newest first, filtered and limited, exactly as written",
      async run(s) {
        const user = id("user");
        const created = event({ userId: user, grantId: "g1" });
        const call: UsherEvent = {
          type: "call",
          at: 2,
          userId: user,
          agent,
          grantId: "g2",
          tool: "list",
          effect: "read",
          outcome: "success",
          durationMs: 3,
          inputHash: "h",
        };
        await s.write(created);
        await s.write(call);
        await s.write(event({ userId: id("other"), grantId: "g3" }));
        same(await s.list({ userId: user }), [call, created], "newest first, per user, unchanged");
        same(await s.list({ userId: user, type: "call" }), [call], "filter by type");
        same(await s.list({ userId: user, grantId: "g1" }), [created], "filter by grant");
        same((await s.list({ userId: user, limit: 1 })).length, 1, "limit");
      },
    },
  ];
}
