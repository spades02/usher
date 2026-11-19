import type { AnyUsherTool } from "../tool.js";
import {
  OAuthError,
  createClientResolver,
  parseRedirectUris,
  type MetadataFetch,
} from "./clients.js";
import { PAGE_HEADERS, renderConsentPage, renderErrorPage } from "./consent-page.js";
import { randomToken, sha256, signPayload, verifyPayload, verifyPkce } from "./crypto.js";
import type { AuthStore, ClientRecord, GrantRecord } from "./store.js";
import type { IdentityAdapter, Principal, UsherUser } from "./types.js";

export interface AuthServerOptions {
  appName: string;
  basePath: string;
  /** Public origin of the app, e.g. `https://shop.example`. Falls back to the request's origin. */
  baseUrl?: string;
  secret: string;
  identity: IdentityAdapter;
  store: AuthStore;
  tools: readonly AnyUsherTool[];
  accessTokenTtl: number;
  refreshTokenTtl: number;
  dynamicClientRegistration: boolean;
  fetchClientMetadata: MetadataFetch;
}

const CODE_TTL = 60;
const CONSENT_TTL = 10 * 60;

interface ConsentPayload {
  u: string; // user id
  c: string; // client id
  r: string; // redirect uri
  ch: string; // PKCE challenge
  res: string; // resource
  s?: string; // state
  exp: number;
}

/**
 * The embedded OAuth 2.1 authorization server plus resource-server checks,
 * implementing MCP authorization (2026-07-28, compatible with 2025 clients).
 */
export function createAuthServer(options: AuthServerOptions) {
  const { basePath, store, identity, secret, tools, appName } = options;
  const clients = createClientResolver(store, options.fetchClientMetadata);
  const now = () => Math.floor(Date.now() / 1000);

  function urls(request: Request) {
    const origin = (options.baseUrl ?? new URL(request.url).origin).replace(/\/+$/, "");
    const issuer = origin + basePath;
    return {
      origin,
      issuer,
      resource: `${issuer}/mcp`,
      resourceMetadata: `${origin}/.well-known/oauth-protected-resource${basePath}/mcp`,
      authorize: `${issuer}/oauth/authorize`,
      token: `${issuer}/oauth/token`,
      register: `${issuer}/oauth/register`,
      revoke: `${issuer}/oauth/revoke`,
    };
  }
  type Urls = ReturnType<typeof urls>;

  // ---------------------------------------------------------------- metadata

  function protectedResourceMetadata(u: Urls) {
    return json({
      resource: u.resource,
      authorization_servers: [u.issuer],
      bearer_methods_supported: ["header"],
      resource_name: appName,
    });
  }

  function authorizationServerMetadata(u: Urls) {
    return json({
      issuer: u.issuer,
      authorization_endpoint: u.authorize,
      token_endpoint: u.token,
      revocation_endpoint: u.revoke,
      ...(options.dynamicClientRegistration ? { registration_endpoint: u.register } : {}),
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  }

  // --------------------------------------------------------------- authorize

  async function authorize(request: Request, u: Urls): Promise<Response> {
    const params = new URL(request.url).searchParams;
    const clientId = params.get("client_id");
    const redirectUri = params.get("redirect_uri");
    if (!clientId) return errorPage("The request is missing a client_id.");

    let client: ClientRecord;
    try {
      client = await clients.resolve(clientId);
    } catch (error) {
      return errorPage(error instanceof OAuthError ? error.description : "Unknown agent.");
    }
    // Never redirect anywhere until redirect_uri is proven to belong to the client (open redirect).
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
      return errorPage("The agent's redirect address isn't registered for it.");
    }

    const state = params.get("state") ?? undefined;
    const fail = (error: string, description: string) =>
      redirectTo(redirectUri, { error, error_description: description, state, iss: u.issuer });

    if (params.get("response_type") !== "code") {
      return fail("unsupported_response_type", "Only response_type=code is supported");
    }
    const challenge = params.get("code_challenge");
    if (params.get("code_challenge_method") !== "S256" || !challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
      return fail("invalid_request", "PKCE with code_challenge_method=S256 is required");
    }
    const resource = params.get("resource") ?? u.resource;
    if (!sameResource(resource, u.resource)) {
      return fail("invalid_target", "Tokens can only be issued for this app's MCP endpoint");
    }

    const user = await identity.getUser(request);
    if (!user) {
      return redirect(identity.loginUrl(`${u.authorize}?${params.toString()}`));
    }

    const existing = await store.findActiveGrant(user.id, client.clientId);
    if (existing && params.get("prompt") !== "consent") {
      return issueCode(existing, { redirectUri, challenge, resource: u.resource, state }, u);
    }

    const consentToken = await signPayload(secret, {
      u: user.id,
      c: client.clientId,
      r: redirectUri,
      ch: challenge,
      res: u.resource,
      s: state,
      exp: now() + CONSENT_TTL,
    } satisfies ConsentPayload);

    return new Response(
      renderConsentPage({ appName, client, user, redirectUri, tools, action: u.authorize, consentToken }),
      { headers: PAGE_HEADERS },
    );
  }

  async function decide(request: Request, u: Urls): Promise<Response> {
    // CSRF: the form must come from this app's own pages...
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== u.origin) return errorPage("Request blocked.", 403);

    const form = new URLSearchParams(await request.text());
    // ...and carry a signed token bound to the signed-in user and the exact request.
    const consent = await verifyPayload<ConsentPayload>(secret, form.get("consent_token") ?? "");
    if (!consent || consent.exp < now()) {
      return errorPage("This approval page has expired. Start connecting the agent again.");
    }
    const user = await identity.getUser(request);
    if (!user || user.id !== consent.u) return errorPage("You're signed in as a different user.", 403);

    let client: ClientRecord;
    try {
      client = await clients.resolve(consent.c);
    } catch {
      return errorPage("Unknown agent.");
    }
    if (!client.redirectUris.includes(consent.r)) return errorPage("The agent's redirect address changed.");

    if (form.get("decision") !== "allow") {
      return redirectTo(consent.r, {
        error: "access_denied",
        error_description: "The user denied access",
        state: consent.s,
        iss: u.issuer,
      });
    }

    const grant = await createGrant(user, client);
    return issueCode(grant, { redirectUri: consent.r, challenge: consent.ch, resource: consent.res, state: consent.s }, u);
  }

  async function createGrant(user: UsherUser, client: ClientRecord): Promise<GrantRecord> {
    const grant: GrantRecord = {
      id: randomToken("grant_"),
      userId: user.id,
      clientId: client.clientId,
      clientName: client.clientName,
      clientSource: client.source,
      scopes: [],
      createdAt: now(),
    };
    await store.saveGrant(grant);
    return grant;
  }

  async function issueCode(
    grant: GrantRecord,
    req: { redirectUri: string; challenge: string; resource: string; state?: string },
    u: Urls,
  ): Promise<Response> {
    const code = randomToken("usher_code_");
    await store.saveCode({
      hash: await sha256(code),
      grantId: grant.id,
      clientId: grant.clientId,
      userId: grant.userId,
      redirectUri: req.redirectUri,
      codeChallenge: req.challenge,
      resource: req.resource,
      expiresAt: now() + CODE_TTL,
    });
    return redirectTo(req.redirectUri, { code, state: req.state, iss: u.issuer });
  }

  // ------------------------------------------------------------------- token

  async function token(request: Request, u: Urls): Promise<Response> {
    const form = new URLSearchParams(await request.text());
    const clientId = form.get("client_id");
    if (!clientId) return oauthError("invalid_client", "client_id is required", 401);

    const resource = form.get("resource");
    if (resource !== null && !sameResource(resource, u.resource)) {
      return oauthError("invalid_target", "Unknown resource");
    }

    switch (form.get("grant_type")) {
      case "authorization_code": {
        const consumed = await store.consumeCode(await sha256(form.get("code") ?? ""));
        if (!consumed) return oauthError("invalid_grant", "Invalid authorization code");
        const code = consumed.record;
        if (!consumed.firstUse) {
          // A replayed code means it leaked. Kill everything issued from it (RFC 6749 §4.1.2).
          await store.revokeGrant(code.grantId, now());
          return oauthError("invalid_grant", "Authorization code was already used");
        }
        if (code.expiresAt < now()) return oauthError("invalid_grant", "Authorization code expired");
        if (code.clientId !== clientId) return oauthError("invalid_grant", "Code was issued to another client");
        if (code.redirectUri !== form.get("redirect_uri")) return oauthError("invalid_grant", "redirect_uri mismatch");
        if (!(await verifyPkce(form.get("code_verifier") ?? "", code.codeChallenge))) {
          return oauthError("invalid_grant", "PKCE verification failed");
        }
        const grant = await store.getGrant(code.grantId);
        if (!grant || grant.revokedAt) return oauthError("invalid_grant", "Access was revoked");
        return issueTokens(grant, code.resource);
      }

      case "refresh_token": {
        const consumed = await store.consumeRefreshToken(await sha256(form.get("refresh_token") ?? ""));
        if (!consumed) return oauthError("invalid_grant", "Invalid refresh token");
        const refresh = consumed.record;
        if (!consumed.firstUse) {
          // Rotation reuse detection (OAuth 2.1 §4.3.1): someone has a stolen copy.
          await store.revokeGrant(refresh.grantId, now());
          return oauthError("invalid_grant", "Refresh token was already used");
        }
        if (refresh.expiresAt < now()) return oauthError("invalid_grant", "Refresh token expired");
        if (refresh.clientId !== clientId) return oauthError("invalid_grant", "Token was issued to another client");
        const grant = await store.getGrant(refresh.grantId);
        if (!grant || grant.revokedAt) return oauthError("invalid_grant", "Access was revoked");
        return issueTokens(grant, refresh.resource);
      }

      default:
        return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token");
    }
  }

  async function issueTokens(grant: GrantRecord, resource: string): Promise<Response> {
    const accessToken = randomToken("usher_at_");
    const refreshToken = randomToken("usher_rt_");
    const base = { grantId: grant.id, clientId: grant.clientId, userId: grant.userId, resource };
    await store.saveToken({ ...base, hash: await sha256(accessToken), kind: "access", expiresAt: now() + options.accessTokenTtl });
    await store.saveToken({ ...base, hash: await sha256(refreshToken), kind: "refresh", expiresAt: now() + options.refreshTokenTtl });
    return json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: options.accessTokenTtl,
      refresh_token: refreshToken,
    });
  }

  // ------------------------------------------------- registration & revocation

  async function register(request: Request): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return oauthError("invalid_client_metadata", "Body must be JSON");
    }
    const method = body.token_endpoint_auth_method;
    if (method !== undefined && method !== "none") {
      return oauthError("invalid_client_metadata", "Only public clients (token_endpoint_auth_method \"none\") are supported");
    }
    let redirectUris: string[];
    try {
      redirectUris = parseRedirectUris(body.redirect_uris);
    } catch (error) {
      const e = error as OAuthError;
      return oauthError(e.error, e.description);
    }
    const name = typeof body.client_name === "string" && body.client_name.trim() ? body.client_name.trim().slice(0, 100) : "Unnamed agent";
    const client: ClientRecord = {
      clientId: randomToken("dcr_"),
      clientName: name,
      redirectUris,
      source: "dcr",
      createdAt: now(),
    };
    await store.saveClient(client);
    return json(
      {
        client_id: client.clientId,
        client_id_issued_at: client.createdAt,
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        ...(typeof body.application_type === "string" ? { application_type: body.application_type } : {}),
      },
      201,
    );
  }

  async function revoke(request: Request): Promise<Response> {
    const form = new URLSearchParams(await request.text());
    const record = await store.getToken(await sha256(form.get("token") ?? ""));
    // RFC 7009: revoking either token ends the whole grant; always answer 200.
    if (record && record.clientId === form.get("client_id")) await store.revokeGrant(record.grantId, now());
    return new Response(null, { status: 200, headers: CORS });
  }

  // ---------------------------------------------------------- resource server

  /** Validates the bearer token on an MCP request. Returns the caller, or a 401 response. */
  async function authenticate(request: Request): Promise<Principal | Response> {
    const u = urls(request);
    const header = request.headers.get("authorization");
    const match = header?.match(/^Bearer\s+([A-Za-z0-9._~+/-]+=*)$/i);
    if (!match?.[1]) return unauthorized(u);

    const record = await store.getToken(await sha256(match[1]));
    if (!record || record.kind !== "access" || record.expiresAt < now()) return unauthorized(u, true);
    // Audience binding (RFC 8707): only tokens minted for this endpoint are accepted.
    if (!sameResource(record.resource, u.resource)) return unauthorized(u, true);
    const grant = await store.getGrant(record.grantId);
    if (!grant || grant.revokedAt) return unauthorized(u, true);

    return {
      user: { id: grant.userId },
      agent: { clientId: grant.clientId, name: grant.clientName, verified: grant.clientSource === "cimd" },
      grantId: grant.id,
    };
  }

  function unauthorized(u: Urls, invalidToken = false): Response {
    const params = [
      ...(invalidToken ? ['error="invalid_token"', 'error_description="The access token is invalid or expired"'] : []),
      `resource_metadata="${u.resourceMetadata}"`,
    ];
    return Response.json(
      { error: invalidToken ? "invalid_token" : "unauthorized" },
      { status: 401, headers: { ...CORS, "www-authenticate": `Bearer ${params.join(", ")}` } },
    );
  }

  // ------------------------------------------------------------------ router

  /** Handles an auth route, or returns null if the path isn't one. */
  async function route(request: Request, pathname: string): Promise<Response | null> {
    const u = urls(request);
    const method = request.method;
    const isMetadata =
      pathname === `/.well-known/oauth-protected-resource${basePath}/mcp` ||
      pathname === "/.well-known/oauth-protected-resource" ||
      pathname === `/.well-known/oauth-authorization-server${basePath}`;
    const isApi = [`${basePath}/oauth/token`, `${basePath}/oauth/register`, `${basePath}/oauth/revoke`].includes(pathname);

    // Browser-based agents call metadata and token endpoints cross-origin. They carry no cookies.
    if ((isMetadata || isApi) && method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (isMetadata) {
      if (method !== "GET") return methodNotAllowed();
      return pathname.startsWith("/.well-known/oauth-protected-resource")
        ? protectedResourceMetadata(u)
        : authorizationServerMetadata(u);
    }

    try {
      switch (pathname) {
        case `${basePath}/oauth/authorize`:
          if (method === "GET") return await authorize(request, u);
          if (method === "POST") return await decide(request, u);
          return methodNotAllowed();
        case `${basePath}/oauth/token`:
          return method === "POST" ? await token(request, u) : methodNotAllowed();
        case `${basePath}/oauth/register`:
          if (!options.dynamicClientRegistration) return null;
          return method === "POST" ? await register(request) : methodNotAllowed();
        case `${basePath}/oauth/revoke`:
          return method === "POST" ? await revoke(request) : methodNotAllowed();
        default:
          return null;
      }
    } catch (error) {
      if (error instanceof OAuthError) return oauthError(error.error, error.description, error.status);
      throw error;
    }
  }

  function errorPage(message: string, status = 400): Response {
    return new Response(renderErrorPage(appName, message), { status, headers: PAGE_HEADERS });
  }

  return {
    route,
    authenticate,
    grants: {
      /** Agents the user has connected (for a "Connected agents" settings page). */
      list: async (userId: string) => (await store.listGrants(userId)).filter((g) => !g.revokedAt),
      /** Disconnects an agent immediately. Every token issued under the grant stops working. */
      revoke: async (userId: string, grantId: string) => {
        const grant = await store.getGrant(grantId);
        if (grant && grant.userId === userId) await store.revokeGrant(grantId, now());
      },
    },
  };
}

// -------------------------------------------------------------------- helpers

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-method, mcp-name",
  "access-control-expose-headers": "www-authenticate",
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { ...CORS, "cache-control": "no-store" } });
}

function oauthError(error: string, description: string, status = 400): Response {
  return json({ error, error_description: description }, status);
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
}

function redirectTo(base: string, params: Record<string, string | undefined>): Response {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
  return redirect(url.toString());
}

function methodNotAllowed(): Response {
  return new Response("Method not allowed", { status: 405, headers: CORS });
}

/** RFC 8707 resource comparison: scheme and host are case-insensitive, and the trailing slash is ignored. */
function sameResource(a: string, b: string): boolean {
  try {
    const norm = (value: string) => {
      const url = new URL(value);
      if (url.hash) return null;
      return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}${url.search}`;
    };
    const left = norm(a);
    return left !== null && left === norm(b);
  } catch {
    return false;
  }
}
