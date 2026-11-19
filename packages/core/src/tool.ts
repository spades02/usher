import { isUsherSchema, toJsonSchema, type InferOutput, type UsherSchema } from "./schema.js";

/**
 * What a tool does to the world. Required on every tool, so nobody ships a
 * destructive action by forgetting a flag.
 *
 * - `read`: never changes state (list orders, check balance).
 * - `write`: changes state in a recoverable way (add to cart, update address).
 * - `destructive`: hard or impossible to undo (cancel order, delete account,
 *   send payment). The customer must approve each call (see `UsherTool.confirm`).
 */
export type ToolEffect = "read" | "write" | "destructive";

/** Per-call context handed to every tool handler. */
export interface ToolContext {
  /**
   * The customer the agent acts for. Always authenticated. Scope every query
   * to `user.id`: this is what stops one customer's agent reading another's data.
   */
  user: { id: string };
  /** The agent making the call. `verified` is true when its identity is proven by an HTTPS domain (CIMD). */
  agent: { clientId: string; name: string; verified: boolean };
  /** The HTTP request that carried this call. */
  request: Request;
  /** Aborted when the agent cancels the call or disconnects. Pass it to fetch / DB calls. */
  signal: AbortSignal;
}

/**
 * A protocol-neutral tool definition (ADR 0002, ADR 0003).
 *
 * Tools are defined once and projected onto each agent-facing surface.
 */
export interface UsherTool<
  Input extends UsherSchema = UsherSchema,
  Output extends UsherSchema | undefined = UsherSchema | undefined,
> {
  /** Stable identifier the agent calls, e.g. `list_orders`. */
  name: string;
  /** Human-readable title shown in agent UIs. */
  title?: string;
  /** What the tool does and when to use it. Agents read this to pick tools. */
  description: string;
  /** Input schema (must describe an object). Validated before the handler runs. */
  input: Input;
  /**
   * Optional output schema (must describe an object). When set, agents get
   * typed structured results and Usher validates every return value.
   */
  output?: Output;
  /** What this tool does to the world. See {@link ToolEffect}. */
  effect: ToolEffect;
  /** True if repeating a call with the same input has no extra effect. Lets agents retry safely. */
  idempotent?: boolean;
  /**
   * Require the customer to approve each call on your own site before it
   * runs (ADR 0005). Default: `true` for `destructive` tools, `false`
   * otherwise. Pass a function to describe the action in plain words on the
   * approval page, e.g. `(input) => "Cancel order " + input.orderId`.
   */
  confirm?: boolean | ((input: InferOutput<Input>) => string);
  /** The business logic. Throw {@link ToolError} for failures the agent should see. */
  handler: (
    input: InferOutput<Input>,
    ctx: ToolContext,
  ) => HandlerResult<Output> | Promise<HandlerResult<Output>>;
}

type HandlerResult<Output> = Output extends UsherSchema ? InferOutput<Output> : unknown;

/** Identity helper that gives full type inference for a tool definition. */
export function defineTool<Input extends UsherSchema, Output extends UsherSchema | undefined = undefined>(
  tool: UsherTool<Input, Output>,
): UsherTool<Input, Output> {
  return tool;
}

/** Any tool, regardless of its schema types (`any` is needed for handler variance). */
export type AnyUsherTool = UsherTool<any, any>;

/** Whether each call needs the customer's out-of-band approval (ADR 0005). */
export function needsConfirmation(tool: AnyUsherTool): boolean {
  return tool.confirm === undefined ? tool.effect === "destructive" : tool.confirm !== false;
}

/** The OAuth scope that unlocks one tool (ADR 0005). */
export function toolScope(name: string): string {
  return `tool:${name}`;
}

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const EFFECTS: readonly ToolEffect[] = ["read", "write", "destructive"];

/**
 * Fails fast at startup, not at the first agent call, so a misconfigured tool
 * never reaches production.
 */
export function assertValidTools(tools: readonly AnyUsherTool[]): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    const where = `[usher] Tool "${tool.name}"`;
    if (!TOOL_NAME.test(tool.name)) {
      throw new Error(`${where}: invalid name. Use 1-128 characters from A-Z a-z 0-9 _ . -`);
    }
    if (seen.has(tool.name)) throw new Error(`${where}: duplicate name`);
    seen.add(tool.name);

    if (!tool.description?.trim()) {
      throw new Error(`${where}: description is required. Agents use it to decide when to call the tool`);
    }
    if (!EFFECTS.includes(tool.effect)) {
      throw new Error(`${where}: effect must be one of ${EFFECTS.join(", ")}`);
    }
    if (tool.confirm !== undefined && typeof tool.confirm !== "boolean" && typeof tool.confirm !== "function") {
      throw new Error(`${where}: confirm must be a boolean or a function returning a description`);
    }
    assertObjectSchema(tool.input, `${where} input`);
    if (tool.output !== undefined) assertObjectSchema(tool.output, `${where} output`, "output");
  }
}

function assertObjectSchema(schema: unknown, where: string, io: "input" | "output" = "input") {
  if (!isUsherSchema(schema)) {
    throw new Error(
      `${where}: not a supported schema. Use a library implementing Standard Schema + Standard JSON Schema (e.g. Zod >= 4.2)`,
    );
  }
  if (toJsonSchema(schema, io).type !== "object") {
    throw new Error(`${where}: schema must describe an object, e.g. z.object({ ... })`);
  }
}
