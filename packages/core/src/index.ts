import { isOriginAllowed } from "./origin.js";
import { createMcpSurface } from "./surfaces/mcp.js";
import { assertValidTools, type UsherTool } from "./tool.js";

export { defineTool, type ToolContext, type UsherTool } from "./tool.js";

export interface UsherOptions {
  /** The actions agents may perform in your app. */
  tools: readonly UsherTool[];
  /** Your app's name and version, reported to agents. */
  app: { name: string; version: string };
  /** Guidance for agents on how to use your tools. */
  instructions?: string;
  /** Where Usher's routes are mounted. Default: `/api/usher`. */
  basePath?: string;
  /** Extra browser origins allowed to call Usher (your own origin always is). */
  allowedOrigins?: readonly string[];
}

export interface Usher {
  /**
   * Web-standard request handler. Mount it in any framework that speaks
   * `Request -> Response` (Next.js route handlers, Hono, Bun, Deno, Workers).
   */
  handler: (request: Request) => Promise<Response>;
}

export function createUsher(options: UsherOptions): Usher {
  const basePath = (options.basePath ?? "/api/usher").replace(/\/+$/, "");
  const allowedOrigins = options.allowedOrigins ?? [];

  assertValidTools(options.tools);

  const mcp = createMcpSurface({
    tools: options.tools,
    serverInfo: options.app,
    instructions: options.instructions,
  });

  return {
    async handler(request) {
      const { pathname } = new URL(request.url);

      if (pathname === `${basePath}/mcp`) {
        if (!isOriginAllowed(request, allowedOrigins)) {
          return Response.json(
            { jsonrpc: "2.0", error: { code: -32600, message: "Origin not allowed" } },
            { status: 403 },
          );
        }
        return mcp.fetch(request);
      }

      return new Response("Not found", { status: 404 });
    },
  };
}
