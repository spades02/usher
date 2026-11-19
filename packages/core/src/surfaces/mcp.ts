import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { GENERIC_TOOL_FAILURE, ToolError } from "../errors.js";
import type { AnyUsherTool, ToolEffect } from "../tool.js";

export interface McpSurfaceOptions {
  tools: readonly AnyUsherTool[];
  serverInfo: { name: string; version: string };
  /** Optional guidance for the agent on how to use this app's tools. */
  instructions?: string;
  /** Receives unexpected tool errors (never shown to the agent). */
  onError: (error: unknown, info: { tool: string }) => void;
}

/**
 * Projects Usher tools onto a remote MCP endpoint (Streamable HTTP).
 *
 * Serves both protocol eras from one stateless handler (ADR 0002):
 * 2026-07-28 per-request envelopes and 2025-era `initialize` traffic.
 * A fresh MCP server instance is built per request, so no state is held
 * between calls.
 */
export function createMcpSurface(options: McpSurfaceOptions) {
  const { tools, serverInfo, instructions, onError } = options;

  return createMcpHandler(
    ({ requestInfo }) => {
      const server = new McpServer(serverInfo, instructions ? { instructions } : undefined);

      for (const tool of tools) {
        server.registerTool(
          tool.name,
          {
            title: tool.title,
            description: tool.description,
            // The SDK validates input (and output, when declared) against these.
            inputSchema: tool.input,
            outputSchema: tool.output,
            annotations: toAnnotations(tool.effect, tool.idempotent),
          },
          async (args: unknown, ctx) => {
            if (!requestInfo) throw new Error("[usher] MCP call without an HTTP request");
            try {
              const result = await tool.handler(args, {
                request: requestInfo,
                signal: ctx.mcpReq.signal,
              });
              return toCallToolResult(result);
            } catch (error) {
              if (error instanceof ToolError) {
                const payload = { error: error.message, ...(error.code ? { code: error.code } : {}) };
                return {
                  isError: true,
                  content: [{ type: "text" as const, text: JSON.stringify(payload) }],
                };
              }
              onError(error, { tool: tool.name });
              return {
                isError: true,
                content: [{ type: "text" as const, text: GENERIC_TOOL_FAILURE }],
              };
            }
          },
        );
      }

      return server;
    },
    { legacy: "stateless" },
  );
}

/** Maps Usher's single `effect` field onto MCP's hint annotations. */
export function toAnnotations(effect: ToolEffect, idempotent?: boolean) {
  return {
    readOnlyHint: effect === "read",
    destructiveHint: effect === "destructive",
    // Reads are inherently idempotent; otherwise trust the developer's flag.
    idempotentHint: effect === "read" || idempotent === true,
    // Tools act on the app's own data, not on an open-ended external world.
    openWorldHint: false,
  };
}

function toCallToolResult(value: unknown) {
  // MCP 2025-era clients require structuredContent to be an object.
  const isObject = value !== null && typeof value === "object" && !Array.isArray(value);
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return {
    content: [{ type: "text" as const, text }],
    ...(isObject ? { structuredContent: value as Record<string, unknown> } : {}),
  };
}
