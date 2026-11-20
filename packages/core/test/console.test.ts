import { describe, expect, it } from "vitest";
import { z } from "zod";
import { auditLog, createUsher, defineTool, memoryAuditSink, type UsherOptions } from "../src/index.js";
import { authOptions, authorizeAgent, BASE, callTool } from "./helpers.js";

const STAFF = "staff_1";

function makeUsher(overrides: Partial<UsherOptions> = {}) {
  const sink = memoryAuditSink();
  const usher = createUsher({
    ...authOptions,
    app: { name: "Example Shop", version: "1.0.0" },
    baseUrl: BASE,
    plugins: [auditLog({ sink })],
    console: { isOperator: (user) => user.id === STAFF, events: sink },
    tools: [
      defineTool({ name: "list_orders", description: "List.", input: z.object({}), effect: "read", handler: () => ({ orders: [] }) }),
      defineTool({
        name: "crash",
        description: "Breaks.",
        input: z.object({}),
        effect: "read",
        handler: () => {
          throw new Error("db down");
        },
      }),
    ],
    onError: () => {},
    ...overrides,
  });
  return { usher, sink };
}

const page = (usher: ReturnType<typeof makeUsher>["usher"], path: string, user: string | null = STAFF, init: RequestInit = {}) =>
  usher.handler(
    new Request(`${BASE}/api/usher/console${path}`, {
      ...init,
      headers: { ...(user ? { cookie: `session=${user}` } : {}), ...(init.headers as Record<string, string>) },
      redirect: "manual",
    }),
  );

describe("operator console", () => {
  it("is off unless configured", async () => {
    const { usher } = makeUsher({ console: undefined });
    expect((await page(usher, "")).status).toBe(404);
    expect(() => makeUsher({ console: { events: memoryAuditSink() } as never })).toThrow(/isOperator/);
  });

  it("is only for operators: signed-out staff log in, customers get 403", async () => {
    const { usher } = makeUsher();
    const signedOut = await page(usher, "", null);
    expect(signedOut.status).toBe(302);
    expect(new URL(signedOut.headers.get("location")!).searchParams.get("returnTo")).toBe(`${BASE}/api/usher/console`);
    expect((await page(usher, "", "user_1")).status).toBe(403);
    expect((await page(usher, "/users/user_1", "user_1")).status).toBe(403);

    const ok = await page(usher, "");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
    expect(ok.headers.get("x-frame-options")).toBe("DENY");
    expect(ok.headers.get("cache-control")).toBe("no-store");
  });

  it("overview: activity in the last 24 hours, by agent and tool, with alerts", async () => {
    const { usher, sink } = makeUsher();
    const { accessToken } = await authorizeAgent(usher);
    await callTool(usher, accessToken, "list_orders", {});
    await callTool(usher, accessToken, "list_orders", {});
    await callTool(usher, accessToken, "crash", {});
    const agent = { clientId: "https://evil.example/c.json", name: `<script>alert(1)</script>`, verified: false };
    await sink.write({ type: "grant.revoked", at: Date.now(), userId: "user_2", agent, grantId: "g_x", reason: "token_replay" });
    await sink.write({
      type: "call",
      at: Date.now() - 2 * 86_400_000,
      userId: "user_3",
      agent,
      grantId: "g_y",
      tool: "list_orders",
      effect: "read",
      outcome: "success",
      durationMs: 1,
      inputHash: "h",
    });

    const html = await (await page(usher, "")).text();
    const stat = (label: string) => html.match(new RegExp(`<div class="value">([^<]+)</div><div class="meta">${label}</div>`))?.[1];
    expect(stat("tool calls")).toBe("3"); // The 2-day-old call is outside the window.
    expect(stat("succeeded")).toBe("67%");
    expect(stat("crashed calls")).toBe("1");
    expect(stat("token replays")).toBe("1");
    expect(stat("customers active")).toBe("2");
    expect(html).toContain("Stolen-token replay detected");
    expect(html).toContain("crash crashed for Test Agent");
    expect(html).toContain("<strong>Test Agent</strong>");
    // Agent names are chosen by agents: always escaped.
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("db down"); // Error details stay in onError.
  });

  it("events: filterable, newest first", async () => {
    const { usher } = makeUsher();
    const { accessToken } = await authorizeAgent(usher);
    await callTool(usher, accessToken, "list_orders", {});
    const all = await (await page(usher, "/events")).text();
    expect(all.indexOf("<td>call</td>")).toBeLessThan(all.indexOf("<td>grant.created</td>"));
    const onlyGrants = await (await page(usher, "/events?type=grant.created")).text();
    expect(onlyGrants).toContain("<td>grant.created</td>");
    expect(onlyGrants).not.toContain("<td>call</td>");
    expect(await (await page(usher, "/events?user=nobody")).text()).toContain("No events.");
  });

  it("customer lookup: staff can disconnect a customer's agent, recorded as an operator action", async () => {
    const { usher, sink } = makeUsher();
    const { accessToken } = await authorizeAgent(usher);
    const lookup = await page(usher, "/users?id=user_1");
    expect(lookup.status).toBe(303);
    expect(lookup.headers.get("location")).toBe("/api/usher/console/users/user_1");

    const html = await (await page(usher, "/users/user_1")).text();
    expect(html).toContain("<strong>Test Agent</strong>");
    expect(html).toContain("list_orders, crash");
    const action = html.match(/<form method="post" action="([^"]+)">/)![1]!;
    const token = html.match(/name="token" value="([^"]+)"/)![1]!;
    const post = (body: string, headers: Record<string, string> = { origin: BASE }, user = STAFF, path = action) =>
      usher.handler(
        new Request(new URL(path, BASE), {
          method: "POST",
          redirect: "manual",
          headers: { cookie: `session=${user}`, "content-type": "application/x-www-form-urlencoded", ...headers },
          body,
        }),
      );

    // CSRF and token binding.
    expect((await post(`token=${encodeURIComponent(token)}`, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post("token=forged")).status).toBe(400);
    expect((await post(`token=${encodeURIComponent(token)}`, { origin: BASE }, "user_1")).status).toBe(403); // Not an operator.
    expect(
      (await post(`token=${encodeURIComponent(token)}`, { origin: BASE }, STAFF, action.replace(/grants\/[^/]+/, "grants/g_other"))).status,
    ).toBe(400);
    expect((await callTool(usher, accessToken, "list_orders", {})).status).toBe(200);

    const done = await post(`token=${encodeURIComponent(token)}`);
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/api/usher/console/users/user_1?disconnected=1");
    expect((await callTool(usher, accessToken, "list_orders", {})).status).toBe(401);
    const [revoked] = await sink.list({ type: "grant.revoked" });
    expect(revoked).toMatchObject({ reason: "operator", userId: "user_1" });
    expect(await (await page(usher, "/users/user_1?disconnected=1")).text()).toContain("Agent disconnected");
  });

  it("a revoke token only works for the operator it was issued to", async () => {
    const { usher } = makeUsher({ console: { isOperator: (u) => u.id.startsWith("staff_"), events: memoryAuditSink() } });
    await authorizeAgent(usher);
    const html = await (await page(usher, "/users/user_1")).text();
    const action = html.match(/<form method="post" action="([^"]+)">/)![1]!;
    const token = html.match(/name="token" value="([^"]+)"/)![1]!;
    const res = await usher.handler(
      new Request(new URL(action, BASE), {
        method: "POST",
        headers: { cookie: "session=staff_2", origin: BASE, "content-type": "application/x-www-form-urlencoded" },
        body: `token=${encodeURIComponent(token)}`,
      }),
    );
    expect(res.status).toBe(400);
    expect(await usher.grants.list("user_1")).toHaveLength(1);
  });
});
