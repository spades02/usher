import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createUsher, defineTool } from "../src/index.js";

const BASE = "https://shop.example";
const MCP_URL = `${BASE}/api/usher/mcp`;

const orders = [
  { id: "o_1", item: "Running shoes", status: "shipped" },
  { id: "o_2", item: "Yoga mat", status: "processing" },
];

const usher = createUsher({
  app: { name: "Example Shop", version: "1.0.0" },
  instructions: "Use these tools to help the customer with their orders.",
  allowedOrigins: ["https://partner.example"],
  tools: [
    defineTool({
      name: "list_orders",
      description: "List the customer's orders.",
      input: z.object({ status: z.enum(["shipped", "processing"]).optional() }),
      readOnly: true,
      handler: ({ status }) => ({
        orders: status ? orders.filter((o) => o.status === status) : orders,
      }),
    }),
    defineTool({
      name: "cancel_order",
      description: "Cancel an order that has not shipped yet.",
      input: z.object({ orderId: z.string() }),
      handler: ({ orderId }) => {
        const order = orders.find((o) => o.id === orderId);
        if (!order) throw new Error(`Order ${orderId} not found`);
        if (order.status === "shipped") throw new Error("Shipped orders cannot be cancelled");
        return { cancelled: orderId };
      },
    }),
  ],
});

/** Routes fetch() straight into the Usher handler — no network involved. */
const inProcessFetch = (input: RequestInfo | URL, init?: RequestInit) =>
  usher.handler(new Request(input, init));

/** Reads a JSON-RPC response whether the server answered with JSON or SSE. */
async function readRpc(res: Response): Promise<any> {
  const body = await res.text();
  if (!res.headers.get("content-type")?.includes("text/event-stream")) return JSON.parse(body);
  const messages = body
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)));
  return messages.find((m) => "result" in m || "error" in m);
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return usher.handler(
    new Request(MCP_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
}

describe("MCP surface — official SDK client", () => {
  it("lists and calls tools end to end", async () => {
    const client = new Client({ name: "test-agent", version: "0.0.1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(MCP_URL), { fetch: inProcessFetch }),
    );

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["list_orders", "cancel_order"]);
    expect(tools[0]?.annotations?.readOnlyHint).toBe(true);
    expect(tools[1]?.annotations?.readOnlyHint).toBe(false);

    const result = await client.callTool({ name: "list_orders", arguments: { status: "shipped" } });
    expect(result.structuredContent).toEqual({ orders: [orders[0]] });

    await client.close();
  });

  it("reports tool failures in-band with isError", async () => {
    const client = new Client({ name: "test-agent", version: "0.0.1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(MCP_URL), { fetch: inProcessFetch }),
    );
    const result = await client.callTool({ name: "cancel_order", arguments: { orderId: "o_1" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Shipped orders cannot be cancelled");
    await client.close();
  });
});

describe("MCP surface — 2025-era clients (initialize handshake)", () => {
  it("serves initialize and tools/list statelessly, without a session id", async () => {
    const init = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "legacy-agent", version: "1.0.0" },
      },
    });
    expect(init.status).toBe(200);
    expect(init.headers.get("mcp-session-id")).toBeNull();
    const initRpc = await readRpc(init);
    expect(initRpc.result.serverInfo.name).toBe("Example Shop");
    expect(initRpc.result.instructions).toContain("orders");

    const list = await post(
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { "mcp-protocol-version": "2025-06-18" },
    );
    const listRpc = await readRpc(list);
    expect(listRpc.result.tools).toHaveLength(2);
  });
});

describe("MCP surface — 2026-07-28 clients (stateless envelope)", () => {
  const meta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/clientInfo": { name: "modern-agent", version: "1.0.0" },
  };
  const modernHeaders = (method: string, name?: string) => ({
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": method,
    ...(name ? { "mcp-name": name } : {}),
  });

  it("answers server/discover", async () => {
    const res = await post(
      { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: meta } },
      modernHeaders("server/discover"),
    );
    const rpc = await readRpc(res);
    expect(rpc.result.supportedVersions).toContain("2026-07-28");
    expect(rpc.result.capabilities.tools).toBeDefined();
  });

  it("calls a tool with no prior handshake", async () => {
    const res = await post(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { _meta: meta, name: "list_orders", arguments: {} },
      },
      modernHeaders("tools/call", "list_orders"),
    );
    const rpc = await readRpc(res);
    expect(rpc.result.structuredContent.orders).toHaveLength(2);
  });

  it("rejects a header/body mismatch with 400", async () => {
    const res = await post(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { _meta: meta, name: "list_orders", arguments: {} },
      },
      modernHeaders("tools/call", "cancel_order"),
    );
    expect(res.status).toBe(400);
  });
});

describe("Usher routing and security", () => {
  it("rejects disallowed browser origins with 403", async () => {
    const res = await post(
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      { origin: "https://evil.example" },
    );
    expect(res.status).toBe(403);
  });

  it("allows the app's own origin and allowlisted origins", async () => {
    for (const origin of [BASE, "https://partner.example"]) {
      const res = await post(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } },
        },
        { origin },
      );
      expect(res.status).toBe(200);
    }
  });

  it("returns 404 outside the mount path", async () => {
    const res = await usher.handler(new Request(`${BASE}/api/usher/nope`));
    expect(res.status).toBe(404);
  });

  it("refuses duplicate tool names at startup", () => {
    const tool = defineTool({
      name: "dup",
      description: "x",
      input: z.object({}),
      handler: () => null,
    });
    expect(() => createUsher({ app: { name: "x", version: "1" }, tools: [tool, tool] })).toThrow(
      /Duplicate tool name/,
    );
  });
});
