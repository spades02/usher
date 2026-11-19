import { auth } from "@modelcontextprotocol/client";
import express from "express";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { doctor } from "../src/cli.js";
import { checkDeployment, createUsher, defineTool, toRouteHandlers, type RouteHandlers, verifyWebhook, type Usher, type UsherOptions } from "../src/index.js";
import { toNodeHandler, type NodeHandlerOptions } from "../src/node.js";
import { createStandaloneServer, resolveEnv, serveFromFile, type StandaloneConfig } from "../src/standalone.js";
import {
  authOptions,
  authorizeAgent,
  BASE,
  callTool,
  connectAgent,
  decideInBrowser,
  errorPayload,
  fetchVia,
  MemoryProvider,
  MCP_URL,
  readRpc,
  SECRET,
  type Target,
} from "./helpers.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** Listens on a random local port. */
async function listen(listener: RequestListener): Promise<number> {
  const server = createServer(listener);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  cleanup.push(
    () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  );
  return (server.address() as { port: number }).port;
}

/**
 * Plays a TLS-terminating reverse proxy in front of a real local server:
 * `https://shop.example/...` goes to `http://127.0.0.1:<port>/...`.
 */
function viaProxy(port: number, forwarded = true): Target {
  return {
    async handler(request) {
      const url = new URL(request.url);
      const headers = new Headers(request.headers);
      if (forwarded) {
        headers.set("x-forwarded-proto", url.protocol.slice(0, -1));
        headers.set("x-forwarded-host", url.host);
      }
      const hasBody = request.method !== "GET" && request.method !== "HEAD";
      return fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body: hasBody ? await request.arrayBuffer() : undefined,
        redirect: "manual",
        signal: request.signal,
      });
    },
  };
}

const ran: string[] = [];
let releaseSlow: (() => void) | undefined;
const slowAborted: { value: boolean } = { value: false };

function makeUsher(overrides: Partial<UsherOptions> = {}): Usher {
  return createUsher({
    ...authOptions,
    app: { name: "Example Shop", version: "1.0.0" },
    baseUrl: BASE,
    tools: [
      defineTool({
        name: "list_orders",
        description: "List orders.",
        input: z.object({ status: z.string().optional() }),
        effect: "read",
        handler: ({ status }, { user }) => {
          ran.push(`list:${user.id}`);
          return { orders: ["o_1"], status: status ?? "any" };
        },
      }),
      defineTool({
        name: "slow",
        description: "Waits until cancelled.",
        input: z.object({}),
        effect: "read",
        handler: (_input, { signal }) =>
          new Promise((ok) => {
            releaseSlow = () => ok({ done: true });
            signal.addEventListener("abort", () => {
              slowAborted.value = true;
              ok({ done: false });
            });
          }),
      }),
    ],
    ...overrides,
  });
}

// ------------------------------------------------------------ one mount

describe("mounting", () => {
  it("file-routed frameworks: one route for {basePath}/* and one for /.well-known/oauth-* are enough", async () => {
    const usher = makeUsher();
    const { GET, POST, OPTIONS, DELETE } = toRouteHandlers(usher);
    const routes: Record<string, RouteHandlers["GET"]> = { GET, POST, OPTIONS, DELETE };
    // app/api/usher/[...usher]/route.ts and app/.well-known/[...usher]/route.ts in Next.js terms.
    const fileRouted: Target = {
      handler(request) {
        const { pathname } = new URL(request.url);
        const routed = pathname.startsWith("/api/usher/") || pathname.startsWith("/.well-known/oauth-");
        return routed ? routes[request.method]!({ request }) : Promise.resolve(new Response("Not found", { status: 404 }));
      },
    };
    const client = await connectAgent(fileRouted);
    expect((await client.callTool({ name: "list_orders", arguments: {} })).structuredContent).toEqual({ orders: ["o_1"], status: "any" });
  });

  it("doctor explains a missing /.well-known mount, a wrong baseUrl, and confirms a good deployment", async () => {
    const usher = makeUsher();
    const onlyBasePath: Target = {
      handler: (request) =>
        new URL(request.url).pathname.startsWith("/api/usher/") ? usher.handler(request) : Promise.resolve(new Response("Not found", { status: 404 })),
    };
    const missing = await checkDeployment(BASE, { fetch: fetchVia(onlyBasePath) });
    expect(missing.ok).toBe(false);
    expect(missing.checks.find((c) => c.name === "Protected resource metadata")).toMatchObject({
      ok: false,
      detail: expect.stringContaining("Route /.well-known/oauth-protected-resource/*"),
    });
    expect(missing.checks.find((c) => c.name === "MCP endpoint challenge")?.ok).toBe(true);

    const internal = makeUsher({ baseUrl: "http://10.0.0.7:3000" }); // The proxy's view leaked into baseUrl.
    const wrong = await checkDeployment(BASE, { fetch: fetchVia(internal) });
    expect(wrong.checks.find((c) => c.name === "Protected resource metadata")?.detail).toContain("expected https://shop.example/api/usher/mcp");

    expect(await checkDeployment(BASE, { fetch: fetchVia(usher) })).toMatchObject({ ok: true });
    expect((await checkDeployment("http://shop.example", { fetch: fetchVia(usher) })).checks[0]).toMatchObject({ name: "HTTPS", ok: false });

    const report = await doctor([BASE], fetchVia(usher) as typeof fetch);
    expect(report).toMatchObject({ code: 0, out: expect.stringContaining("Ready for agents.") });
    expect((await doctor([BASE], fetchVia(onlyBasePath) as typeof fetch)).code).toBe(1);
    expect((await doctor(["not-a-url"])).code).toBe(1);
  });

  it("matches() covers exactly the paths Usher serves", () => {
    const usher = makeUsher();
    for (const p of [
      "/api/usher/mcp",
      "/api/usher/oauth/token",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/api/usher/mcp",
      "/.well-known/oauth-authorization-server/api/usher",
    ]) {
      expect(usher.matches(p), p).toBe(true);
    }
    for (const p of ["/", "/api/usher", "/api/usherx/mcp", "/.well-known/openid-configuration", "/.well-known/oauth-authorization-server", "/.well-known/apple-app-site-association", "/login"]) {
      expect(usher.matches(p), p).toBe(false);
    }
  });
});

// ------------------------------------------------------------ Node / Express

describe("usherjs/node", () => {
  it("Express at the root, after body parsers: full connect, consent and calls; other routes pass through", async () => {
    const usher = makeUsher();
    const app = express();
    app.use(express.json(), express.urlencoded({ extended: false })); // They read the body first.
    app.use(toNodeHandler(usher));
    app.get("/hello", (_req, res) => {
      res.send("app route");
    });
    const port = await listen(app);
    const target = viaProxy(port);

    const client = await connectAgent(target);
    expect((await client.callTool({ name: "list_orders", arguments: { status: "open" } })).structuredContent).toEqual({
      orders: ["o_1"],
      status: "open",
    });
    expect(await (await fetch(`http://127.0.0.1:${port}/hello`)).text()).toBe("app route");
  });

  it("Express under mount paths uses originalUrl", async () => {
    const usher = makeUsher();
    const app = express();
    const handler = toNodeHandler(usher);
    app.use("/api/usher", handler); // Express strips the mount path from req.url.
    app.use("/.well-known", handler);
    const port = await listen(app);
    const client = await connectAgent(viaProxy(port));
    expect((await client.callTool({ name: "list_orders", arguments: {} })).isError).toBeFalsy();
  });

  it("a bare http server: 404 for other paths", async () => {
    const port = await listen(toNodeHandler(makeUsher()) as RequestListener);
    expect((await fetch(`http://127.0.0.1:${port}/elsewhere`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource`)).status).toBe(200);
  });

  it.each([
    [{}, "http://127.0.0.1"],
    [{ trustProxy: true }, "https://shop.example"],
  ] as [NodeHandlerOptions, string][])("X-Forwarded-* is trusted only when asked (%o)", async (opts, origin) => {
    const usher = makeUsher({ baseUrl: undefined });
    const port = await listen(toNodeHandler(usher, opts) as RequestListener);
    const res = await viaProxy(port).handler(new Request(`${BASE}/.well-known/oauth-protected-resource`));
    expect((await res.json()).resource).toMatch(new RegExp(`^${origin.replace(/\./g, "\\.")}(:\\d+)?/api/usher/mcp$`));
  });

  it("checks Origin against baseUrl, not the proxy's internal URL", async () => {
    const usher = makeUsher();
    const port = await listen(toNodeHandler(usher) as RequestListener);
    const { accessToken } = await authorizeAgent(usher);
    const target = viaProxy(port, false); // No forwarded headers: Usher sees http://127.0.0.1:<port>.
    const call = (origin: string) =>
      target.handler(
        new Request(MCP_URL, {
          method: "POST",
          headers: {
            origin,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
        }),
      );
    expect((await call(BASE)).status).not.toBe(403);
    expect((await call("https://evil.example")).status).toBe(403);
  });

  // 2025 clients get an SSE stream, which the SDK tears down when it closes. 2026 clients get
  // one JSON response at the end, so only the HTTP request's own signal can stop the tool.
  it.each([
    ["2025 (SSE)", {}, {}],
    [
      "2026 (JSON)",
      { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "slow" },
      {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": { name: "raw-agent", version: "1.0.0" },
        },
      },
    ],
  ])("aborts the tool's signal when a %s agent disconnects mid-call", async (_era, headers, params) => {
    slowAborted.value = false;
    releaseSlow = undefined;
    const usher = makeUsher();
    const port = await listen(toNodeHandler(usher) as RequestListener);
    const target = viaProxy(port);
    const { accessToken } = await authorizeAgent(target);
    const controller = new AbortController();
    const call = target.handler(
      new Request(MCP_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${accessToken}`,
          ...headers,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slow", arguments: {}, ...params } }),
      }),
    );
    await expect.poll(() => releaseSlow).toBeTypeOf("function");
    controller.abort();
    await expect(call).rejects.toThrow();
    await expect.poll(() => slowAborted.value).toBe(true);
    releaseSlow = undefined;
  });
});

// ------------------------------------------------------- file-routed frameworks

it("toRouteHandlers accepts a Request or a framework event", async () => {
  const handlers = toRouteHandlers(makeUsher());
  const url = `${BASE}/.well-known/oauth-protected-resource`;
  expect((await handlers.GET(new Request(url))).status).toBe(200); // Next.js, Bun
  expect((await handlers.GET({ request: new Request(url) }, { params: {} })).status).toBe(200); // SvelteKit, Astro, Remix
  expect((await handlers.OPTIONS(new Request(url, { method: "OPTIONS" }))).status).toBe(204);
});

// --------------------------------------------------------- standalone server

const WEBHOOK_SECRET = "webhook-secret-0123456789-abcdefghijkl";
const ADMIN_TOKEN = "admin-token-0123456789-abcdefghijklmnopq";

/** A non-JS app, played by a bare Node server: a session endpoint and tool webhooks. */
async function fakeApp() {
  const calls: { path: string; body: any; verified: boolean }[] = [];
  const session = { calls: 0 };
  const port = await listen(async (req, res) => {
    if (req.url === "/usher/session") {
      session.calls++;
      const id = req.headers.cookie?.match(/session=([^;]+)/)?.[1];
      if (!id) return void res.writeHead(401).end();
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id, name: `User ${id}` }));
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const verified = await verifyWebhook(WEBHOOK_SECRET, raw, req.headers["usher-signature"] as string);
    calls.push({ path: req.url!, body: JSON.parse(raw), verified });
    if (!verified) return void res.writeHead(401).end();
    const json = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    const { input, user } = JSON.parse(raw);
    if (req.url === "/hooks/orders") return void json(200, { orders: [`${user.id}:o_1`] });
    if (req.url === "/hooks/cancel") {
      if (input.orderId === "shipped") return void json(422, { error: "Shipped orders can't be cancelled", code: "shipped" });
      return void json(200, { cancelled: input.orderId });
    }
    if (req.url === "/hooks/boom") return void json(500, { error: "database is down at 10.0.0.3" });
    json(404, {});
  });
  return { port, calls, session };
}

function standaloneConfig(appPort: number): StandaloneConfig {
  const hook = (path: string) => `http://127.0.0.1:${appPort}/hooks/${path}`;
  return {
    app: { name: "Rails Shop", version: "2.0.0" },
    baseUrl: BASE,
    secret: SECRET,
    database: "sqlite::memory:",
    webhookSecret: WEBHOOK_SECRET,
    adminToken: ADMIN_TOKEN,
    identity: { sessionUrl: `http://127.0.0.1:${appPort}/usher/session`, loginUrl: `${BASE}/login?next={returnTo}` },
    tools: [
      { name: "list_orders", description: "List orders.", effect: "read", input: { type: "object", properties: {} }, url: hook("orders") },
      {
        name: "cancel_order",
        description: "Cancel an order.",
        effect: "destructive",
        confirm: "Cancel order {orderId}",
        input: { type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"], additionalProperties: false },
        url: hook("cancel"),
      },
      { name: "report", description: "Breaks.", effect: "read", input: { type: "object", properties: {} }, url: hook("boom") },
    ],
  };
}

describe("usherjs serve (standalone, for apps not written in JS)", () => {
  async function start() {
    const app = await fakeApp();
    const standalone = await createStandaloneServer(standaloneConfig(app.port));
    const port = await standalone.listen(0, "127.0.0.1");
    cleanup.push(() => standalone.close());
    return { app, port, target: viaProxy(port) };
  }

  it("connects an agent with the app's own login, and runs tools as signed webhooks", async () => {
    const { app, target } = await start();
    const client = await connectAgent(target, { mode: "dcr" });
    const tools = await client.listTools();
    expect(tools.tools.find((t) => t.name === "cancel_order")?.inputSchema).toMatchObject({ required: ["orderId"] });

    expect((await client.callTool({ name: "list_orders", arguments: {} })).structuredContent).toEqual({ orders: ["user_1:o_1"] });
    expect(app.calls[0]).toMatchObject({
      path: "/hooks/orders",
      verified: true,
      body: { tool: "list_orders", input: {}, user: { id: "user_1" }, agent: { name: "Test Agent" } },
    });
  });

  it("destructive webhooks wait for approval on the app's domain, then run once", async () => {
    const { app, target } = await start();
    const { accessToken } = await authorizeAgent(target, { mode: "dcr" });
    const pending = errorPayload(await readRpc(await callTool(target, accessToken, "cancel_order", { orderId: "o_9" })));
    expect(pending.code).toBe("confirmation_required");
    expect(pending.confirm_url.startsWith(`${BASE}/api/usher/confirm/`)).toBe(true);
    expect(app.calls).toHaveLength(0);

    const { html } = await decideInBrowser(target, pending.confirm_url);
    expect(html).toContain("Cancel order o_9");
    const done = await readRpc(await callTool(target, accessToken, "cancel_order", { orderId: "o_9" }));
    expect(done.result.structuredContent).toEqual({ cancelled: "o_9" });
    expect(app.calls).toHaveLength(1);
  });

  it("maps webhook failures: 4xx is shown to the agent, 5xx stays private; bad input never reaches the app", async () => {
    const { app, target } = await start();
    const { accessToken } = await authorizeAgent(target, { mode: "dcr" });

    const shipped = await readRpc(await callTool(target, accessToken, "cancel_order", { orderId: "shipped" }));
    const { confirm_url } = errorPayload(shipped);
    await decideInBrowser(target, confirm_url);
    expect(errorPayload(await readRpc(await callTool(target, accessToken, "cancel_order", { orderId: "shipped" })))).toEqual({
      error: "Shipped orders can't be cancelled",
      code: "shipped",
    });

    const boom = await readRpc(await callTool(target, accessToken, "report", {}));
    expect(boom.result.isError).toBe(true);
    expect(JSON.stringify(boom)).not.toContain("10.0.0.3");

    const before = app.calls.length;
    const bad = await readRpc(await callTool(target, accessToken, "cancel_order", { orderId: 42 }));
    expect(bad.result?.isError ?? bad.error).toBeTruthy();
    expect(app.calls.length).toBe(before);
  });

  it("sends signed-out customers to the app's login page", async () => {
    const { app, target } = await start();
    const provider = new MemoryProvider("dcr");
    expect(await auth(provider, { serverUrl: MCP_URL, fetchFn: fetchVia(target) })).toBe("REDIRECT");
    const res = await target.handler(new Request(provider.authorizationUrl!)); // No session cookie.
    expect(res.status).toBe(302);
    expect(app.session.calls).toBe(0); // Nothing to identify: the app isn't asked.
    const login = new URL(res.headers.get("location")!);
    expect(login.origin + login.pathname).toBe(`${BASE}/login`);
    expect(login.searchParams.get("next")?.startsWith(`${BASE}/api/usher/oauth/authorize?`)).toBe(true);
  });

  it("admin API: the app's backend lists and revokes connected agents", async () => {
    const { port, target } = await start();
    const { accessToken } = await authorizeAgent(target, { mode: "dcr" });
    const admin = (path: string, init: RequestInit = {}, token = ADMIN_TOKEN) =>
      fetch(`http://127.0.0.1:${port}/api/usher/admin${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } });

    expect((await admin("/users/user_1/grants", {}, "wrong-token")).status).toBe(401);
    const { grants } = await (await admin("/users/user_1/grants")).json();
    expect(grants).toHaveLength(1);

    expect((await admin(`/users/user_1/grants/${grants[0].id}/scopes`, { method: "PUT", body: JSON.stringify({ scopes: ["tool:list_orders"] }) })).status).toBe(204);
    expect((await admin(`/users/user_1/grants/${grants[0].id}`, { method: "DELETE" })).status).toBe(204);
    expect((await callTool(target, accessToken, "list_orders", {})).status).toBe(401);
    const { events } = await (await admin("/users/user_1/events")).json();
    expect(events.map((e: { type: string }) => e.type)).toEqual(expect.arrayContaining(["grant.created", "grant.updated", "grant.revoked"]));
  });

  it("serves from a config file with env: secrets", async () => {
    const app = await fakeApp();
    const dir = await mkdtemp(join(tmpdir(), "usher-"));
    const file = join(dir, "usher.config.json");
    await writeFile(file, JSON.stringify({ ...standaloneConfig(app.port), secret: "env:USHER_SECRET", webhookSecret: "env:USHER_WEBHOOK_SECRET" }));
    const standalone = await serveFromFile(file, { USHER_SECRET: SECRET, USHER_WEBHOOK_SECRET: WEBHOOK_SECRET, PORT: "0" });
    cleanup.push(() => standalone.close());
    const port = (standalone.server.address() as { port: number }).port;
    expect(await (await fetch(`http://127.0.0.1:${port}/healthz`)).text()).toBe("ok");

    expect(() => resolveEnv({ secret: "env:MISSING" }, {})).toThrow(/MISSING/);
    await expect(createStandaloneServer({ ...standaloneConfig(app.port), webhookSecret: "short" })).rejects.toThrow();
  });
});

describe("webhook signatures", () => {
  it("reject tampered bodies, wrong secrets and stale timestamps", async () => {
    const body = JSON.stringify({ tool: "x" });
    const t = Math.floor(Date.now() / 1000);
    const { createHmac } = await import("node:crypto");
    const header = (secret: string, ts = t, b = body) => `t=${ts},v1=${createHmac("sha256", secret).update(`${ts}.${b}`).digest("hex")}`;

    expect(await verifyWebhook(WEBHOOK_SECRET, body, header(WEBHOOK_SECRET))).toBe(true); // Plain HMAC: any language can verify.
    expect(await verifyWebhook(WEBHOOK_SECRET, body + " ", header(WEBHOOK_SECRET))).toBe(false);
    expect(await verifyWebhook(WEBHOOK_SECRET, body, header("another-secret-0123456789-abcdefghij"))).toBe(false);
    expect(await verifyWebhook(WEBHOOK_SECRET, body, header(WEBHOOK_SECRET, t - 600))).toBe(false);
    expect(await verifyWebhook(WEBHOOK_SECRET, body, null)).toBe(false);
  });
});
