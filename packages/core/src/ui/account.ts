/**
 * The customer API behind `<usher-agents>` and `<usher-connect>` (ADR 0009).
 *
 * It is called by the app's own pages, in the customer's browser, with the
 * app's session cookie. Because cookies ride along automatically, every
 * route is protected against cross-site use:
 *
 * - All signed-in routes need the `X-Usher-Request: 1` header. A cross-site
 *   page can only send it after a CORS preflight, which Usher never grants
 *   here (no CORS headers on these routes).
 * - Changes also need an `Origin` equal to the app's own.
 * - Responses are `no-store` and only ever about the signed-in customer.
 */
import type { GrantRecord } from "../auth/store.js";
import type { IdentityAdapter, UsherUser } from "../auth/types.js";
import type { QueryableAuditSink } from "../plugins/audit-log.js";
import type { UsherEvent } from "../plugins/types.js";
import { type AnyUsherTool, needsConfirmation, toolScope } from "../tool.js";

export const REQUEST_HEADER = "x-usher-request";

export interface AccountApiOptions {
  basePath: string;
  appName: string;
  /** The app's public origin (from `baseUrl`), else the request's. */
  ownOrigin?: string;
  identity: IdentityAdapter;
  tools: readonly AnyUsherTool[];
  grants: {
    list(userId: string): Promise<GrantRecord[]>;
    revoke(userId: string, grantId: string): Promise<void>;
    setScopes(userId: string, grantId: string, scopes: string[]): Promise<void>;
  };
  /** Enables the activity feed. */
  activity?: QueryableAuditSink;
}

/** What the customer sees about one connected agent. */
export interface AgentView {
  id: string;
  name: string;
  clientId: string;
  verified: boolean;
  /** The domain that vouches for the agent, for verified (CIMD) agents. */
  domain?: string;
  connectedAt: number;
  scopes: string[];
}

export function createAccountApi(options: AccountApiOptions) {
  const { basePath, identity, tools } = options;
  const prefix = `${basePath}/account/`;
  const knownScopes = new Set(tools.map((t) => toolScope(t.name)));

  const toolViews = tools.map((t) => ({
    name: t.name,
    title: t.title ?? t.name,
    description: t.description,
    effect: t.effect,
    scope: toolScope(t.name),
    asksFirst: needsConfirmation(t),
  }));

  const json = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });

  function agentView(g: GrantRecord): AgentView {
    let domain: string | undefined;
    if (g.clientSource === "cimd") {
      try {
        domain = new URL(g.clientId).host;
      } catch {
        // CIMD client ids are URLs; tolerate anything else.
      }
    }
    return {
      id: g.id,
      name: g.clientName,
      clientId: g.clientId,
      verified: g.clientSource === "cimd",
      ...(domain ? { domain } : {}),
      connectedAt: g.createdAt * 1000, // ms, ready for `new Date()`
      scopes: g.scopes.filter((s) => knownScopes.has(s)),
    };
  }

  /** Audit events without anything the customer doesn't need: no input hashes, no user ids. */
  function eventView(event: UsherEvent) {
    const { userId: _u, ...rest } = event;
    if ("inputHash" in rest) delete (rest as { inputHash?: string }).inputHash;
    return rest;
  }

  async function signedIn(request: Request): Promise<UsherUser | Response> {
    const user = await identity.getUser(request);
    if (user) return user;
    const origin = options.ownOrigin ?? new URL(request.url).origin;
    const referer = request.headers.get("referer");
    const returnTo = referer && new URL(referer, origin).origin === origin ? referer : `${origin}/`;
    return json({ error: "signed_out", login_url: identity.loginUrl(returnTo) }, 401);
  }

  async function route(request: Request, pathname: string): Promise<Response | null> {
    if (!pathname.startsWith(prefix)) return null;
    const path = pathname.slice(prefix.length);
    const method = request.method;

    // Public: what the "Connect your agent" widget needs, even when signed out.
    if (path === "info") {
      if (method !== "GET") return json({ error: "method_not_allowed" }, 405);
      const origin = options.ownOrigin ?? new URL(request.url).origin;
      return json({ app: { name: options.appName }, mcpUrl: `${origin}${basePath}/mcp`, tools: toolViews });
    }

    if (request.headers.get(REQUEST_HEADER) !== "1") return json({ error: "missing_request_header" }, 403);
    if (method !== "GET") {
      const origin = request.headers.get("origin");
      if (origin === null || origin !== (options.ownOrigin ?? new URL(request.url).origin)) {
        return json({ error: "origin_not_allowed" }, 403);
      }
    }

    const user = await signedIn(request);
    if (user instanceof Response) return user;

    if (path === "agents") {
      if (method !== "GET") return json({ error: "method_not_allowed" }, 405);
      const grants = await options.grants.list(user.id);
      return json({
        user: { id: user.id, name: user.name ?? user.email ?? user.id },
        tools: toolViews,
        agents: grants.sort((a, b) => b.createdAt - a.createdAt).map(agentView),
        activity: options.activity !== undefined,
      });
    }

    const agent = path.match(/^agents\/([^/]+)$/);
    if (agent) {
      const grantId = decodeURIComponent(agent[1]!);
      const owned = (await options.grants.list(user.id)).some((g) => g.id === grantId);
      if (!owned) return json({ error: "not_found" }, 404);
      if (method === "DELETE") {
        await options.grants.revoke(user.id, grantId);
        return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
      }
      if (method === "PUT") {
        let body: { scopes?: unknown };
        try {
          body = (await request.json()) as { scopes?: unknown };
        } catch {
          return json({ error: "invalid_json" }, 400);
        }
        const scopes = body?.scopes;
        if (!Array.isArray(scopes) || !scopes.every((s) => typeof s === "string" && knownScopes.has(s))) {
          return json({ error: "invalid_scopes" }, 400);
        }
        await options.grants.setScopes(user.id, grantId, scopes);
        const updated = (await options.grants.list(user.id)).find((g) => g.id === grantId)!;
        return json({ agent: agentView(updated) });
      }
      return json({ error: "method_not_allowed" }, 405);
    }

    if (path === "activity") {
      if (method !== "GET") return json({ error: "method_not_allowed" }, 405);
      if (!options.activity) return json({ error: "activity_disabled" }, 404);
      const params = new URL(request.url).searchParams;
      const limit = Math.min(Math.max(Number(params.get("limit") ?? 20) || 20, 1), 100);
      const grantId = params.get("agent") ?? undefined;
      const events = await options.activity.list({ userId: user.id, grantId, limit });
      return json({ events: events.map(eventView) });
    }

    return json({ error: "not_found" }, 404);
  }

  return { route };
}
