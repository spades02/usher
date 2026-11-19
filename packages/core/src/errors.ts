/**
 * An error whose message is safe to show the agent (and, through it, the
 * customer). Throw it for expected business failures:
 *
 *   throw new ToolError("Shipped orders can't be cancelled");
 *
 * Any other thrown error is treated as unexpected. The agent gets a generic
 * message and the real error goes to `onError`, so database errors, stack
 * traces and internal details never leak to a third-party agent.
 */
export class ToolError extends Error {
  override readonly name = "ToolError";
  /** Optional machine-readable code the agent can branch on, e.g. `not_found`. */
  readonly code: string | undefined;

  constructor(message: string, options?: { code?: string; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.code = options?.code;
  }
}

export const GENERIC_TOOL_FAILURE = "Something went wrong while running this tool.";
