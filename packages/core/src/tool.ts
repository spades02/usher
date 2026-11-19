import type { z } from "zod";

/**
 * Per-call context handed to every tool handler.
 *
 * Phase 1 only exposes the raw request. Phase 3 (agent auth) adds the
 * authenticated end-user and the agent's grant; Phase 4 adds scopes.
 */
export interface ToolContext {
  /** The HTTP request that carried this call. */
  request: Request;
}

/**
 * A protocol-neutral tool definition.
 *
 * Tools are defined once and projected onto each agent-facing surface
 * (remote MCP today; WebMCP later). Nothing in here is MCP-specific — that is
 * the point of ADR 0002. The exact shape is provisional until Phase 2.
 */
export interface UsherTool<
  Input extends z.ZodObject = z.ZodObject,
  Output = unknown,
> {
  /** Stable identifier the agent calls, e.g. `list_orders`. */
  name: string;
  /** Human-readable title shown in agent UIs. */
  title?: string;
  /** What the tool does and when to use it. Agents read this. */
  description: string;
  /** Input schema; validated before the handler runs. */
  input: Input;
  /** True if the tool never changes state. Lets agents call it without confirmation. */
  readOnly?: boolean;
  /** The business logic. Return any JSON-serializable value. */
  handler: (input: z.output<Input>, ctx: ToolContext) => Output | Promise<Output>;
}

/** Identity helper that gives full type inference for a tool definition. */
export function defineTool<Input extends z.ZodObject, Output>(
  tool: UsherTool<Input, Output>,
): UsherTool<Input, Output> {
  return tool;
}

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

/** Fails fast at startup on invalid or duplicate tool names. */
export function assertValidTools(tools: readonly UsherTool[]): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (!TOOL_NAME.test(tool.name)) {
      throw new Error(
        `[usher] Invalid tool name "${tool.name}": use 1-128 characters from A-Z a-z 0-9 _ . -`,
      );
    }
    if (seen.has(tool.name)) {
      throw new Error(`[usher] Duplicate tool name "${tool.name}"`);
    }
    seen.add(tool.name);
  }
}
