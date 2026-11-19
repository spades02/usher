import { needsConfirmation, toolScope, type AnyUsherTool } from "../tool.js";
import {
  OAuthError,
  createClientResolver,
  parseRedirectUris,
  type MetadataFetch,
} from "./clients.js";
import {
  PAGE_HEADERS,
  renderConfirmPage,
  renderConsentPage,
  renderDonePage,
  renderErrorPage,
} from "./consent-page.js";
import { canonicalJson, randomToken, sha256, signPayload, verifyPayload, verifyPkce } from "./crypto.js";
import type { AuthStore, ClientRecord, ConfirmationRecord, GrantRecord } from "./store.js";
import type { ConfirmationVerdict } from "../pipeline.js";
import type { UsherEvent } from "../plugins/types.js";
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
  /** Delivers grant and confirmation events to plugins (ADR 0006). */
  emit: (event: UsherEvent) => Promise<void>;
}

const CODE_TTL = 60;
const CONSENT_TTL = 10 * 60;
/** How long the customer has to approve a confirmed call, and the agent to retry it. */
const CONFIRM_TTL = 15 * 60;
const MAX_DETAILS = 10_000;

interface ConsentPayload {
  k: "consent"; // payload kind, so a confirm token can never pass as a consent token
  u: string; // user id
  c: string; // client id
  r: string; // redirect uri
  ch: string; // PKCE challenge
  res: string; // resource
  s?: string; // state
  o: string[]; // scopes offered on the page; the approved set must be a subset
  exp: number;
}

interface ConfirmPayload {
  k: "confirm";
  id: string; // confirmation id
  u: string; // user id
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
  const toolsByScope = new Map(tools.map((t) => [toolScope(t.name), t]));
  const toolsByName = new Map(tools.map((t) => [t.name, t]));
  const allScopes = [...toolsByScope.keys()];

  const agentOf = (grant: GrantRecord) => ({
    clientId: grant.clientId,
    name: grant.clientName,
    verified: grant.clientSource === "cimd",
  });
  const grantEvent = (grant: GrantRecord) => ({ at: Date.now(), userId: grant.userId, agent: agentOf(grant), grantId: grant.id });

  /** The only way grants are revoked, so every revocation is recorded. */
  async function revokeGrant(grantId: string, reason: "customer" | "agent" | "token_replay") {
    const grant = await store.getGrant(grantId);
    if (!grant || grant.revokedAt) return;
    await store.revokeGrant(grantId, now());
    await options.emit({ type: "grant.revoked", ...grantEvent(grant), reason });
  }

  async function setGrantScopes(grant: GrantRecord, scopes: string[]) {
    await store.updateGrantScopes(grant.id, scopes);
    await options.emit({ type: "grant.updated", ...grantEvent(grant), scopes });
  }

  /**
   * Reads the OAuth `scope` parameter. Unknown scopes (`openid`,
   * `offline_access`, removed tools) are ignored. No known scope means an
   * open request: the customer picks from every tool.
   */
  function parseScope(value: string | null): { explicit: boolean; scopes: string[] } {
    const scopes = [...new Set((value ?? "").split(/\s+/).filter((s) => toolsByScope.has(s)))];
    return { explicit: scopes.length > 0, scopes };
  }

  function urls(request: Request) {
    const origin = (options.baseUrl ?? new URL(request.url).origin).replace(/\/+$/, "");
    const issuer = origin + basePath;
    return {
      origin,
      issuer,
      resource: `${issuer}/mcp`,
      resourceMetadata: `${origin}/.well-known/oauth-protected-resource${basePath}/mcp`,
      authorize: `${issuer}/oauth/authorize`,
      confirm: `${issuer}/confirm/`,
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

    const requested = parseScope(params.get("scope"));
    const existing = await store.findActiveGrant(user.id, client.clientId);
    const covered = !requested.explicit || requested.scopes.every((s) => existing?.scopes.includes(s));
    if (existing && covered && params.get("prompt") !== "consent") {
      // Nothing new to decide: reconnects and narrower requests skip the screen.
      return issueCode(existing, { redirectUri, challenge, resource: u.resource, state }, u);
    }

    // Offer what was asked for plus what's already granted, so approving a
    // step-up never silently drops earlier permissions.
    const granted = (existing?.scopes ?? []).filter((s) => toolsByScope.has(s));
    const offered = [...new Set([...granted, ...(requested.explicit ? requested.scopes : allScopes)])];
    const checked = new Set(requested.explicit || !existing ? offered : granted);

    const consentToken = await signPayload(secret, {
      k: "consent",
      u: user.id,
      c: client.clientId,
      r: redirectUri,
      ch: challenge,
      res: u.resource,
      s: state,
      o: offered,
      exp: now() + CONSENT_TTL,
    } satisfies ConsentPayload);

    const shown = tools.filter((t) => offered.includes(toolScope(t.name)));
    return new Response(
      renderConsentPage({
        appName,
        client,
        user,
        redirectUri,
        tools: shown,
        checked,
        update: existing !== null,
        action: u.authorize,
        consentToken,
      }),
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
    if (!consent || consent.k !== "consent" || consent.exp < now()) {
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

    // Only scopes that were on the page count; anything else in the form is ignored.
    const approved = [...new Set(form.getAll("scope"))].filter((s) => consent.o.includes(s));
    if (form.get("decision") !== "allow" || approved.length === 0) {
      return redirectTo(consent.r, {
        error: "access_denied",
        error_description: "The user denied access",
        state: consent.s,
        iss: u.issuer,
      });
    }

    // One grant per customer + agent: a step-up replaces its scopes, it doesn't add a second grant.
    const existing = await store.findActiveGrant(user.id, client.clientId);
    let grant: GrantRecord;
    if (existing) {
      await setGrantScopes(existing, approved);
      grant = { ...existing, scopes: approved };
    } else {
      grant = await createGrant(user, client, approved);
    }
    return issueCode(grant, { redirectUri: consent.r, challenge: consent.ch, resource: consent.res, state: consent.s }, u);
  }

  async function createGrant(user: UsherUser, client: ClientRecord, scopes: string[]): Promise<GrantRecord> {
    const grant: GrantRecord = {
      id: randomToken("grant_"),
      userId: user.id,
      clientId: client.clientId,
      clientName: client.clientName,
      clientSource: client.source,
      scopes,
      createdAt: now(),
    };
    await store.saveGrant(grant);
    await options.emit({ type: "grant.created", ...grantEvent(grant), scopes });
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
          await revokeGrant(code.grantId, "token_replay");
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
          await revokeGrant(refresh.grantId, "token_replay");
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
      // Lets clients compute the scope union on step-up (MCP scope selection).
      scope: grant.scopes.join(" "),
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
    if (record && record.clientId === form.get("client_id")) await revokeGrant(record.grantId, "agent");
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
      // Live from the grant: permission changes apply on the agent's very next call.
      scopes: [...grant.scopes],
    };
  }

  /**
   * 403 that tells a compliant MCP client to ask the customer for one more
   * tool (RFC 6750 §3.1 `insufficient_scope`, MCP step-up authorization).
   */
  function insufficientScope(request: Request, principal: Principal, scope: string): Response {
    const u = urls(request);
    const wanted = [...new Set([...principal.scopes.filter((s) => toolsByScope.has(s)), scope])].join(" ");
    const description = `The customer hasn't allowed this agent to use ${scope.slice("tool:".length)}`;
    return Response.json(
      { error: "insufficient_scope", error_description: description },
      {
        status: 403,
        headers: {
          ...CORS,
          "www-authenticate": `Bearer error="insufficient_scope", scope="${wanted}", resource_metadata="${u.resourceMetadata}", error_description="${description}"`,
        },
      },
    );
  }

  // ------------------------------------------------------------ permissions

  /**
   * The confirmation gate (ADR 0005): if the tool needs it, has the customer
   * approved this exact call? Scopes are checked earlier, by the pipeline.
   */
  async function confirmationGate(
    request: Request,
    principal: Principal,
    tool: AnyUsherTool,
    input: unknown,
  ): Promise<ConfirmationVerdict> {
    if (!needsConfirmation(tool)) return { kind: "allow" };

    const canonical = canonicalJson(input);
    const inputHash = await sha256(canonical);
    const at = now();
    const existing = await store.findConfirmation(principal.grantId, tool.name, inputHash, at);
    if (existing?.status === "approved") {
      // Single use: of two concurrent retries, exactly one runs.
      if (await store.consumeConfirmation(existing.id)) return { kind: "allow" };
    } else if (existing?.status === "denied") {
      await store.consumeConfirmation(existing.id);
      return { kind: "declined" };
    } else if (existing) {
      return { kind: "confirm", url: urls(request).confirm + existing.id, summary: existing.summary };
    }

    const summary = typeof tool.confirm === "function" ? String(tool.confirm(input)) : (tool.title ?? tool.name);
    const pretty = JSON.stringify(JSON.parse(canonical), null, 2);
    const confirmation: ConfirmationRecord = {
      id: randomToken("usher_cf_"),
      grantId: principal.grantId,
      userId: principal.user.id,
      clientName: principal.agent.name,
      tool: tool.name,
      inputHash,
      summary: summary.slice(0, 200),
      details: pretty.length > MAX_DETAILS ? `${pretty.slice(0, MAX_DETAILS)}\n…` : pretty,
      status: "pending",
      createdAt: at,
      expiresAt: at + CONFIRM_TTL,
    };
    await store.saveConfirmation(confirmation);
    return { kind: "confirm", url: urls(request).confirm + confirmation.id, summary: confirmation.summary };
  }

  /** Loads a confirmation the signed-in customer may decide on, or the page explaining why not. */
  async function confirmationFor(id: string, user: UsherUser | null, request: Request) {
    const confirmation = await store.getConfirmation(id);
    if (!confirmation || confirmation.expiresAt < now()) {
      return errorPage("This approval link has expired or was already used. Ask your agent to try again.", 404, "Nothing to approve");
    }
    if (!user) return redirect(identity.loginUrl(request.url));
    if (user.id !== confirmation.userId) return errorPage("This approval belongs to a different account.", 403, "Wrong account");
    const grant = await store.getGrant(confirmation.grantId);
    if (!grant || grant.revokedAt) return errorPage("This agent was disconnected, so it can't take this action.", 410, "Agent disconnected");
    const tool = toolsByName.get(confirmation.tool);
    if (!tool) return errorPage("This action is no longer available.", 410, "Nothing to approve");
    if (confirmation.status !== "pending") {
      return done(confirmation.status === "approved" ? "Already approved" : "Already declined", "You can close this page and go back to your agent.");
    }
    return { confirmation, grant, tool, user };
  }

  async function showConfirmation(request: Request, u: Urls, id: string): Promise<Response> {
    const found = await confirmationFor(id, await identity.getUser(request), request);
    if (found instanceof Response) return found;
    const confirmToken = await signPayload(secret, {
      k: "confirm",
      id,
      u: found.user.id,
      exp: now() + CONSENT_TTL,
    } satisfies ConfirmPayload);
    return new Response(
      renderConfirmPage({
        appName,
        confirmation: found.confirmation,
        tool: found.tool,
        verified: found.grant.clientSource === "cimd",
        user: found.user,
        action: u.confirm + id,
        confirmToken,
      }),
      { headers: PAGE_HEADERS },
    );
  }

  async function decideConfirmation(request: Request, u: Urls, id: string): Promise<Response> {
    // Same CSRF defenses as the consent form: same origin + a signed, user-bound token.
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== u.origin) return errorPage("Request blocked.", 403, "Request blocked");
    const form = new URLSearchParams(await request.text());
    const token = await verifyPayload<ConfirmPayload>(secret, form.get("confirm_token") ?? "");
    if (!token || token.k !== "confirm" || token.id !== id || token.exp < now()) {
      return errorPage("This approval page has expired. Ask your agent to try again.", 400, "Page expired");
    }
    const user = await identity.getUser(request);
    if (!user || user.id !== token.u) return errorPage("You're signed in as a different user.", 403, "Wrong account");
    const found = await confirmationFor(id, user, request);
    if (found instanceof Response) return found;

    const approve = form.get("decision") === "allow";
    if (await store.decideConfirmation(id, approve ? "approved" : "denied", now())) {
      await options.emit({
        type: "confirmation.decided",
        ...grantEvent(found.grant),
        tool: found.confirmation.tool,
        summary: found.confirmation.summary,
        approved: approve,
      });
    }
    const agent = found.confirmation.clientName;
    return approve
      ? done("Approved", `Go back to ${agent}. It can now finish: ${found.confirmation.summary}.`)
      : done("Declined", `${agent} won't do this. You can close this page.`);
  }

  function done(heading: string, message: string): Response {
    return new Response(renderDonePage(appName, heading, message), { headers: PAGE_HEADERS });
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
    const isResourceMetadata = RESOURCE_METADATA_PATHS(basePath).includes(pathname);
    const isMetadata = isResourceMetadata || AUTH_SERVER_METADATA_PATHS(basePath).includes(pathname);

    const confirmPrefix = `${basePath}/confirm/`;
    if (pathname.startsWith(confirmPrefix)) {
      const id = pathname.slice(confirmPrefix.length);
      if (method === "GET") return showConfirmation(request, u, id);
      if (method === "POST") return decideConfirmation(request, u, id);
      return methodNotAllowed();
    }
    const isApi = [`${basePath}/oauth/token`, `${basePath}/oauth/register`, `${basePath}/oauth/revoke`].includes(pathname);

    // Browser-based agents call metadata and token endpoints cross-origin. They carry no cookies.
    if ((isMetadata || isApi) && method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (isMetadata) {
      if (method !== "GET") return methodNotAllowed();
      return isResourceMetadata
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

  function errorPage(message: string, status = 400, heading?: string): Response {
    return new Response(renderErrorPage(appName, message, heading), { status, headers: PAGE_HEADERS });
  }

  return {
    route,
    authenticate,
    insufficientScope,
    confirmationGate,
    grants: {
      /** Agents the user has connected (for a "Connected agents" settings page). */
      list: async (userId: string) => (await store.listGrants(userId)).filter((g) => !g.revokedAt),
      /** Disconnects an agent immediately. Every token issued under the grant stops working. */
      revoke: async (userId: string, grantId: string) => {
        const grant = await store.getGrant(grantId);
        if (grant && grant.userId === userId) await revokeGrant(grantId, "customer");
      },
      /** Changes which tools a connected agent may use. Applies on its next call. */
      setScopes: async (userId: string, grantId: string, scopes: string[]) => {
        const unknown = scopes.filter((s) => !toolsByScope.has(s));
        if (unknown.length > 0) throw new Error(`[usher] Unknown scopes: ${unknown.join(", ")}`);
        const grant = await store.getGrant(grantId);
        if (grant && grant.userId === userId && !grant.revokedAt) await setGrantScopes(grant, [...new Set(scopes)]);
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

/** Where protected-resource metadata (RFC 9728) is served. */
export const RESOURCE_METADATA_PATHS = (basePath: string) => [
  `/.well-known/oauth-protected-resource${basePath}/mcp`,
  "/.well-known/oauth-protected-resource",
];

/**
 * Where authorization-server metadata (RFC 8414) is served. It must live at
 * the origin's /.well-known: MCP clients only look under the issuer's path
 * for OpenID Connect discovery, which needs ID-token signing keys Usher
 * doesn't have (ADR 0008).
 */
export const AUTH_SERVER_METADATA_PATHS = (basePath: string) => [`/.well-known/oauth-authorization-server${basePath}`];
