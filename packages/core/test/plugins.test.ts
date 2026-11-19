import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { sha256 } from "../src/auth/crypto.js";
import {
  ToolError,
  auditLog,
  createUsher,
  definePlugin,
  defineTool,
  killSwitch,
  memoryAuditSink,
  rateLimit,
  toolScope,
  type CallInfo,
  type UsherOptions,
  type UsherPlugin,
} from "../src/index.js";
import {
  BASE,
  authOptions,
  authorizeAgent,
  callTool,
  decideInBrowser,
  errorPayload,
  readRpc,
} from "./helpers.js";

const SECRET_NOTE = "my-private-delivery-note-1234";

function makeShop(plugins: UsherPlugin[], extra: Partial<UsherOptions> = {}) {
  const ran = { list: 0, cancel: 0 };
  const usher = createUsher({
    ...authOptions,
    app: { name: "Example Shop", version: "1.0.0" },
    plugins,
    tools: [
      defineTool({
        name: "list_orders",
        description: "List orders.",
        input: z.object({ note: z.string().optional() }),
        effect: "read",
        handler: () => {
          ran.list++;
          return { orders: ["o_1"] };
        },
      }),
      defineTool({
        name: "track",
        description: "Track a parcel.",
        input: z.object({ id: z.string() }),
        effect: "read",
        handler: ({ id }) => {
          if (id === "missing") throw new ToolError("No such parcel", { code: "not_found" });
          if (id === "boom") throw new Error("db down");
          return { id, status: "in transit" };
        },
      }),
      defineTool({
        name: "cancel_order",
        description: "Cancel an order.",
        input: z.object({ orderId: z.string() }),
        effect: "destructive",
        handler: ({ orderId }) => {
          ran.cancel++;
          return { cancelled: orderId };
        },
      }),
    ],
    onError: () => {},
    ...extra,
  });
  return { usher, ran };
}

const call = async (usher: ReturnType<typeof makeShop>["usher"], token: string, name: string, args: Record<string, unknown> = {}) =>
  readRpc(await callTool(usher, token, name, args));

afterEach(() => vi.useRealTimers());

// --------------------------------------------------------------- audit log

describe("auditLog", () => {
  it("records the whole lifecycle of an agent, without customer data", async () => {
    const sink = memoryAuditSink();
    const { usher } = makeShop([auditLog({ sink })]);
    const { accessToken } = await authorizeAgent(usher, { scopes: [toolScope("list_orders"), toolScope("track"), toolScope("cancel_order")] });

    await call(usher, accessToken, "list_orders", { note: SECRET_NOTE });
    await call(usher, accessToken, "track", { id: "missing" });
    await call(usher, accessToken, "track", { id: "boom" });
    const pending = errorPayload(await call(usher, accessToken, "cancel_order", { orderId: "o_1" }));
    await decideInBrowser(usher, pending.confirm_url);
    await call(usher, accessToken, "cancel_order", { orderId: "o_1" });

    const [grant] = await usher.grants.list("user_1");
    await usher.grants.setScopes("user_1", grant!.id, [toolScope("track")]);
    expect((await callTool(usher, accessToken, "list_orders", {})).status).toBe(403);
    await usher.grants.revoke("user_1", grant!.id);

    const events = sink.list({ userId: "user_1" }).reverse();
    expect(events.map((e) => (e.type === "call" ? `call:${e.tool}:${e.outcome}${e.code ? `:${e.code}` : ""}` : e.type))).toEqual([
      "grant.created",
      "call:list_orders:success",
      "call:track:tool_error:not_found",
      "call:track:failed",
      "call:cancel_order:confirmation_required",
      "confirmation.decided",
      "call:cancel_order:success",
      "grant.updated",
      "call:list_orders:forbidden",
      "grant.revoked",
    ]);

    // Every event names the customer, the agent and the grant.
    for (const e of events) {
      expect(e.agent).toEqual({ clientId: "https://agent.example/oauth/client.json", name: "Test Agent", verified: true });
      expect(e.grantId).toBe(grant!.id);
    }
    const first = events[1]!;
    expect(first.type === "call" && first.inputHash).toBe(await sha256(JSON.stringify({ note: SECRET_NOTE })));
    expect(first.type === "call" && first.durationMs).toBeGreaterThanOrEqual(0);
    expect(events.at(-1)).toMatchObject({ type: "grant.revoked", reason: "customer" });
    expect(events[5]).toMatchObject({ type: "confirmation.decided", tool: "cancel_order", approved: true });
    // Arguments never reach the log.
    expect(JSON.stringify(events)).not.toContain(SECRET_NOTE);
  });

  it("records why a grant ended: the agent revoked it, or a stolen token was replayed", async () => {
    const sink = memoryAuditSink();
    const { usher } = makeShop([auditLog({ sink, events: ["grant.revoked"] })]);
    const fetchToken = (body: Record<string, string>) =>
      usher.handler(
        new Request(`${BASE}/api/usher/oauth/${body.token ? "revoke" : "token"}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(body),
        }),
      );

    const a = await authorizeAgent(usher, { userId: "user_1" });
    await fetchToken({ token: a.accessToken, client_id: "https://agent.example/oauth/client.json" });

    const b = await authorizeAgent(usher, { userId: "user_2" });
    const refresh = { grant_type: "refresh_token", refresh_token: b.refreshToken, client_id: "https://agent.example/oauth/client.json" };
    await fetchToken(refresh);
    await fetchToken(refresh); // replay

    expect(sink.list().map((e) => e.type === "grant.revoked" && [e.userId, e.reason])).toEqual([
      ["user_2", "token_replay"],
      ["user_1", "agent"],
    ]);
  });

  it("filters by event type and queries newest first", async () => {
    const sink = memoryAuditSink({ max: 3 });
    const { usher } = makeShop([auditLog({ sink, events: ["call"] })]);
    const { accessToken } = await authorizeAgent(usher);
    for (const id of ["a", "b", "c", "d"]) await call(usher, accessToken, "track", { id });
    const tracked = sink.list();
    expect(tracked).toHaveLength(3); // capped at max
    expect(tracked.every((e) => e.type === "call")).toBe(true);
    expect(sink.list({ limit: 1 })[0]).toHaveProperty("inputHash", await sha256(JSON.stringify({ id: "d" })));
  });
});

// ------------------------------------------------------------ the contract

describe("plugin contract", () => {
  it("passes the call's context to beforeCall, after the scope check and before confirmation", async () => {
    const seen: CallInfo[] = [];
    const spy = definePlugin({ id: "spy", beforeCall: (c) => void seen.push(c) });
    const { usher, ran } = makeShop([spy]);
    const { accessToken } = await authorizeAgent(usher, { scopes: [toolScope("list_orders")] });

    await call(usher, accessToken, "list_orders", { note: "x" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      tool: { name: "list_orders", effect: "read" },
      user: { id: "user_1" },
      agent: { name: "Test Agent", verified: true },
      input: { note: "x" },
    });
    expect(seen[0]!.request).toBeInstanceOf(Request);

    // An ungranted tool never reaches plugins: Usher's own check comes first.
    await callTool(usher, accessToken, "cancel_order", { orderId: "o_1" });
    expect(seen).toHaveLength(1);
    expect(ran.cancel).toBe(0);
  });

  it("stops at the first denial, before any confirmation link is created", async () => {
    const later = vi.fn();
    const { usher, ran } = makeShop([
      { id: "no", beforeCall: () => ({ code: "nope", message: "Not today.", retryAfterSeconds: 5 }) },
      { id: "later", beforeCall: later },
    ]);
    const { accessToken } = await authorizeAgent(usher);

    const denied = errorPayload(await call(usher, accessToken, "cancel_order", { orderId: "o_1" }));
    expect(denied).toEqual({ error: "Not today.", code: "nope", retry_after_seconds: 5 });
    expect(denied.confirm_url).toBeUndefined();
    expect(later).not.toHaveBeenCalled();
    expect(ran.cancel).toBe(0);
  });

  it("fails closed when beforeCall throws, and reports it", async () => {
    const onError = vi.fn();
    const { usher, ran } = makeShop(
      [{ id: "broken", beforeCall: () => { throw new Error("redis down"); } }],
      { onError },
    );
    const { accessToken } = await authorizeAgent(usher);
    const denied = errorPayload(await call(usher, accessToken, "list_orders"));
    expect(denied.code).toBe("unavailable");
    expect(JSON.stringify(denied)).not.toContain("redis");
    expect(ran.list).toBe(0);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { tool: "list_orders", plugin: "broken" });
  });

  it("isolates a crashing observer: the call still succeeds", async () => {
    const onError = vi.fn();
    const sink = memoryAuditSink();
    const { usher } = makeShop(
      [{ id: "flaky-log", onEvent: () => { throw new Error("log service down"); } }, auditLog({ sink })],
      { onError },
    );
    const { accessToken } = await authorizeAgent(usher);
    const ok = await call(usher, accessToken, "list_orders");
    expect(ok.result.structuredContent).toEqual({ orders: ["o_1"] });
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { plugin: "flaky-log" });
    // The next observer still received the event.
    expect(sink.list({ type: "call" })).toHaveLength(1);
  });

  it("rejects malformed plugins at startup", () => {
    const make = (plugins: unknown[]) => () => makeShop(plugins as UsherPlugin[]);
    expect(make([{ id: "", onEvent() {} }])).toThrow(/non-empty string `id`/);
    expect(make([{ id: "a", onEvent() {} }, { id: "a", onEvent() {} }])).toThrow(/duplicate id/);
    expect(make([{ id: "a" }])).toThrow(/implements no hooks/);
    expect(make([{ id: "a", beforeCall: "yes" }])).toThrow(/beforeCall must be a function/);
    expect(() => rateLimit({ limit: 0, windowSeconds: 60 })).toThrow(/limit must be a positive integer/);
    expect(() => rateLimit({ limit: 5, windowSeconds: 60, tools: { x: { limit: 1, windowSeconds: 1.5 } } })).toThrow(
      /tools.x: windowSeconds/,
    );
    expect(() => auditLog({} as never)).toThrow(/sink/);
    expect(() => killSwitch({} as never)).toThrow(/isBlocked/);
  });
});

// -------------------------------------------------------------- rate limit

describe("rateLimit", () => {
  it("caps calls per connected agent and says when to retry", async () => {
    const { usher, ran } = makeShop([rateLimit({ limit: 2, windowSeconds: 60 })]);
    const { accessToken } = await authorizeAgent(usher);
    await call(usher, accessToken, "list_orders");
    await call(usher, accessToken, "list_orders");
    const limited = errorPayload(await call(usher, accessToken, "list_orders"));
    expect(limited.code).toBe("rate_limited");
    expect(limited.retry_after_seconds).toBeGreaterThan(0);
    expect(limited.retry_after_seconds).toBeLessThanOrEqual(60);
    expect(ran.list).toBe(2);

    // Another customer's agent has its own budget.
    const other = await authorizeAgent(usher, { userId: "user_2" });
    expect((await call(usher, other.accessToken, "list_orders")).result.isError).toBeFalsy();
  });

  it("applies stricter per-tool limits on top", async () => {
    const { usher } = makeShop([rateLimit({ limit: 100, windowSeconds: 60, tools: { track: { limit: 1, windowSeconds: 60 } } })]);
    const { accessToken } = await authorizeAgent(usher);
    await call(usher, accessToken, "track", { id: "a" });
    const limited = errorPayload(await call(usher, accessToken, "track", { id: "b" }));
    expect(limited.error).toContain("Too many calls to track");
    expect((await call(usher, accessToken, "list_orders")).result.isError).toBeFalsy();
  });

  it("counts attempts that would need approval, so an agent can't spam the customer with links", async () => {
    const { usher } = makeShop([rateLimit({ limit: 1, windowSeconds: 60 })]);
    const { accessToken } = await authorizeAgent(usher);
    expect(errorPayload(await call(usher, accessToken, "cancel_order", { orderId: "a" })).code).toBe("confirmation_required");
    expect(errorPayload(await call(usher, accessToken, "cancel_order", { orderId: "b" })).code).toBe("rate_limited");
  });

  it("resets when the window passes", async () => {
    const { usher } = makeShop([rateLimit({ limit: 1, windowSeconds: 60 })]);
    const { accessToken } = await authorizeAgent(usher);
    await call(usher, accessToken, "list_orders");
    expect(errorPayload(await call(usher, accessToken, "list_orders")).code).toBe("rate_limited");
    vi.useFakeTimers({ now: Date.now() + 61_000, toFake: ["Date"] });
    expect((await call(usher, accessToken, "list_orders")).result.isError).toBeFalsy();
  });
});

// ------------------------------------------------------------- kill switch

describe("killSwitch", () => {
  it("blocks what the operator flips off, with an optional message", async () => {
    const off = new Set<string>(["cancel_order"]);
    let everything = false;
    const { usher, ran } = makeShop([
      killSwitch({
        isBlocked: ({ tool }) => (everything ? "Agent access is paused for maintenance." : off.has(tool.name)),
      }),
    ]);
    const { accessToken } = await authorizeAgent(usher);

    expect(errorPayload(await call(usher, accessToken, "cancel_order", { orderId: "o_1" }))).toMatchObject({
      code: "disabled",
      error: "This action is temporarily disabled by the app.",
    });
    expect((await call(usher, accessToken, "list_orders")).result.isError).toBeFalsy();

    everything = true;
    expect(errorPayload(await call(usher, accessToken, "list_orders")).error).toBe("Agent access is paused for maintenance.");
    expect(ran).toEqual({ list: 1, cancel: 0 });
  });
});

// ------------------------------------------------- pipeline, called directly

describe("call pipeline (defense in depth)", () => {
  it("enforces scopes itself, before any plugin, even if dispatch-time checks were bypassed", async () => {
    const { createCallPipeline } = await import("../src/pipeline.js");
    const beforeCall = vi.fn();
    const handler = vi.fn();
    const gate = vi.fn(async () => ({ kind: "allow" as const }));
    const pipeline = createCallPipeline({ plugins: [{ id: "spy", beforeCall }], confirmationGate: gate, onError: () => {} });
    const tool = defineTool({ name: "t", description: "d", input: z.object({}), effect: "read", handler });
    const principal = {
      user: { id: "u" },
      agent: { clientId: "c", name: "A", verified: true },
      grantId: "g",
      scopes: [toolScope("other")],
    };

    const result = await pipeline.run(new Request(BASE), principal, tool, {}, new AbortController().signal);
    expect(result).toEqual({ kind: "forbidden", scope: "tool:t" });
    expect(beforeCall).not.toHaveBeenCalled();
    expect(gate).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("fails closed if Usher's own confirmation gate throws (e.g. the store is down)", async () => {
    const { createCallPipeline } = await import("../src/pipeline.js");
    const onError = vi.fn();
    const handler = vi.fn();
    const pipeline = createCallPipeline({
      plugins: [],
      onError,
      confirmationGate: async () => {
        throw new Error("store unreachable");
      },
    });
    const tool = defineTool({ name: "t", description: "d", input: z.object({}), effect: "destructive", handler });
    const principal = { user: { id: "u" }, agent: { clientId: "c", name: "A", verified: true }, grantId: "g", scopes: ["tool:t"] };
    expect(await pipeline.run(new Request(BASE), principal, tool, {}, new AbortController().signal)).toEqual({ kind: "failed" });
    expect(handler).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { tool: "t" });
  });
});
