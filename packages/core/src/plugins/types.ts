import type { ToolEffect } from "../tool.js";

/** The agent behind a call or grant. `verified` means its identity is proven by an HTTPS domain (CIMD). */
export interface AgentInfo {
  clientId: string;
  name: string;
  verified: boolean;
}

/** What a plugin sees about a tool call, before it runs. */
export interface CallInfo {
  tool: { name: string; effect: ToolEffect };
  user: { id: string };
  agent: AgentInfo;
  /** The customer + agent connection this call runs under. */
  grantId: string;
  /** Validated input. Treat it as the customer's data: don't log it by default. */
  input: unknown;
  request: Request;
}

/** Returned from `beforeCall` to stop a call. The agent sees `message` and `code`. */
export interface PluginDenial {
  /** Machine-readable reason, e.g. `rate_limited`. */
  code: string;
  /** Shown to the agent, so it can explain what happened. Never include secrets. */
  message: string;
  /** When the agent may try again. */
  retryAfterSeconds?: number;
}

/** How a tool call ended. */
export type CallOutcome =
  | "success"
  /** The handler threw a ToolError the agent can see. */
  | "tool_error"
  /** The handler crashed. The agent only saw a generic message. */
  | "failed"
  /** The customer hasn't granted this tool. */
  | "forbidden"
  /** Parked until the customer approves it on the app's site. */
  | "confirmation_required"
  /** The customer looked at it and said no. */
  | "declined"
  /** A plugin stopped it (rate limit, kill switch...). */
  | "denied";

interface EventBase {
  /** Milliseconds since the epoch. */
  at: number;
  userId: string;
  agent: AgentInfo;
  grantId: string;
}

/**
 * Everything worth recording, as plain data. Inputs and results are never
 * included: `inputHash` lets you correlate identical calls without storing
 * the customer's data.
 */
export type UsherEvent =
  | (EventBase & {
      type: "call";
      tool: string;
      effect: ToolEffect;
      outcome: CallOutcome;
      /** The ToolError or denial code, when there is one. */
      code?: string;
      durationMs: number;
      inputHash: string;
    })
  | (EventBase & { type: "grant.created"; scopes: string[] })
  | (EventBase & { type: "grant.updated"; scopes: string[] })
  | (EventBase & {
      type: "grant.revoked";
      /** `customer`: disconnected in the app. `agent`: the agent revoked its token. `token_replay`: a stolen token was detected. */
      reason: "customer" | "agent" | "token_replay";
    })
  | (EventBase & { type: "confirmation.decided"; tool: string; summary: string; approved: boolean });

/**
 * Extends Usher at fixed points of the call pipeline (ADR 0006):
 *
 *   authenticate → scope check → **beforeCall** → confirmation → handler → **onEvent**
 *
 * Plugins can only *add* restrictions. Usher's own checks run first, so a
 * plugin can never let through a call that the customer didn't allow.
 */
export interface UsherPlugin {
  /** Unique, stable name, e.g. `rate-limit`. Used in error reports. */
  id: string;
  /**
   * Runs before confirmation and the handler. Return a denial to stop the
   * call. If it throws, the call is denied (fail closed) and the error goes
   * to `onError`.
   */
  beforeCall?(call: CallInfo): PluginDenial | void | Promise<PluginDenial | void>;
  /**
   * Observes everything that happens. It's awaited, so a durable audit write
   * completes before the agent gets its answer. If it throws, the error goes
   * to `onError` and the call is unaffected.
   */
  onEvent?(event: UsherEvent): void | Promise<void>;
}

/** Identity helper that gives full type inference for a plugin. */
export function definePlugin(plugin: UsherPlugin): UsherPlugin {
  return plugin;
}

/** Fails fast at startup on a malformed plugin list. */
export function assertValidPlugins(plugins: readonly UsherPlugin[]): void {
  const seen = new Set<string>();
  for (const plugin of plugins) {
    if (!plugin || typeof plugin.id !== "string" || !plugin.id.trim()) {
      throw new Error("[usher] Every plugin needs a non-empty string `id`");
    }
    if (seen.has(plugin.id)) throw new Error(`[usher] Plugin "${plugin.id}": duplicate id`);
    seen.add(plugin.id);
    for (const hook of ["beforeCall", "onEvent"] as const) {
      if (plugin[hook] !== undefined && typeof plugin[hook] !== "function") {
        throw new Error(`[usher] Plugin "${plugin.id}": ${hook} must be a function`);
      }
    }
    if (!plugin.beforeCall && !plugin.onEvent) {
      throw new Error(`[usher] Plugin "${plugin.id}": implements no hooks (beforeCall or onEvent)`);
    }
  }
}
