/**
 * The docs' code samples are real files (snippets/), type-checked in CI and
 * exercised here (ADR 0011). If an API change breaks the quickstart, the
 * docs build fails instead of a reader's first hour.
 */
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { checkDeployment, postgresExecutor, webhookTool } from "usherjs";
import { resolveEnv, standaloneConfigSchema } from "usherjs/standalone";
import { afterEach, describe, expect, it, vi } from "vitest";
// The core package's test helpers play the agent (official MCP SDK client) and the customer's browser.
import { BASE, callTool, connectAgent, decideInBrowser, errorPayload, fetchVia, readRpc } from "../../../packages/core/test/helpers.js";

vi.mock("../snippets/db.js", () => ({ db: postgresExecutor(new PGlite()) }));
vi.mock("../snippets/session.js", async (original) => ({
  ...(await original<typeof import("../snippets/session.js")>()),
  // The fake app login: a `session=<user id>` cookie.
  getSession: async (headers: Headers) => {
    const id = headers.get("cookie")?.match(/session=([^;]+)/)?.[1];
    return id ? { user: { id, name: `User ${id}`, email: `${id}@example.com` } } : null;
  },
}));
vi.stubEnv("USHER_SECRET", "docs-test-secret-0123456789-abcdefghij");

afterEach(() => {
  vi.useRealTimers();
});

describe("getting started (snippets/usher.ts)", () => {
  it("deploys cleanly, connects an agent, and puts destructive calls behind approval", async () => {
    const { usher } = await import("../snippets/usher.js");
    expect(await checkDeployment(BASE, { fetch: fetchVia(usher) })).toMatchObject({ ok: true });

    // DCR: the stand-in agent has no real metadata document on the internet.
    const agent = await connectAgent(usher, { mode: "dcr" });
    const listed = await agent.callTool({ name: "list_orders", arguments: {} });
    expect(listed.structuredContent).toEqual({ orders: [] });

    const accessToken = (agent.provider.tokens() as { access_token: string }).access_token;
    const pending = errorPayload(await readRpc(await callTool(usher, accessToken, "cancel_order", { orderId: "o_1" })));
    expect(pending.code).toBe("confirmation_required");
    const { html } = await decideInBrowser(usher, pending.confirm_url);
    expect(html).toContain("Cancel order o_1");
    // The stand-in data layer has no orders, so the approved call reaches the handler and gets a ToolError.
    expect(errorPayload(await readRpc(await callTool(usher, accessToken, "cancel_order", { orderId: "o_1" })))).toEqual({
      error: "No such order.",
      code: "not_found",
    });
  }, 30_000);
});

describe("standalone config (snippets/usher.config.json)", () => {
  it("is a valid config once env: values are filled in", async () => {
    const raw = JSON.parse(await readFile(new URL("../snippets/usher.config.json", import.meta.url), "utf8"));
    const env = {
      USHER_SECRET: "x".repeat(32),
      DATABASE_URL: "postgres://localhost/app",
      USHER_WEBHOOK_SECRET: "y".repeat(32),
      USHER_ADMIN_TOKEN: "z".repeat(32),
    };
    expect(() => standaloneConfigSchema.parse(resolveEnv(raw, env))).not.toThrow();
  });
});

describe("webhook verification in other languages (snippets/verify_webhook.*)", () => {
  /** A real webhook as Usher sends it: body and Usher-Signature header captured from webhookTool. */
  async function realWebhook(secret: string) {
    let sent: { body: string; signature: string } | undefined;
    const tool = webhookTool({
      name: "cancel_order",
      description: "Cancel.",
      effect: "destructive",
      input: {
        "~standard": {
          version: 1,
          vendor: "x",
          validate: (v: unknown) => ({ value: v }),
          jsonSchema: { input: () => ({}), output: () => ({}) },
        },
      },
      url: "https://app.example/hook",
      secret,
      fetch: async (_url, init) => {
        sent = { body: String(init.body), signature: new Headers(init.headers).get("usher-signature")! };
        return Response.json({ ok: true });
      },
    });
    await tool.handler(
      { orderId: "o_1" },
      {
        user: { id: "u" },
        agent: { clientId: "c", name: "A", verified: true },
        request: new Request(BASE),
        signal: new AbortController().signal,
      },
    );
    return sent!;
  }
  const secret = "w".repeat(40);
  const has = (cmd: string) => spawnSync(cmd, ["--version"]).status === 0;
  const python = ["python3", "python"].find(has);

  const run = (cmd: string, args: string[], input: object) => {
    const out = spawnSync(cmd, args, { input: JSON.stringify(input), encoding: "utf8" });
    if (out.status !== 0) throw new Error(out.stderr);
    return out.stdout.trim();
  };

  it.skipIf(!python)("Python", async () => {
    const hook = await realWebhook(secret);
    const file = fileURLToPath(new URL("../snippets/verify_webhook.py", import.meta.url));
    const script = `import json, runpy, sys
v = runpy.run_path(sys.argv[1])["verify_usher_webhook"]
d = json.load(sys.stdin)
print(json.dumps([v(d["s"], d["b"].encode(), d["h"]), v(d["s"], (d["b"] + " ").encode(), d["h"]), v("other" * 8, d["b"].encode(), d["h"]), v(d["s"], d["b"].encode(), None)]))`;
    expect(JSON.parse(run(python!, ["-I", "-c", script, file], { s: secret, b: hook.body, h: hook.signature }))).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });

  it.skipIf(!has("ruby"))("Ruby", async () => {
    const hook = await realWebhook(secret);
    const file = fileURLToPath(new URL("../snippets/verify_webhook.rb", import.meta.url));
    const script = `require "json"; load ARGV[0]; d = JSON.parse(STDIN.read)
puts JSON.dump([verify_usher_webhook(d["s"], d["b"], d["h"]), verify_usher_webhook(d["s"], d["b"] + " ", d["h"]), verify_usher_webhook("other" * 8, d["b"], d["h"]), verify_usher_webhook(d["s"], d["b"], nil)])`;
    expect(JSON.parse(run("ruby", ["-e", script, file], { s: secret, b: hook.body, h: hook.signature }))).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });
});

describe("plugin example (snippets/plugin.ts)", () => {
  it("blocks destructive tools outside office hours only", async () => {
    const { officeHours } = await import("../snippets/plugin.js");
    const call = (effect: "read" | "destructive") =>
      officeHours.beforeCall!({
        tool: { name: "cancel_order", effect },
        input: {},
        user: { id: "u" },
        agent: { clientId: "c", name: "A", verified: true },
        grantId: "g",
        request: new Request(BASE),
      } as never);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-20T03:00:00Z"));
    expect(await call("destructive")).toMatchObject({ code: "outside_hours" });
    expect(await call("read")).toBeUndefined();
    vi.setSystemTime(new Date("2026-11-20T12:00:00Z"));
    expect(await call("destructive")).toBeUndefined();
  });
});
