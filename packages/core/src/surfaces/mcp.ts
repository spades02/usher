import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import type { UsherTool } from "../tool.js";

export interface McpSurfaceOptions {
  tools: readonly UsherTool[];
  serverInfo: { name: string; version: string };
  /** Optional guidance for the agent on how to use this app's tools. */
  instructions?: string;
}

/**
 * Projects Usher tools onto a remote MCP endpoint (Streamable HTTP).
 *
 * Serves both protocol eras from one stateless handler:
 * - 2026-07-28 (modern): per-request envelope, no handshake, no sessions.
 * - 2025-era (legacy): `initialize` handshake served statelessly, which is
 *   what most deployed agent clients still speak.
 *
 * A fresh MCP server instance is built per request, so no state is held
 * between calls and the handler scales horizontally / runs on edge runtimes.
 */
export function createMcpSurface(options: McpSurfaceOptions) {
  const { tools, serverInfo, instructions } = options;

  const handler = createMcpHandler(
    ({ requestInfo }) => {
      const server = new McpServer(serverInfo, instructions ? { instructions } : undefined);

      for (const tool of tools) {
        server.registerTool(
          tool.name,
          {
            title: tool.title,
            description: tool.description,
            inputSchema: tool.input,
            annotations: { readOnlyHint: tool.readOnly ?? false },
          },
          async (args) => {
            if (!requestInfo) throw new Error("[usher] MCP call without an HTTP request");
            try {
              const result = await tool.handler(args, { request: requestInfo });
              return toCallToolResult(result);
            } catch (error) {
              // Tool failures are reported in-band so the agent can recover.
              // Only the message is exposed; stacks never leave the server.
              const message = error instanceof Error ? error.message : "Tool failed";
              return { isError: true, content: [{ type: "text", text: message }] };
            }
          },
        );
      }

      return server;
    },
    { legacy: "stateless" },
  );

  return handler;
}

function toCallToolResult(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  const structured =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? { structuredContent: value as Record<string, unknown> }
      : {};
  return { content: [{ type: "text" as const, text }], ...structured };
}
