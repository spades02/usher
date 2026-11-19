# ADR 0008: Runtime and deployment. One web-standard handler, thin zero-dependency adapters, and a standalone server for apps not written in JS

- **Status:** Accepted
- **Date:** 2026-11-20
- **Phase:** 7

## Context

Usher is a library that runs inside the app's process (ADR 0001). It
exposes one `handler(Request) → Response`. Phase 7 decides how that
handler reaches real deployments. Three things decide whether an agent can
connect at all:

1. **Routing.** Agents find the server through fixed URLs at the origin root
   (`/.well-known/oauth-protected-resource/...` from RFC 9728 and
   `/.well-known/oauth-authorization-server/...` from RFC 8414). The MCP and
   OAuth endpoints live under `basePath`. If any of these is missing, the
   agent fails at "connect" with an opaque error.
2. **Runtimes differ.** Next.js, SvelteKit, Hono, Bun, Deno and Workers speak
   `Request → Response`. Express, Fastify, Koa and NestJS speak Node's
   `(req, res)`, often with a body parser that has already read the stream.
   Some of them also strip the mount path from `req.url`. Reverse proxies
   change the origin the app sees.
3. **Many apps aren't JavaScript.** A Rails, Django, Laravel or Go app has
   the tools and the login, but can't `import` Usher.

## Options considered

### 1. One package per framework (`@usher/next`, `@usher/express`...)
- ✅ Each one feels native.
- ❌ N packages to version and release. Most would be three lines around
  `handler`, and the fixed `/.well-known` paths make them all equally
  awkward.

### 2. A hosted proxy that sits in front of the app
- ✅ Nothing to install.
- ❌ It contradicts ADR 0001: customers' tokens and approvals would live on
  Usher's servers, and the app's session cookie wouldn't reach it on its
  own domain.

### 3. A web-standard core with thin, structural adapters, plus a standalone server built from the same core (chosen)
- ✅ The core stays runtime-neutral, and adapters are pure functions with no
  framework imports and no dependencies.
- ✅ Apps not written in JS run the *same* Usher as a separate process, using
  HTTP for identity and webhooks for tools. There's no second
  implementation.
- ❌ File-routed frameworks need two route files, not one (see trade-offs).

## Decision

**Option 3.**

| Runtime | Mount |
|---|---|
| Next.js (App Router) | `app/api/usher/[...usher]/route.ts` and `app/.well-known/[...usher]/route.ts`, each `export const { GET, POST, OPTIONS, DELETE } = toRouteHandlers(usher)` |
| SvelteKit, Astro, Remix / React Router, SolidStart, TanStack Start | The same two routes. `toRouteHandlers` accepts either a `Request` or an event with `.request` |
| Hono, Elysia, Bun.serve, Deno.serve, Cloudflare Workers | `app.all("*", (c) => usher.matches(path) ? usher.handler(c.req.raw) : next())`, or pass `usher.handler` directly |
| Express, Connect, Polka, NestJS, bare `http` | `app.use(toNodeHandler(usher))` from `usherjs/node`, once at the root. It serves Usher's paths and calls `next()` for everything else |
| Fastify, Koa | `toNodeHandler(usher)(request.raw, reply.raw)` / `(ctx.req, ctx.res)` |
| Rails, Django, Laravel, Go, .NET... | `npx usherjs serve usher.config.json` behind the app's reverse proxy |

### Core

- `usher.matches(pathname)` is the single source of truth for which paths
  Usher owns: `{basePath}/*` plus its exact `/.well-known` documents. Other
  `/.well-known` files (Apple, Android, security.txt) are never claimed.
- Browser `Origin` checks compare against `baseUrl` when set. Behind a
  proxy, the request URL's origin is the internal one, and comparing against
  it would block the real consent page.

### `usherjs/node`

- Rebuilds the URL from `originalUrl`, so it works under `app.use("/api/usher", …)`.
- Reads the raw body when the stream is unread. If `express.json()` or
  `express.urlencoded()` already consumed it, it re-encodes the parsed
  `req.body`. Both orderings work.
- Trusts `X-Forwarded-Proto` / `X-Forwarded-Host` only with
  `trustProxy: true`. Setting `baseUrl` remains the robust option.
- Streams responses chunk by chunk with backpressure, since SSE must not be
  buffered. It aborts the request when the agent disconnects, so the tool's
  `signal` fires in both 2025 (SSE) and 2026 (JSON) modes.

### Standalone server (`usherjs serve`, `usherjs/standalone`)

The app keeps its logic and its login. It exposes two kinds of endpoint:

```json
{
  "app": { "name": "Rails Shop", "version": "2.0.0" },
  "baseUrl": "https://shop.example",
  "secret": "env:USHER_SECRET",
  "database": "env:DATABASE_URL",
  "identity": {
    "sessionUrl": "http://rails:3000/usher/session",
    "loginUrl": "https://shop.example/login?next={returnTo}"
  },
  "webhookSecret": "env:USHER_WEBHOOK_SECRET",
  "adminToken": "env:USHER_ADMIN_TOKEN",
  "tools": [{
    "name": "cancel_order", "description": "Cancel an order.", "effect": "destructive",
    "confirm": "Cancel order {orderId}",
    "input": { "type": "object", "properties": { "orderId": { "type": "string" } }, "required": ["orderId"] },
    "url": "http://rails:3000/usher/hooks/cancel_order"
  }]
}
```

| Piece | Choice |
|---|---|
| Identity | `httpIdentity`: forwards the browser's `Cookie`/`Authorization` to `sessionUrl`. `200 {id, name?, email?}` means signed in, `401` means signed out. If there's no credential at all, the app is never called. The proxy serves Usher on the app's own domain, so the session cookie arrives |
| Tools | `webhookTool`: each call is a POST of `{tool, input, user, agent}`. `2xx` JSON is the result. A `4xx` `{error, code?}` is a business failure the agent sees. A `5xx`, a timeout or a redirect is a generic failure, and the details go to `onError` only |
| Signatures | `Usher-Signature: t=<unix>,v1=<hex HMAC-SHA256("t.body")>`, the Stripe scheme, which every language can verify with its standard HMAC. A 5-minute tolerance limits replay. `verifyWebhook()` is exported for JS receivers |
| Schemas | Tools declare plain JSON Schema. Agents see it verbatim, and Usher validates against it (through zod's `fromJSONSchema`) before any webhook fires |
| Guardrails | Everything from Phases 3–6 applies unchanged: per-tool consent, step-up, approvals on the app's domain, audit log, rate limit and durable SQL storage (`sqlite:` or `postgres://`). Expired rows are pruned hourly |
| Admin API | `GET/DELETE/PUT {basePath}/admin/users/:id/grants…` and `/events`, guarded by a bearer `adminToken`. This lets the app's backend build a "Connected agents" page in any language |
| Secrets | `"env:NAME"` values resolve from the environment. A missing variable fails at boot |

### `usherjs doctor <url>`

`checkDeployment()` checks a live deployment the way an agent sees it:

- HTTPS;
- both metadata documents, including whether their `resource` and `issuer`
  match the public origin;
- the MCP endpoint's `401` challenge.

Each failure names the route to add, or says to set `baseUrl`.

## Why

1. **Routing is the real integration work, so it's centralized.** `matches()`
   is used by every adapter, and `doctor` checks the result from the outside.
   That moves the most common failure ("agent can't connect") from a
   support thread to a one-line message.
2. **Structural adapters don't rot.** `toNodeHandler` types `req`/`res` by
   the members it uses, and `toRouteHandlers` duck-types the input. No
   Express, Next or SvelteKit types are imported, so framework majors can't
   break us, and the main entry stays free of `node:` imports. It still runs
   on edge runtimes.
3. **The standalone server is the same Usher, not a port of it.** It's
   `createUsher` + `httpIdentity` + `webhookTool` + `sqlStorage` +
   `toNodeHandler`. Every security property tested in Phases 3–6 holds for
   non-JS apps by construction. The fixes go to one place.
4. **Webhooks are what every backend already knows.** HMAC-signed POSTs with
   Stripe-style headers need no SDK. A Rails controller or a Django view is
   the whole integration.
5. **Tested on the real runtimes.** Express 5 runs with and without body
   parsers, under mount paths, behind a simulated TLS proxy. A real
   `http.Server` checks disconnect handling. A real "non-JS app" server
   exercises sessions and signature checks.

## Trade-offs

| We give up | Impact | Mitigation |
|---|---|---|
| A single route for file-routed frameworks | Next.js and others need a second file at `app/.well-known/[...usher]` | MCP clients only look under the issuer's path for *OpenID Connect* discovery, which requires ID-token signing keys Usher doesn't have. Faking an OIDC provider would be worse. Middleware-style adapters (Node, Hono, Bun) need one mount. `doctor` names the missing route |
| Framework-native packages | No `@usher/next` with framework-specific sugar | Each mount is one or two lines. Packages can wrap these helpers later without new behavior |
| Webhook latency (standalone) | Each tool call adds one HTTP hop to the app | Keep Usher next to the app (same host or cluster). Timeouts are per tool |
| Webhook replay within 5 minutes | A captured, still-fresh request could be resent to the app | It's signed, sent over the internal network, and `idempotent`-marked tools are safe to repeat. Receivers can deduplicate on the signature |
| `zod` at runtime for the standalone server | JSON Schema validation relies on zod's semi-experimental `fromJSONSchema` | Only the standalone server uses it. The schema agents see is the app's original, and webhooks should validate too |
| The standalone server owns the session check | A slow session endpoint slows the consent and approval pages | A 5-second timeout. The endpoint is a cookie lookup in the app |
| No serverless-specific packaging | No Lambda or Vercel templates yet | The fetch handler runs on them unchanged. Templates come with the docs site (Phase 10) |

## What was built in this phase

```text
src/route-handlers.ts   toRouteHandlers(usher): GET/POST/OPTIONS/DELETE for file-routed frameworks
src/node.ts             usherjs/node: toNodeHandler(usher, { trustProxy })
src/remote.ts           httpIdentity, webhookTool, verifyWebhook
src/standalone.ts       usherjs/standalone: createStandaloneServer, serveFromFile, jsonSchema, resolveEnv
src/doctor.ts           checkDeployment; `usherjs doctor <url>`
```

- `Usher` gains `matches(pathname)` and `basePath`. Origin checks use
  `baseUrl`.
- The CLI gains `serve` and `doctor`.
- `package.json` gains the `usherjs/node` and `usherjs/standalone` subpaths.
- Tests (157 total, 19 new):
  - **File-routed:** two routes are enough for a full SDK-client connect.
  - **`doctor`:** it detects a missing `/.well-known` mount, a leaked internal
    `baseUrl` and plain HTTP, and confirms a good deployment.
  - **Express 5:** a root mount after `express.json()` / `urlencoded()`
    (consent and token posts re-encoded), mount paths via `originalUrl`, and
    pass-through to app routes.
  - **Bare `http`:** 404 for paths Usher doesn't own. `X-Forwarded-*` is
    honored only with `trustProxy`. Origin is checked against `baseUrl`
    behind a proxy.
  - **Disconnects:** they abort the tool's signal in both 2025 SSE and 2026
    JSON modes.
  - **Standalone, against a fake non-JS app:**
    - connect with the app's login, and signed webhook calls;
    - destructive tools wait for approval on the app's domain and run once;
    - 4xx messages reach the agent, while 5xx details don't;
    - input that fails the JSON Schema never reaches the app;
    - signed-out customers are sent to the app's login without a session
      call;
    - the admin API lists, edits and revokes grants, and reads the audit
      trail;
    - a config file with `env:` secrets boots.
  - **Signatures:** tampered bodies, wrong secrets, stale timestamps and
    missing headers are rejected. Plain `node:crypto` HMAC verifies, as any
    language would.
  - **Mutation-checked.** These changes were made one at a time, and tests
    failed each time:
    - ignoring `originalUrl`;
    - ignoring pre-parsed bodies;
    - always trusting forwarded proto or host;
    - not aborting on disconnect;
    - checking Origin against the internal URL;
    - not matching `/.well-known`;
    - accepting stale webhooks;
    - hiding 4xx, or leaking 5xx;
    - an unauthenticated admin API;
    - calling the session endpoint without credentials.

## Revisit when

- MCP clients discover OAuth metadata under the issuer path without OIDC →
  drop the second route for file-routed frameworks.
- Design partners ask for a Python or Ruby SDK → generate a webhook
  receiver library from the same contract.
- Standalone latency matters → add batched or streaming webhooks, or a
  Unix-socket transport.
- Phase 10 → deployment templates (Vercel, Fly, Docker image for `usherjs serve`).
