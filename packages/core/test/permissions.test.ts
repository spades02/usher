import { UnauthorizedError } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createUsher, defineTool, toolScope, type Usher } from "../src/index.js";
import {
  AGENT_CIMD,
  AGENT_REDIRECT,
  BASE,
  MCP_URL,
  authOptions,
  authorizeAgent,
  connectAgent,
  consentInBrowser,
  consentScopes,
} from "./helpers.js";

// ------------------------------------------------------------------ fixtures

function makeShop() {
  const ran = { cancel: 0, refund: 0, wipe: 0 };
  const tools = [
    defineTool({
      name: "list_orders",
      description: "List the customer's orders.",
      input: z.object({}),
      effect: "read",
      handler: () => ({ orders: ["o_1", "o_2"] }),
    }),
    defineTool({
      name: "update_address",
      description: "Change the delivery address.",
      input: z.object({ address: z.string() }),
      effect: "write",
      handler: ({ address }) => ({ address }),
    }),
    defineTool({
      name: "cancel_order",
      title: "Cancel order",
      description: "Cancel an order that hasn't shipped.",
      input: z.object({ orderId: z.string(), reason: z.string().optional() }),
      effect: "destructive",
      confirm: ({ orderId }) => `Cancel order ${orderId}`,
      handler: ({ orderId }) => {
        ran.cancel++;
        return { cancelled: orderId };
      },
    }),
    defineTool({
      name: "refund",
      description: "Refund a payment. Reversible by finance, but money moves.",
      input: z.object({ amount: z.number() }),
      effect: "write",
      confirm: true,
      handler: ({ amount }) => {
        ran.refund++;
        return { refunded: amount };
      },
    }),
    defineTool({
      name: "clear_cart",
      description: "Empty the cart.",
      input: z.object({}),
      effect: "destructive",
      confirm: false,
      handler: () => {
        ran.wipe++;
        return { cleared: true };
      },
    }),
  ];
  const usher = createUsher({ ...authOptions, app: { name: "Example Shop", version: "1.0.0" }, tools });
  return { usher, ran };
}

// In consent-page order: grouped by effect (read, write, destructive).
const ALL = ["list_orders", "update_address", "refund", "cancel_order", "clear_cart"].map(toolScope);

/** A raw 2026-07-28 tools/call, so tests can see HTTP statuses and headers. */
function callTool(
  usher: Usher,
  token: string,
  name: string,
  args: Record<string, unknown>,
  extra: { capabilities?: Record<string, unknown>; params?: Record<string, unknown> } = {},
) {
  return usher.handler(
    new Request(MCP_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": name,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": extra.capabilities ?? {},
            "io.modelcontextprotocol/clientInfo": { name: "raw-agent", version: "1.0.0" },
          },
          name,
          arguments: args,
          ...extra.params,
        },
      }),
    }),
  );
}

async function readRpc(res: Response): Promise<any> {
  const body = await res.text();
  if (!res.headers.get("content-type")?.includes("text/event-stream")) return JSON.parse(body);
  return body
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)))
    .find((m) => "result" in m || "error" in m);
}

/** The tool error payload Usher puts in a result's text content. */
function errorPayload(rpc: any) {
  expect(rpc.result.isError).toBe(true);
  return JSON.parse(rpc.result.content[0].text);
}

/** Plays the customer on the approval page. */
async function decideInBrowser(
  usher: Usher,
  url: string,
  { userId = "user_1", decision = "allow" }: { userId?: string; decision?: "allow" | "deny" } = {},
) {
  const cookie = `session=${userId}`;
  const page = await usher.handler(new Request(url, { headers: { cookie } }));
  expect(page.status).toBe(200);
  const html = await page.text();
  const confirmToken = html.match(/name="confirm_token" value="([^"]+)"/)?.[1];
  expect(confirmToken).toBeTruthy();
  const res = await usher.handler(
    new Request(url, {
      method: "POST",
      headers: { cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ confirm_token: confirmToken!, decision }),
    }),
  );
  return { html, res, confirmToken: confirmToken! };
}

function authorizeUrl(params: Record<string, string>) {
  const url = new URL(`${BASE}/api/usher/oauth/authorize`);
  const all = {
    response_type: "code",
    client_id: AGENT_CIMD,
    redirect_uri: AGENT_REDIRECT,
    code_challenge_method: "S256",
    code_challenge: "a".repeat(43),
    resource: MCP_URL,
    ...params,
  };
  for (const [k, v] of Object.entries(all)) url.searchParams.set(k, v);
  return url;
}

async function consentPage(usher: Usher, params: Record<string, string> = {}) {
  return usher.handler(new Request(authorizeUrl(params), { headers: { cookie: "session=user_1" } }));
}

afterEach(() => vi.useRealTimers());

// -------------------------------------------------------------------- scopes

describe("per-tool scopes", () => {
  it("lets the customer pick tools; the token's scope says what was granted", async () => {
    const { usher } = makeShop();
    const html = await (await consentPage(usher)).text();
    // An open request (no scope) offers every tool, all ticked.
    expect(consentScopes(html)).toEqual({ offered: ALL, checked: ALL });

    const { provider } = await authorizeAgent(usher, { scopes: [toolScope("list_orders")] });
    expect(provider.tokens().scope).toBe("tool:list_orders");
    const [grant] = await usher.grants.list("user_1");
    expect(grant!.scopes).toEqual(["tool:list_orders"]);
  });

  it("still lists every tool, but answers an ungranted call with a 403 step-up challenge", async () => {
    const { usher } = makeShop();
    const { accessToken } = await authorizeAgent(usher, { scopes: [toolScope("list_orders")] });

    const allowed = await readRpc(await callTool(usher, accessToken, "list_orders", {}));
    expect(allowed.result.structuredContent.orders).toEqual(["o_1", "o_2"]);

    const res = await callTool(usher, accessToken, "update_address", { address: "1 Main St" });
    expect(res.status).toBe(403);
    const challenge = res.headers.get("www-authenticate")!;
    expect(challenge).toContain('error="insufficient_scope"');
    // Granted + needed, so clients that replace instead of union keep what they had.
    expect(challenge).toContain('scope="tool:list_orders tool:update_address"');
    expect(challenge).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/api/usher/mcp"`);
  });

  it("steps up end to end with the official SDK client, keeping one grant", async () => {
    const { usher } = makeShop();
    const client = await connectAgent(usher, { scopes: [toolScope("list_orders")] });
    expect((await client.listTools()).tools).toHaveLength(5);

    // The SDK sees the 403, unions the scopes and starts a new authorization.
    await expect(client.callTool({ name: "update_address", arguments: { address: "1 Main St" } })).rejects.toThrow(
      UnauthorizedError,
    );
    const stepUpUrl = client.provider.authorizationUrl!;
    expect(stepUpUrl.searchParams.get("scope")!.split(" ").sort()).toEqual(["tool:list_orders", "tool:update_address"]);

    // The customer sees a "more access" screen with both tools ticked.
    const page = await usher.handler(new Request(stepUpUrl, { headers: { cookie: "session=user_1" } }));
    const html = await page.text();
    expect(html).toContain("Test Agent wants more access");
    expect(consentScopes(html).checked).toEqual(["tool:list_orders", "tool:update_address"]);

    const callback = await consentInBrowser(usher, stepUpUrl);
    await client.http.finishAuth(callback.searchParams.get("code")!, callback.searchParams.get("iss") ?? undefined);

    const result = await client.callTool({ name: "update_address", arguments: { address: "1 Main St" } });
    expect(result.structuredContent).toEqual({ address: "1 Main St" });
    const grants = await usher.grants.list("user_1");
    expect(grants).toHaveLength(1);
    expect(grants[0]!.scopes.sort()).toEqual(["tool:list_orders", "tool:update_address"]);
  });

  it("skips consent when an explicit request is already covered, shows it when it isn't", async () => {
    const { usher } = makeShop();
    await authorizeAgent(usher, { scopes: [toolScope("list_orders"), toolScope("update_address")] });

    const covered = await consentPage(usher, { scope: "tool:list_orders" });
    expect(covered.status).toBe(302);
    expect(new URL(covered.headers.get("location")!).searchParams.get("code")).toBeTruthy();

    const more = await consentPage(usher, { scope: "tool:refund" });
    expect(more.status).toBe(200);
    // Only what's granted plus what's asked for is offered.
    expect(consentScopes(await more.text()).offered).toEqual([
      "tool:list_orders",
      "tool:update_address",
      "tool:refund",
    ]);
  });

  it("treats a reconnect without scopes as covered, and prompt=consent as 'edit permissions'", async () => {
    const { usher } = makeShop();
    await authorizeAgent(usher, { scopes: [toolScope("list_orders")] });

    expect((await consentPage(usher)).status).toBe(302);
    // Unknown scopes like openid are ignored, so this is still an open request.
    expect((await consentPage(usher, { scope: "openid offline_access" })).status).toBe(302);

    const edit = await consentPage(usher, { prompt: "consent" });
    expect(consentScopes(await edit.text())).toEqual({ offered: ALL, checked: ["tool:list_orders"] });
  });

  it("ignores scopes that weren't offered on the page, even if the form is edited", async () => {
    const { usher } = makeShop();
    const callback = await consentInBrowser(usher, authorizeUrl({ scope: "tool:list_orders", state: "s" }), {
      scopes: ["tool:list_orders", "tool:cancel_order"],
    });
    expect(callback.searchParams.get("code")).toBeTruthy();
    const [grant] = await usher.grants.list("user_1");
    expect(grant!.scopes).toEqual(["tool:list_orders"]);
  });

  it("treats Allow with nothing ticked as a denial", async () => {
    const { usher } = makeShop();
    const callback = await consentInBrowser(usher, authorizeUrl({ state: "s" }), { scopes: [] });
    expect(callback.searchParams.get("error")).toBe("access_denied");
    expect(await usher.grants.list("user_1")).toHaveLength(0);
  });

  it("grants.setScopes changes permissions on the agent's very next call", async () => {
    const { usher } = makeShop();
    const { accessToken } = await authorizeAgent(usher);
    expect((await callTool(usher, accessToken, "list_orders", {})).status).toBe(200);

    const [grant] = await usher.grants.list("user_1");
    await usher.grants.setScopes("user_1", grant!.id, [toolScope("update_address")]);
    expect((await callTool(usher, accessToken, "list_orders", {})).status).toBe(403);

    // Only the grant's owner can change it, and only to real tools.
    await usher.grants.setScopes("user_2", grant!.id, ALL);
    expect((await callTool(usher, accessToken, "list_orders", {})).status).toBe(403);
    await expect(usher.grants.setScopes("user_1", grant!.id, ["tool:nope"])).rejects.toThrow(/Unknown scopes/);
  });
});

// -------------------------------------------------------------- confirmation

describe("confirmation for destructive actions", () => {
  async function setup() {
    const shop = makeShop();
    const { accessToken } = await authorizeAgent(shop.usher);
    return { ...shop, accessToken };
  }

  async function requestCancel(usher: Usher, token: string, args: Record<string, unknown> = { orderId: "o_1" }) {
    return errorPayload(await readRpc(await callTool(usher, token, "cancel_order", args)));
  }

  it("doesn't run the handler until the customer approves on the app's own site", async () => {
    const { usher, ran, accessToken } = await setup();
    const blocked = await requestCancel(usher, accessToken);
    expect(blocked.code).toBe("confirmation_required");
    expect(blocked.confirm_url).toMatch(new RegExp(`^${BASE}/api/usher/confirm/usher_cf_`));
    expect(blocked.error).toContain(blocked.confirm_url);
    expect(ran.cancel).toBe(0);

    // Asking again before approval reuses the same pending approval.
    expect((await requestCancel(usher, accessToken)).confirm_url).toBe(blocked.confirm_url);

    const { html, res } = await decideInBrowser(usher, blocked.confirm_url);
    expect(html).toContain("Test Agent wants to: Cancel order o_1");
    expect(html).toContain("&quot;orderId&quot;: &quot;o_1&quot;");
    expect(await res.text()).toContain("It can now finish: Cancel order o_1");

    const done = await readRpc(await callTool(usher, accessToken, "cancel_order", { orderId: "o_1" }));
    expect(done.result.structuredContent).toEqual({ cancelled: "o_1" });
    expect(ran.cancel).toBe(1);
  });

  it("an approval works once, for exactly the approved arguments", async () => {
    const { usher, ran, accessToken } = await setup();
    await decideInBrowser(usher, (await requestCancel(usher, accessToken)).confirm_url);

    // Different arguments are a different action.
    expect((await requestCancel(usher, accessToken, { orderId: "o_2" })).code).toBe("confirmation_required");
    expect((await requestCancel(usher, accessToken, { orderId: "o_1", reason: "x" })).code).toBe("confirmation_required");
    expect(ran.cancel).toBe(0);

    await callTool(usher, accessToken, "cancel_order", { orderId: "o_1" });
    expect(ran.cancel).toBe(1);
    // Replaying the approved call needs a fresh approval.
    expect((await requestCancel(usher, accessToken)).code).toBe("confirmation_required");
    expect(ran.cancel).toBe(1);
  });

  it("runs exactly once when an approved call is retried concurrently", async () => {
    const { usher, ran, accessToken } = await setup();
    await decideInBrowser(usher, (await requestCancel(usher, accessToken)).confirm_url);
    await Promise.all([1, 2, 3].map(() => callTool(usher, accessToken, "cancel_order", { orderId: "o_1" })));
    expect(ran.cancel).toBe(1);
  });

  it("tells the agent when the customer declines, then starts over on a new request", async () => {
    const { usher, ran, accessToken } = await setup();
    const first = await requestCancel(usher, accessToken);
    const { res } = await decideInBrowser(usher, first.confirm_url, { decision: "deny" });
    expect(await res.text()).toContain("Test Agent won&#39;t do this");

    expect((await requestCancel(usher, accessToken)).code).toBe("confirmation_declined");
    const again = await requestCancel(usher, accessToken);
    expect(again.code).toBe("confirmation_required");
    expect(again.confirm_url).not.toBe(first.confirm_url);
    expect(ran.cancel).toBe(0);
  });

  it("follows the tool's confirm setting, not just its effect", async () => {
    const { usher, ran, accessToken } = await setup();
    // write + confirm: true asks first...
    expect(errorPayload(await readRpc(await callTool(usher, accessToken, "refund", { amount: 5 }))).code).toBe(
      "confirmation_required",
    );
    expect(ran.refund).toBe(0);
    // ...destructive + confirm: false doesn't.
    const cleared = await readRpc(await callTool(usher, accessToken, "clear_cart", {}));
    expect(cleared.result.structuredContent).toEqual({ cleared: true });
    // Plain writes never ask.
    expect((await readRpc(await callTool(usher, accessToken, "update_address", { address: "x" }))).result.isError).toBeFalsy();
  });

  it("uses native URL elicitation for 2026-07-28 clients that support it", async () => {
    const { usher, ran, accessToken } = await setup();
    const capabilities = { elicitation: { url: {} } };
    const first = await readRpc(await callTool(usher, accessToken, "cancel_order", { orderId: "o_1" }, { capabilities }));
    expect(first.result.resultType).toBe("input_required");
    const request = first.result.inputRequests.usher_confirm;
    expect(request.method).toBe("elicitation/create");
    expect(request.params.mode).toBe("url");
    expect(request.params.url).toMatch(/\/api\/usher\/confirm\/usher_cf_/);
    expect(request.params.message).toContain("Cancel order o_1");

    await decideInBrowser(usher, request.params.url);
    const retry = await readRpc(
      await callTool(usher, accessToken, "cancel_order", { orderId: "o_1" }, {
        capabilities,
        params: { inputResponses: { usher_confirm: { action: "accept" } } },
      }),
    );
    expect(retry.result.structuredContent).toEqual({ cancelled: "o_1" });
    expect(ran.cancel).toBe(1);
  });

  it("doesn't loop when a URL-elicitation client retries before the customer approved", async () => {
    const { usher, accessToken } = await setup();
    const capabilities = { elicitation: { url: {} } };
    await callTool(usher, accessToken, "cancel_order", { orderId: "o_1" }, { capabilities });
    const retry = await readRpc(
      await callTool(usher, accessToken, "cancel_order", { orderId: "o_1" }, {
        capabilities,
        params: { inputResponses: { usher_confirm: { action: "accept" } } },
      }),
    );
    expect(errorPayload(retry).code).toBe("confirmation_required");
  });
});

describe("approval page security", () => {
  async function pending() {
    const shop = makeShop();
    const { accessToken } = await authorizeAgent(shop.usher);
    const rpc = await readRpc(await callTool(shop.usher, accessToken, "cancel_order", { orderId: "<b>o_1</b>" }));
    return { ...shop, accessToken, url: errorPayload(rpc).confirm_url as string };
  }

  it("sends signed-out customers to login and back, and refuses other accounts", async () => {
    const { usher, url } = await pending();
    const signedOut = await usher.handler(new Request(url));
    expect(signedOut.status).toBe(302);
    expect(signedOut.headers.get("location")).toBe(`${BASE}/login?returnTo=${encodeURIComponent(url)}`);

    const other = await usher.handler(new Request(url, { headers: { cookie: "session=user_2" } }));
    expect(other.status).toBe(403);
    expect(await other.text()).not.toContain("o_1");
  });

  it("escapes agent-controlled arguments and can't be framed or cached", async () => {
    const { usher, url } = await pending();
    const res = await usher.handler(new Request(url, { headers: { cookie: "session=user_1" } }));
    const html = await res.text();
    expect(html).not.toContain("<b>o_1</b>");
    expect(html).toContain("Cancel order &lt;b&gt;o_1&lt;/b&gt;");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects cross-site posts, tampered tokens, other users and consent tokens", async () => {
    const { usher, ran, accessToken, url } = await pending();
    const { confirmToken } = await (async () => {
      const html = await (await usher.handler(new Request(url, { headers: { cookie: "session=user_1" } }))).text();
      return { confirmToken: html.match(/name="confirm_token" value="([^"]+)"/)![1]! };
    })();
    const post = (token: string, headers: Record<string, string> = {}) =>
      usher.handler(
        new Request(url, {
          method: "POST",
          headers: { cookie: "session=user_1", origin: BASE, "content-type": "application/x-www-form-urlencoded", ...headers },
          body: new URLSearchParams({ confirm_token: token, decision: "allow" }),
        }),
      );

    expect((await post(confirmToken, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(confirmToken.slice(0, -2) + "xx")).status).toBe(400);
    expect((await post(confirmToken, { cookie: "session=user_2" })).status).toBe(403);
    // A consent-screen token, signed with the same secret, is not an approval.
    const consentHtml = await (await consentPage(usher, { prompt: "consent" })).text();
    const consentToken = consentHtml.match(/name="consent_token" value="([^"]+)"/)![1]!;
    expect((await post(consentToken)).status).toBe(400);

    await callTool(usher, accessToken, "cancel_order", { orderId: "<b>o_1</b>" });
    expect(ran.cancel).toBe(0);
  });

  it("expires, and dies with the agent's grant", async () => {
    const { usher, url } = await pending();
    const [grant] = await usher.grants.list("user_1");
    await usher.grants.revoke("user_1", grant!.id);
    expect((await usher.handler(new Request(url, { headers: { cookie: "session=user_1" } }))).status).toBe(410);

    const other = await pending();
    vi.useFakeTimers({ now: Date.now() + 16 * 60 * 1000, toFake: ["Date"] });
    expect((await other.usher.handler(new Request(other.url, { headers: { cookie: "session=user_1" } }))).status).toBe(404);
  });
});

describe("startup", () => {
  it("rejects a confirm setting that isn't a boolean or function", () => {
    expect(() =>
      createUsher({
        ...authOptions,
        app: { name: "x", version: "1" },
        tools: [
          // @ts-expect-error confirm must be boolean or function
          defineTool({ name: "t", description: "d", input: z.object({}), effect: "write", confirm: "yes", handler: () => 1 }),
        ],
      }),
    ).toThrow(/confirm must be a boolean or a function/);
  });
});
