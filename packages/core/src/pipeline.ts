import { canonicalJson, sha256 } from "./auth/crypto.js";
import type { Principal } from "./auth/types.js";
import { ToolError } from "./errors.js";
import type { CallInfo, CallOutcome, PluginDenial, UsherEvent, UsherPlugin } from "./plugins/types.js";
import { toolScope, type AnyUsherTool } from "./tool.js";

/** The confirmation gate's verdict (ADR 0005). */
export type ConfirmationVerdict =
  | { kind: "allow" }
  | { kind: "confirm"; url: string; summary: string }
  | { kind: "declined" };

/**
 * How one tool call ended, independent of any protocol. Each surface (MCP
 * today, WebMCP later) maps this onto its own wire format.
 */
export type CallResult =
  | { kind: "ok"; value: unknown }
  /** A ToolError: safe to show to the agent. */
  | { kind: "tool_error"; message: string; code?: string }
  /** An unexpected crash, already reported to onError. Show a generic message. */
  | { kind: "failed" }
  | { kind: "forbidden"; scope: string }
  | { kind: "confirm"; url: string; summary: string }
  | { kind: "declined" }
  | ({ kind: "denied" } & PluginDenial);

export type ErrorReporter = (error: unknown, info: { tool?: string; plugin?: string }) => void;

export interface PipelineOptions {
  plugins: readonly UsherPlugin[];
  confirmationGate: (request: Request, principal: Principal, tool: AnyUsherTool, input: unknown) => Promise<ConfirmationVerdict>;
  onError: ErrorReporter;
}

/** Shown when a plugin crashes in beforeCall. The call is denied: security hooks fail closed. */
const PLUGIN_FAILURE: PluginDenial = {
  code: "unavailable",
  message: "This action is temporarily unavailable. Try again later.",
};

/**
 * The single path every tool call takes, whatever the protocol (ADR 0006):
 *
 *   scope check → plugins' beforeCall → confirmation → handler → events
 *
 * Usher's own checks bracket the plugins, so plugins can only add
 * restrictions.
 */
export function createCallPipeline(options: PipelineOptions) {
  const { plugins, confirmationGate, onError } = options;
  const observers = plugins.filter((p) => p.onEvent);
  const guards = plugins.filter((p) => p.beforeCall);

  /** Delivers an event to every plugin, isolating failures. */
  async function emit(event: UsherEvent): Promise<void> {
    for (const plugin of observers) {
      try {
        await plugin.onEvent!(event);
      } catch (error) {
        onError(error, { plugin: plugin.id });
      }
    }
  }

  async function execute(
    request: Request,
    principal: Principal,
    tool: AnyUsherTool,
    input: unknown,
    signal: AbortSignal,
  ): Promise<CallResult> {
    // 1. Permission (ADR 0005). Also checked before dispatch; this is defense in depth.
    const scope = toolScope(tool.name);
    if (!principal.scopes.includes(scope)) return { kind: "forbidden", scope };

    // 2. Plugins may veto. First denial wins; a crash denies.
    const info: CallInfo = {
      tool: { name: tool.name, effect: tool.effect },
      user: principal.user,
      agent: principal.agent,
      grantId: principal.grantId,
      input,
      request,
    };
    for (const plugin of guards) {
      let denial: PluginDenial | void;
      try {
        denial = await plugin.beforeCall!(info);
      } catch (error) {
        onError(error, { tool: tool.name, plugin: plugin.id });
        return { kind: "denied", ...PLUGIN_FAILURE };
      }
      if (denial) return { kind: "denied", ...denial };
    }

    // 3. Customer approval for this exact call, when the tool requires it.
    const verdict = await confirmationGate(request, principal, tool, input);
    if (verdict.kind !== "allow") return verdict;

    // 4. The handler. Only ToolError messages reach the agent.
    try {
      const value = await tool.handler(input, { user: principal.user, agent: principal.agent, request, signal });
      return { kind: "ok", value };
    } catch (error) {
      if (error instanceof ToolError) return { kind: "tool_error", message: error.message, code: error.code };
      onError(error, { tool: tool.name });
      return { kind: "failed" };
    }
  }

  async function recordCall(principal: Principal, tool: AnyUsherTool, input: unknown, result: CallResult, startedAt: number) {
    await emit({
      type: "call",
      at: startedAt,
      userId: principal.user.id,
      agent: principal.agent,
      grantId: principal.grantId,
      tool: tool.name,
      effect: tool.effect,
      outcome: OUTCOME[result.kind],
      ...("code" in result && result.code ? { code: result.code } : {}),
      durationMs: Date.now() - startedAt,
      inputHash: await sha256(canonicalJson(input)),
    });
  }

  return {
    emit,
    /** Runs one call through the full pipeline and records it. */
    async run(request: Request, principal: Principal, tool: AnyUsherTool, input: unknown, signal: AbortSignal) {
      const startedAt = Date.now();
      let result: CallResult;
      try {
        result = await execute(request, principal, tool, input, signal);
      } catch (error) {
        // A failure in Usher's own gates (e.g. the store is down): fail closed.
        onError(error, { tool: tool.name });
        result = { kind: "failed" };
      }
      await recordCall(principal, tool, input, result, startedAt);
      return result;
    },
    /** Records a call rejected before dispatch (the HTTP 403 step-up path). */
    recordForbidden: (principal: Principal, tool: AnyUsherTool, input: unknown) =>
      recordCall(principal, tool, input, { kind: "forbidden", scope: toolScope(tool.name) }, Date.now()),
  };
}

const OUTCOME: Record<CallResult["kind"], CallOutcome> = {
  ok: "success",
  tool_error: "tool_error",
  failed: "failed",
  forbidden: "forbidden",
  confirm: "confirmation_required",
  declined: "declined",
  denied: "denied",
};
