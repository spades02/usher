# ADR 0004 — Agent auth & consent: an embedded OAuth 2.1 server bridged to the app's existing login

- **Status:** Accepted
- **Date:** 2026-11-19
- **Phase:** 3

## Context

Until now, anyone who could reach `/api/usher/mcp` could call every tool.
Phase 3 answers three questions:

1. **Who is the customer?** The agent acts *for* a specific customer of the
   app, and every tool call must be scoped to that customer.
2. **Which agent is it?** The customer should know what they're connecting
   ("ChatGPT", verified as `chatgpt.com`) and be able to disconnect it.
3. **Did the customer agree?** A real person must explicitly approve each
   agent before it gets access.

The MCP spec (2026-07-28) prescribes the mechanism: **OAuth 2.1**.
- **Discovery.** The MCP server is a *resource server* that publishes
  Protected Resource Metadata (RFC 9728). A 401 points agents there. That
  document names an *authorization server* (RFC 8414 metadata).
- **Login protections.** PKCE S256 is mandatory. The `resource` parameter
  (RFC 8707) binds each token to one endpoint. The `iss` parameter (RFC 9207)
  defends against mix-up attacks.
- **Client registration.** **Client ID Metadata Documents (CIMD)** are now
  preferred: the agent's `client_id` is an HTTPS URL hosting its metadata.
  Dynamic Client Registration (DCR, RFC 7591) is deprecated, but 2025-era
  agents still use it.

The constraint from ADR 0001: Usher runs *inside* the app and must bridge to
**whatever auth the app already has** (Better Auth, Clerk, Supabase, Auth.js,
or custom sessions). It must never replace that auth.

## Options considered

### 1. Personal access tokens: the customer pastes a key into the agent
- ✅ Trivial to build; works with any agent that accepts headers.
- ❌ Not what MCP clients do. ChatGPT and Claude expect OAuth discovery.
- ❌ There's no consent screen. Keys are long-lived and get copy-pasted into
  chats and screenshots.

### 2. Resource server only: delegate to an external authorization server
Usher only validates tokens. The app's identity provider (Auth0, WorkOS,
Clerk, Better Auth's OAuth provider plugin) issues them.
- ✅ No authorization-server code in Usher, and enterprise IdP features for free.
- ❌ Most apps *don't have* an OAuth server, only session-based login. This
  would block exactly the indie and SaaS developers we target.
- ❌ CIMD, the `resource` parameter and `iss` support vary widely across
  IdPs. Many don't support CIMD yet.
- ❌ The consent screen can't show the tools and their effects, because the
  IdP doesn't know Usher's tools.

### 3. Embedded authorization server, with login delegated to the app
Usher implements the OAuth endpoints itself. For "who is signed in?" it asks
the app through a two-method `identity` adapter.

### 4. Option 3 now; option 2 as a later alternative
Ship the embedded server as the default, and keep the token check behind an
interface so an external IdP can be plugged in later.

## Decision

**Option 4, with option 3 as the default implementation.**

```ts
createUsher({
  identity: {
    getUser: (request) => getSessionUser(request), // the app's existing auth
    loginUrl: (returnTo) => `/login?next=${encodeURIComponent(returnTo)}`,
  },
  secret: process.env.USHER_SECRET,
  baseUrl: "https://shop.example",
  ...
});
```

Specifics:

| Area | Choice |
|---|---|
| Client identity | **CIMD first** (the domain is a verifiable identity, shown on the consent screen). **DCR on by default** for 2025-era agents, can be turned off, and DCR agents are labelled *"self-declared, couldn't be verified"* |
| Client type | Public clients only (`token_endpoint_auth_method: none`) + mandatory PKCE S256 |
| Tokens | **Opaque random tokens, stored only as SHA-256 hashes.** Access tokens last 1 hour. Refresh tokens last 30 days and **rotate on every use** |
| Revocation model | Every token belongs to a **grant** (one customer + one agent). Revoking the grant kills every token instantly. That's the "disconnect" button |
| Replay defense | A reused authorization code, or a reused already-rotated refresh token, **revokes the whole grant** |
| Audience | Tokens are bound to `{baseUrl}{basePath}/mcp`. `resource` is checked at authorize, token and every request |
| Consent | A server-rendered page: agent name, verified domain, signed-in user, tools grouped by effect (*View / Make changes / Irreversible actions*), warnings for loopback or app-scheme redirects. It can't be framed and isn't cached |
| CSRF on consent | The form carries an HMAC-signed token binding user, agent, redirect and PKCE challenge, valid for 10 minutes, plus a same-origin check |
| Repeat connects | An existing active grant skips the consent screen (`prompt=consent` forces it) |
| Tool context | `ctx.user.id` and `ctx.agent` are passed to every handler |

## Why

1. **Reach.** An embedded server works for *every* app with a login form. No
   OAuth infrastructure needed, which is the whole Better Auth thesis.
2. **The consent screen is the product.** Only Usher knows the tools and
   their effects, so only Usher can tell the customer exactly what they're
   allowing. An external IdP would show a generic "access your account".
3. **CIMD gives identity, DCR only gives a name.** With CIMD, "Test Agent" is
   provably served from `agent.example`. A DCR client can call itself
   "ChatGPT". Showing that difference to the customer is cheap and meaningful.
4. **Opaque, hashed tokens beat JWTs here.** Disconnect has to work
   *immediately*, not when a JWT expires. A database leak must not hand out
   working tokens. The cost is one store lookup per call, which is negligible
   next to a tool call.
5. **The adapter boundary keeps Usher out of password and session
   management.** Usher never stores credentials. Login stays with the app's
   own auth system.

## Trade-offs

| We give up | Impact | Mitigation |
|---|---|---|
| Zero security-critical code in Usher | We own an OAuth server, which is a high-stakes surface | Strict spec subset (public clients, S256 only, code flow only). Every security property has a test, and the tests were mutation-checked (disabling PKCE, replay or CSRF checks makes them fail). External security review before 1.0 |
| Enterprise IdP features (SSO policies, MFA step-up) | Not available through the embedded server | They still apply to the *customer's login*, since that's the app's own auth. An external-AS mode later |
| Stateless token checks | Each MCP call does a store lookup | Indexed hash lookups. Phase 6 database adapters; a cache is possible later |
| Fully hardened SSRF defense for CIMD fetches | The host check can't see DNS, so a public name pointing at a private IP gets through | Redirects blocked, 5 s timeout, 64 KB cap, cache. `fetchClientMetadata` can be swapped for a DNS-aware fetch. Documented |
| Root-level routes | `/.well-known/oauth-*` lives outside `basePath`, so developers must route it to the handler | One extra route today. Phase 7's framework adapters will add it automatically |
| Durable state by default | The in-memory store loses grants on restart | Warning in production. Phase 6 database adapters |
| Coarse permissions | A grant currently allows *all* tools | Phase 4: per-tool scopes, step-up via `insufficient_scope`, confirmation for `destructive` tools |
| Deprecated DCR in the codebase | Self-asserted identities and more surface | Labelled as unverified on the consent page. `dynamicClientRegistration: false` turns it off. Remove when 2025-era agents are gone |

## What was built in this phase

```text
src/auth/
  types.ts         IdentityAdapter, UsherUser, Principal
  crypto.ts        Web Crypto only: random tokens, SHA-256, PKCE, HMAC-signed payloads
  store.ts         AuthStore interface (atomic consume for codes and refresh tokens) + memoryStore()
  clients.ts       CIMD resolution (validation, SSRF guards, cache), redirect URI rules, DCR parsing
  consent-page.ts  Consent and error pages: escaped, unframeable, no JS
  server.ts        PRM + AS metadata, authorize (GET/POST), token, register, revoke, bearer check
```

- `createUsher` now requires `identity` and `secret`. It accepts `baseUrl`,
  `store` and `auth.*`, and exposes `usher.grants.list/revoke`.
- Tool handlers receive `ctx.user` and `ctx.agent`.
- Tests (60 total): the full flow with the official SDK OAuth client for both
  CIMD and DCR, including SEP-2352 issuer binding on the client side. Also:
  per-user isolation; login redirect round-trip; consent skip and force;
  deny; open-redirect, PKCE, `resource` and CIMD-mismatch rejections; SSRF
  blocks; CSRF (tampered token, wrong user, cross-site); code replay; refresh
  rotation and reuse detection; expiry; hashed-only storage; grant and
  RFC 7009 revocation; DCR redirect rules; startup checks.

## Revisit when

- Design partners already run an OAuth server (Better Auth OAuth provider,
  WorkOS, Auth0) → build the external authorization-server mode behind the
  same `authenticate` boundary.
- MCP makes CIMD mandatory or 2025-era traffic fades → set
  `dynamicClientRegistration` to false by default, then remove DCR.
- Agents adopt DPoP or other sender-constrained tokens widely → bind tokens
  to client keys instead of bearer.
