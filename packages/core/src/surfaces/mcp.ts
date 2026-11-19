import {
  CLIENT_CAPABILITIES_META_KEY,
  McpServer,
  createMcpHandler,
  inputRequired,
} from "@modelcontextprotocol/server";
import type { CallDecision, Principal } from "../auth/types.js";
import { GENERIC_TOOL_FAILURE, ToolError } from "../errors.js";
import type { AnyUsherTool, ToolEffect } from "../tool.js";

export interface McpSurfaceOptions {
  tools: readonly AnyUsherTool[];
  serverInfo: { name: string; version: string };
  /** Optional guidance for the agent on how to use this app's tools. */
  instructions?: string;
  /** Receives unexpected tool errors (never shown to the agent). */
  onError: (error: unknown, info: { tool: string }) => void;
  /** The permission layer (ADR 0005). Runs before every handler; only `allow` lets it run. */
  policy: (request: Request, principal: Principal, tool: AnyUsherTool, input: unknown) => Promise<CallDecision>;
}

/** Key of Usher's URL elicitation inside an MCP input-required round. */
const CONFIRM_KEY = "usher_confirm";

/**
 * Projects Usher tools onto a remote MCP endpoint (Streamable HTTP).
 *
 * Serves both protocol eras from one stateless handler (ADR 0002):
 * 2026-07-28 per-request envelopes and 2025-era `initialize` traffic.
 * A fresh MCP server instance is built per request, so no state is held
 * between calls. Callers must authenticate first (ADR 0004) and pass the
 * principal to `fetch`.
 */
export function createMcpSurface(options: McpSurfaceOptions) {
  const { tools, serverInfo, instructions, onError, policy } = options;

  const handler = createMcpHandler(
    ({ era, requestInfo, authInfo }) => {
      const server = new McpServer(serverInfo, instructions ? { instructions } : undefined);
      const principal = authInfo?.extra?.principal as Principal | undefined;

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
            // Defense in depth: the router never dispatches unauthenticated calls.
            if (!requestInfo || !principal) throw new Error("[usher] Unauthenticated tool call");
            try {
              const decision = await policy(requestInfo, principal, tool, args);
              if (decision.kind !== "allow") {
                const envelope = ctx.mcpReq.envelope as Record<string, any> | undefined;
                const supportsUrlElicitation =
                  era === "modern" && envelope?.[CLIENT_CAPABILITIES_META_KEY]?.elicitation?.url !== undefined;
                const retried = ctx.mcpReq.inputResponses?.[CONFIRM_KEY] !== undefined;
                return blocked(decision, supportsUrlElicitation && !retried);
              }
              const result = await tool.handler(args, {
                user: principal.user,
                agent: principal.agent,
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

  return {
    fetch: (request: Request, principal: Principal, token: string) =>
      handler.fetch(request, {
        authInfo: { token, clientId: principal.agent.clientId, scopes: principal.scopes, extra: { principal } },
      }),
  };
}

/**
 * Turns a non-allow decision into what the agent sees.
 *
 * Confirmation is out-of-band: the customer approves on the app's own site,
 * never inside the agent. Clients that declare URL elicitation (2026-07-28)
 * get a native "open this link" prompt and retry by themselves. Everyone else
 * gets a tool error with the link, which the model relays to the customer.
 */
function blocked(decision: Exclude<CallDecision, { kind: "allow" }>, useElicitation: boolean) {
  const error = (payload: Record<string, string>) => ({
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  });
  switch (decision.kind) {
    case "forbidden":
      return error({ error: "The customer hasn't allowed this agent to use this tool.", code: "insufficient_scope", scope: decision.scope });
    case "declined":
      return error({ error: "The customer declined this action. Don't retry unless they ask again.", code: "confirmation_declined" });
    case "confirm":
      if (useElicitation) {
        return inputRequired({
          inputRequests: {
            [CONFIRM_KEY]: inputRequired.elicitUrl({
              message: `Approve on the app's site: ${decision.summary}`,
              url: decision.url,
            }),
          },
        });
      }
      return error({
        error: `This action needs the customer's approval. Ask them to open ${decision.url} and approve it, then call this tool again with exactly the same arguments.`,
        code: "confirmation_required",
        confirm_url: decision.url,
      });
  }
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
