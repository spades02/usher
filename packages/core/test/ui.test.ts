import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { auditLog, createUsher, defineTool, memoryAuditSink, memoryStore, type Usher, type UsherOptions } from "../src/index.js";
import { ELEMENTS_SCRIPT, installUsherElements } from "../src/ui/elements.js";
import { authOptions, authorizeAgent, BASE, callTool, MemoryProvider, MCP_URL, fetchVia } from "./helpers.js";
import { auth } from "@modelcontextprotocol/client";

function makeUsher(overrides: Partial<UsherOptions> = {}) {
  const store = memoryStore();
  const sink = memoryAuditSink();
  const usher = createUsher({
    ...authOptions,
    app: { name: "Example Shop", version: "1.0.0" },
    baseUrl: BASE,
    store,
    plugins: [auditLog({ sink })],
    account: { activity: sink },
    tools: [
      defineTool({ name: "list_orders", title: "List orders", description: "See your orders.", input: z.object({}), effect: "read", handler: () => ({ orders: [] }) }),
      defineTool({
        name: "cancel_order",
        title: "Cancel order",
        description: "Cancel an order.",
        input: z.object({ orderId: z.string() }),
        effect: "destructive",
        handler: ({ orderId }) => ({ cancelled: orderId }),
      }),
    ],
    ...overrides,
  });
  return { usher, store, sink };
}

/** The customer's browser on the app's own settings page. */
function account(usher: Usher, path: string, init: { method?: string; body?: unknown; user?: string | null; origin?: string | null; header?: boolean } = {}) {
  const { method = "GET", body, user = "user_1", origin = BASE, header = true } = init;
  const headers = new Headers({ referer: `${BASE}/settings` });
  if (user) headers.set("cookie", `session=${user}`);
  if (header) headers.set("x-usher-request", "1");
  if (origin && method !== "GET") headers.set("origin", origin);
  if (body !== undefined) headers.set("content-type", "application/json");
  return usher.handler(new Request(`${BASE}/api/usher/account/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
}

// ------------------------------------------------------------ customer API

describe("customer account API", () => {
  it("info is public: what the Connect widget needs", async () => {
    const { usher } = makeUsher();
    const res = await account(usher, "info", { user: null, header: false });
    expect(await res.json()).toMatchObject({
      app: { name: "Example Shop" },
      mcpUrl: MCP_URL,
      tools: [
        { name: "list_orders", scope: "tool:list_orders", effect: "read", asksFirst: false },
        { name: "cancel_order", scope: "tool:cancel_order", effect: "destructive", asksFirst: true },
      ],
    });
  });

  it("lists, edits and disconnects the signed-in customer's agents", async () => {
    const { usher } = makeUsher();
    const { accessToken } = await authorizeAgent(usher);
    const { agents } = await (await account(usher, "agents")).json();
    expect(agents).toEqual([
      {
        id: expect.any(String),
        name: "Test Agent",
        clientId: "https://agent.example/oauth/client.json",
        verified: true,
        domain: "agent.example",
        connectedAt: expect.any(Number),
        scopes: ["tool:list_orders", "tool:cancel_order"],
      },
    ]);
    expect(Math.abs(agents[0].connectedAt - Date.now())).toBeLessThan(60_000); // milliseconds

    const put = await account(usher, `agents/${agents[0].id}`, { method: "PUT", body: { scopes: ["tool:cancel_order"] } });
    expect((await put.json()).agent.scopes).toEqual(["tool:cancel_order"]);
    // Takes effect on the agent's next call: list_orders now needs step-up.
    expect((await callTool(usher, accessToken, "list_orders", {})).status).toBe(403);

    expect((await account(usher, `agents/${agents[0].id}`, { method: "DELETE" })).status).toBe(204);
    expect((await callTool(usher, accessToken, "list_orders", {})).status).toBe(401);
    expect((await (await account(usher, "agents")).json()).agents).toEqual([]);
  });

  it("is protected against cross-site use and other customers", async () => {
    const { usher } = makeUsher();
    await authorizeAgent(usher);
    const [{ id }] = (await (await account(usher, "agents")).json()).agents;
    const scopes = { scopes: [] };

    // No custom header: a plain cross-site form or <img> can't call it.
    expect((await account(usher, "agents", { header: false })).status).toBe(403);
    expect((await account(usher, `agents/${id}`, { method: "DELETE", header: false })).status).toBe(403);
    // Changes need the app's own Origin.
    expect((await account(usher, `agents/${id}`, { method: "PUT", body: scopes, origin: null })).status).toBe(403);
    expect((await account(usher, `agents/${id}`, { method: "DELETE", origin: "https://evil.example" })).status).toBe(403);
    // No CORS: browsers refuse to send the custom header cross-site.
    const preflight = await usher.handler(
      new Request(`${BASE}/api/usher/account/agents`, { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-headers": "x-usher-request" } }),
    );
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    expect((await account(usher, "agents")).headers.get("access-control-allow-origin")).toBeNull();

    // Another customer can't see or touch it.
    expect((await (await account(usher, "agents", { user: "user_2" })).json()).agents).toEqual([]);
    expect((await account(usher, `agents/${id}`, { method: "DELETE", user: "user_2" })).status).toBe(404);
    expect((await account(usher, `agents/${id}`, { method: "PUT", body: scopes, user: "user_2" })).status).toBe(404);
    expect((await (await account(usher, "agents")).json()).agents[0].scopes).toHaveLength(2);

    // Unknown scopes and bad bodies are rejected.
    expect((await account(usher, `agents/${id}`, { method: "PUT", body: { scopes: ["admin"] } })).status).toBe(400);
    expect((await account(usher, `agents/${id}`, { method: "PUT", body: { scopes: "tool:list_orders" } })).status).toBe(400);
  });

  it("signed-out customers get a login URL that returns to the page they were on", async () => {
    const { usher } = makeUsher();
    const res = await account(usher, "agents", { user: null });
    expect(res.status).toBe(401);
    const { login_url } = await res.json();
    expect(new URL(login_url).searchParams.get("returnTo")).toBe(`${BASE}/settings`);
  });

  it("activity shows what agents did, without inputs or ids the customer doesn't need", async () => {
    const { usher } = makeUsher();
    const { accessToken } = await authorizeAgent(usher);
    await callTool(usher, accessToken, "list_orders", {});
    const [{ id }] = (await (await account(usher, "agents")).json()).agents;
    const { events } = await (await account(usher, `activity?agent=${id}`)).json();
    expect(events.map((e: { type: string }) => e.type)).toEqual(["call", "grant.created"]);
    expect(events[0]).toMatchObject({ tool: "list_orders", outcome: "success", agent: { name: "Test Agent" } });
    expect(events[0]).not.toHaveProperty("inputHash");
    expect(events[0]).not.toHaveProperty("userId");

    const { usher: quiet } = makeUsher({ account: undefined });
    expect((await account(quiet, "activity")).status).toBe(404);
    expect((await (await account(quiet, "agents")).json()).activity).toBe(false);
  });
});

// ------------------------------------------------------------------ theming

describe("theme", () => {
  async function consentPage(usher: Usher) {
    const provider = new MemoryProvider("cimd");
    await auth(provider, { serverUrl: MCP_URL, fetchFn: fetchVia(usher) });
    return usher.handler(new Request(provider.authorizationUrl!, { headers: { cookie: "session=user_1" } }));
  }

  it("brands the consent page, links to the settings page, and allows only the logo's origin", async () => {
    const { usher } = makeUsher({
      theme: {
        accentColor: "#4f46e5",
        logoUrl: "https://cdn.shop.example/logo.svg",
        fontFamily: `"Inter", system-ui, sans-serif`,
        radius: 12,
        colorScheme: "light",
        links: { accountSettings: "/settings/agents", privacy: "https://shop.example/privacy" },
      },
    });
    const res = await consentPage(usher);
    const html = await res.text();
    expect(html).toContain(`<img class="logo" src="https://cdn.shop.example/logo.svg" alt="Example Shop">`);
    expect(html).toContain("--accent:#4f46e5");
    expect(html).toContain("--radius:12px");
    expect(html).toContain("color-scheme: light");
    expect(html).toContain(`from <a href="/settings/agents">Connected agents</a>`);
    expect(html).toContain(`<a href="https://shop.example/privacy">Privacy</a>`);
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; img-src https://cdn.shop.example; frame-ancestors 'none'",
    );
  });

  it("defaults stay unbranded, with no image sources allowed", async () => {
    const res = await consentPage(makeUsher().usher);
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
    expect(await res.text()).toContain("from your account settings");
  });

  it.each([
    [{ accentColor: "red;} body{display:none" }, /accentColor/],
    [{ logoUrl: "javascript:alert(1)" }, /logoUrl/],
    [{ logoUrl: "http://cdn.example/logo.png" }, /https/],
    [{ logoUrl: "//evil.example/logo.png" }, /logoUrl/],
    [{ fontFamily: "x</style><script>alert(1)</script>" }, /fontFamily/],
    [{ radius: 400 }, /radius/],
    [{ links: { support: "data:text/html,hi" } }, /links\.support/],
  ])("rejects unsafe values at startup: %o", (theme, message) => {
    expect(() => makeUsher({ theme: theme as never })).toThrow(message);
  });
});

// ---------------------------------------------------------- custom elements

/** A browser window on the app's settings page, signed in as `user` (or not). */
function browser(usher: Usher, user: string | null = "user_1") {
  const win = new Window({ url: `${BASE}/settings` });
  const writes: string[] = [];
  Object.defineProperty(win.navigator, "clipboard", { value: { writeText: async (t: string) => void writes.push(t) } });
  (win as unknown as { fetch: unknown }).fetch = async (input: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (user) headers.set("cookie", `session=${user}`);
    headers.set("referer", `${BASE}/settings`);
    if (init.method && init.method !== "GET") headers.set("origin", BASE); // Same-origin fetches send it.
    return usher.handler(new Request(new URL(input, BASE), { method: init.method, headers, body: init.body as BodyInit | undefined }));
  };
  return { win, writes, doc: win.document as unknown as Document };
}

/** Visible text of a shadow root (its <style> excluded). */
const text = (root: ShadowRoot) =>
  Array.from(root.children)
    .filter((c) => c.tagName !== "STYLE")
    .map((c) => c.textContent)
    .join(" ");

async function mount(win: Window, html: string): Promise<ShadowRoot> {
  const doc = win.document as unknown as Document;
  doc.body.innerHTML = html;
  const root = doc.body.firstElementChild!.shadowRoot!;
  await expect.poll(() => text(root) ?? "").not.toMatch(/^Loading|^\s*$/);
  return root;
}

const click = async (el: Element) => {
  (el as HTMLElement).click();
  await new Promise((r) => setTimeout(r, 20));
};

describe("custom elements", () => {
  it("are served as a classic script any backend can include", async () => {
    const { usher } = makeUsher();
    const res = await usher.handler(new Request(`${BASE}/api/usher/elements.js`));
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    const script = await res.text();
    expect(script).toBe(ELEMENTS_SCRIPT);

    const { win } = browser(usher);
    new Function("window", script)(win); // Runs exactly what <script src> would.
    expect(win.customElements.get("usher-agents")).toBeDefined();
    expect(win.customElements.get("usher-connect")).toBeDefined();
    installUsherElements(win); // Installing twice is a no-op.
  });

  it("<usher-agents> shows connected agents, edits permissions and disconnects", async () => {
    const { usher } = makeUsher();
    const { accessToken } = await authorizeAgent(usher);
    const { win } = browser(usher);
    installUsherElements(win);
    const root = await mount(win, "<usher-agents></usher-agents>");

    expect(root.querySelector("h3")!.textContent).toBe("Test Agent");
    expect(text(root)).toContain("Verified · agent.example");
    expect(text(root)).toContain("Irreversible · asks you first");
    const boxes = Array.from(root.querySelectorAll<HTMLInputElement>("input[type=checkbox]"));
    expect(boxes.map((b) => [b.value, b.checked])).toEqual([
      ["tool:list_orders", true],
      ["tool:cancel_order", true],
    ]);

    const changes: unknown[] = [];
    win.document.addEventListener("usher-change", (e) => changes.push((e as unknown as CustomEvent).detail));
    boxes[1]!.checked = false;
    boxes[1]!.dispatchEvent(new win.Event("change") as unknown as Event);
    await expect.poll(() => root.querySelector(".status")!.textContent).toContain("Saved");
    const [grant] = await usher.grants.list("user_1");
    expect(grant!.scopes).toEqual(["tool:list_orders"]);
    expect(changes).toHaveLength(1);

    // Activity, on demand.
    const activityButton = Array.from(root.querySelectorAll("button")).find((b) => b.textContent === "Recent activity")!;
    await click(activityButton);
    await expect.poll(() => root.querySelector("[part=activity]")!.textContent).toContain("permissions changed");

    // Disconnecting takes two clicks, and cancelling disarms it.
    const disconnect = root.querySelector("[part=disconnect]")!;
    await click(disconnect);
    expect(disconnect.textContent).toBe("Yes, disconnect Test Agent");
    expect(await usher.grants.list("user_1")).toHaveLength(1);
    await click(disconnect);
    await expect.poll(() => text(root)).toContain("No AI agents are connected");
    expect(root.querySelector(".status")!.textContent).toContain("Test Agent was disconnected");
    expect((await callTool(usher, accessToken, "list_orders", {})).status).toBe(401);
  });

  it("<usher-agents> puts a checkbox back when saving fails", async () => {
    const { usher } = makeUsher();
    await authorizeAgent(usher);
    const { win } = browser(usher);
    installUsherElements(win);
    const root = await mount(win, "<usher-agents></usher-agents>");
    const [grant] = await usher.grants.list("user_1");
    await usher.grants.revoke("user_1", grant!.id); // Disconnected in another tab.

    const box = root.querySelector<HTMLInputElement>("input[value='tool:list_orders']")!;
    box.checked = false;
    box.dispatchEvent(new win.Event("change") as unknown as Event);
    await expect.poll(() => root.querySelector(".status")!.textContent).toContain("Couldn't save");
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(false);
  });

  it("<usher-agents> renders agent-chosen names as text, never HTML", async () => {
    const { usher, store } = makeUsher();
    const name = `<img src=x onerror="window.pwned=1">Evil`;
    await store.saveGrant({ id: "g_x", userId: "user_1", clientId: "c_x", clientName: name, clientSource: "dcr", scopes: [], createdAt: 1_800_000_000 });
    const { win } = browser(usher);
    installUsherElements(win);
    const root = await mount(win, "<usher-agents></usher-agents>");
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("h3")!.textContent).toBe(name);
    expect(text(root)).toContain("Unverified");
    expect((win as unknown as { pwned?: number }).pwned).toBeUndefined();
  });

  it("<usher-agents> asks signed-out customers to sign in", async () => {
    const { usher } = makeUsher();
    const { win } = browser(usher, null);
    installUsherElements(win);
    const root = await mount(win, "<usher-agents></usher-agents>");
    const link = root.querySelector("a")!;
    expect(link.textContent).toBe("Sign in");
    expect(new URL(link.getAttribute("href")!).searchParams.get("returnTo")).toBe(`${BASE}/settings`);
  });

  it("<usher-connect> shows the connection URL, copies it, and has per-assistant steps", async () => {
    const { usher } = makeUsher();
    const { win, writes } = browser(usher, null); // Works on public pages too.
    installUsherElements(win);
    const root = await mount(win, `<usher-connect agents="claude,cursor"></usher-connect>`);

    expect(root.querySelector<HTMLInputElement>("input")!.value).toBe(MCP_URL);
    await click(root.querySelector("[part=copy]")!);
    expect(writes).toEqual([MCP_URL]);
    expect(text(root)).toContain("Copied.");

    const tabs = Array.from(root.querySelectorAll("[role=tab]"));
    expect(tabs.map((t) => t.textContent)).toEqual(["Claude", "Cursor"]);
    expect(text(root)).toContain("Add custom connector");
    await click(tabs[1]!);
    const install = root.querySelector("[part=install]")!;
    const href = new URL(install.getAttribute("href")!);
    expect(href.protocol).toBe("cursor:");
    expect(JSON.parse(atob(href.searchParams.get("config")!))).toEqual({ url: MCP_URL });
    expect(text(root)).toContain("Sign in to Example Shop when Cursor asks.");
  });

  it("follow base-path for apps that mount Usher elsewhere", async () => {
    const { usher } = makeUsher({ basePath: "/agents" });
    const { win } = browser(usher, null);
    installUsherElements(win);
    const root = await mount(win, `<usher-connect base-path="/agents/"></usher-connect>`);
    expect(root.querySelector<HTMLInputElement>("input")!.value).toBe(`${BASE}/agents/mcp`);
  });
});

