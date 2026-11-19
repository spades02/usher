import { createAuthServer } from "./auth/server.js";
import { memoryStore, type AuthStore, type GrantRecord } from "./auth/store.js";
import type { IdentityAdapter, Principal } from "./auth/types.js";
import { isOriginAllowed } from "./origin.js";
import { createMcpSurface } from "./surfaces/mcp.js";
import { assertValidTools, toolScope, type AnyUsherTool } from "./tool.js";

export { memoryStore } from "./auth/store.js";
export type {
  AuthStore,
  ClientRecord,
  CodeRecord,
  ConfirmationRecord,
  Consumed,
  GrantRecord,
  TokenRecord,
} from "./auth/store.js";
export type { CallDecision, IdentityAdapter, Principal, UsherUser } from "./auth/types.js";
export { ToolError } from "./errors.js";
export type { InferInput, InferOutput, UsherSchema } from "./schema.js";
export {
  defineTool,
  type AnyUsherTool,
  type ToolContext,
  toolScope,
  type ToolEffect,
  type UsherTool,
} from "./tool.js";

export interface UsherOptions {
  /** The actions agents may perform in your app. */
  tools: readonly AnyUsherTool[];
  /** Your app's name and version, reported to agents and shown on the consent screen. */
  app: { name: string; version: string };
  /** Bridge to your existing auth: who is signed in, and where to log in. */
  identity: IdentityAdapter;
  /** Signs consent forms. At least 32 random characters, e.g. from `openssl rand -base64 32`. Keep it secret. */
  secret: string;
  /**
   * Public origin of your app, e.g. `https://shop.example`. Strongly
   * recommended in production: without it, URLs are derived from the
   * request, which is wrong behind some proxies.
   */
  baseUrl?: string;
  /** Persistence for grants and tokens. Default: in-memory (development only). */
  store?: AuthStore;
  /** Guidance for agents on how to use your tools. */
  instructions?: string;
  /** Where Usher's routes are mounted. Default: `/api/usher`. */
  basePath?: string;
  /** Extra browser origins allowed to call the MCP endpoint (your own origin always is). */
  allowedOrigins?: readonly string[];
  /**
   * Called with unexpected errors thrown by tool handlers. The agent only sees
   * a generic message. Default: `console.error`.
   */
  onError?: (error: unknown, info: { tool: string }) => void;
  auth?: {
    /** Access token lifetime in seconds. Default: 3600 (1 hour). */
    accessTokenTtl?: number;
    /** Refresh token lifetime in seconds. Default: 2592000 (30 days). Rotated on every use. */
    refreshTokenTtl?: number;
    /** Accept RFC 7591 Dynamic Client Registration (deprecated in MCP, still used by 2025-era agents). Default: true. */
    dynamicClientRegistration?: boolean;
    /** Override how Client ID Metadata Documents are fetched, e.g. with a DNS-aware SSRF-safe fetch. */
    fetchClientMetadata?: (url: URL, init: RequestInit) => Promise<Response>;
  };
}

export interface Usher {
  /**
   * Web-standard request handler. Route both `{basePath}/*` and
   * `/.well-known/oauth-*` to it, in any framework that speaks
   * `Request -> Response` (Next.js route handlers, Hono, Bun, Deno, Workers).
   */
  handler: (request: Request) => Promise<Response>;
  /** Manage the agents a customer has connected. Use it to build a "Connected agents" page. */
  grants: {
    list(userId: string): Promise<GrantRecord[]>;
    revoke(userId: string, grantId: string): Promise<void>;
    /** Changes which tools a connected agent may use (scopes from `toolScope(name)`). Applies on its next call. */
    setScopes(userId: string, grantId: string, scopes: string[]): Promise<void>;
  };
}

export function createUsher(options: UsherOptions): Usher {
  const basePath = (options.basePath ?? "/api/usher").replace(/\/+$/, "");
  const allowedOrigins = options.allowedOrigins ?? [];

  assertValidTools(options.tools);
  if (typeof options.secret !== "string" || options.secret.length < 32) {
    throw new Error("[usher] `secret` must be at least 32 characters. Generate one with `openssl rand -base64 32`");
  }
  if (!options.identity?.getUser || !options.identity?.loginUrl) {
    throw new Error("[usher] `identity` must provide getUser(request) and loginUrl(returnTo)");
  }
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  if (!options.store && env?.NODE_ENV === "production") {
    console.warn("[usher] Using the in-memory store in production: connected agents are lost on restart.");
  }

  const auth = createAuthServer({
    appName: options.app.name,
    basePath,
    baseUrl: options.baseUrl,
    secret: options.secret,
    identity: options.identity,
    store: options.store ?? memoryStore(),
    tools: options.tools,
    accessTokenTtl: options.auth?.accessTokenTtl ?? 3600,
    refreshTokenTtl: options.auth?.refreshTokenTtl ?? 30 * 24 * 3600,
    dynamicClientRegistration: options.auth?.dynamicClientRegistration ?? true,
    fetchClientMetadata: options.auth?.fetchClientMetadata ?? ((url, init) => fetch(url, init)),
  });

  const mcp = createMcpSurface({
    tools: options.tools,
    serverInfo: options.app,
    instructions: options.instructions,
    onError:
      options.onError ??
      ((error, { tool }) => console.error(`[usher] Tool "${tool}" failed:`, error)),
    policy: auth.checkCall,
  });
  const toolNames = new Set(options.tools.map((t) => t.name));

  /**
   * Finds a tools/call for a tool the customer hasn't granted, before the
   * MCP layer runs, so the agent gets an HTTP 403 `insufficient_scope` it
   * can answer by asking the customer (MCP step-up authorization).
   */
  async function missingScope(request: Request, principal: Principal): Promise<string | null> {
    if (request.method !== "POST") return null;
    let body: unknown;
    try {
      body = await request.clone().json();
    } catch {
      return null; // Malformed bodies are the MCP layer's to reject.
    }
    for (const message of Array.isArray(body) ? body : [body]) {
      const name = (message as { method?: unknown; params?: { name?: unknown } } | null)?.params?.name;
      if ((message as { method?: unknown } | null)?.method !== "tools/call" || typeof name !== "string") continue;
      if (toolNames.has(name) && !principal.scopes.includes(toolScope(name))) return toolScope(name);
    }
    return null;
  }

  return {
    grants: auth.grants,
    async handler(request) {
      const { pathname } = new URL(request.url);

      if (pathname === `${basePath}/mcp`) {
        if (!isOriginAllowed(request, allowedOrigins)) {
          return Response.json(
            { jsonrpc: "2.0", error: { code: -32600, message: "Origin not allowed" } },
            { status: 403 },
          );
        }
        const principal = await auth.authenticate(request);
        if (principal instanceof Response) return principal;
        const scope = await missingScope(request, principal);
        if (scope) return auth.insufficientScope(request, principal, scope);
        const token = request.headers.get("authorization")?.split(/\s+/)[1] ?? "";
        return mcp.fetch(request, principal, token);
      }

      return (await auth.route(request, pathname)) ?? new Response("Not found", { status: 404 });
    },
  };
}
