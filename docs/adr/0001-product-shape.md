# ADR 0001 — Product shape: open-source library first, hosted control plane later

- **Status:** Accepted
- **Date:** 2026-11-19
- **Phase:** 0

## Context

We are building "Bring Your Own Agent" (BYOA) infrastructure: a business installs
Usher so its customers can use their *own* AI agent against the business's app,
instead of a generic company chatbot.

Earlier we chose **Direction A** — the user's agent comes to the business via
open protocols (MCP) — over Direction B (the user ships a personal-context
profile to the business's bot), because A rides existing standards and never
makes us the custodian of sensitive personal memory.

The question now is **what kind of product Usher is**. That choice shapes trust,
adoption, the business model, and every later architecture decision.

Forces at play:

- **Trust.** An agent acting on a customer's account touches the most sensitive
  data a business has: orders, billing, health records, messages. Businesses are
  cautious about routing that through a third party, especially early.
- **Coupling to existing auth.** Agent access must be tied to the app's *own*
  user accounts and sessions. Consent ("ChatGPT may read your orders") is shown to
  a logged-in user of that app.
- **Coupling to existing business logic.** Tools are the app's own actions. They
  must run with the app's permissions, validation, and database transactions.
- **Competition.** Hosted, paid options already exist (Frontegg AgentLink, Zuplo,
  Truto, Cyclr, Composio). An open, self-hosted library does not, at least not as
  a complete package.
- **Distribution.** Developer tools grow through `npm install`, GitHub stars, and
  docs, not through sales calls.

## Options considered

### 1. Hosted SaaS (the Clerk / Auth0 model)
The business points agents at `usher.cloud`. We host the MCP endpoint, OAuth
server, and audit log, and call back into the business's API.

- ✅ Fastest path to revenue; no infra for the customer; we see all telemetry.
- ❌ Every agent request crosses our infrastructure, which is a major trust and
  compliance hurdle (SOC 2, GDPR, HIPAA, data residency) before anyone adopts it.
- ❌ We must re-implement the app's authorization through webhooks or API keys,
  which is a fragile double source of truth.
- ❌ Head-to-head with funded incumbents on their own turf.

### 2. Gateway / reverse-proxy sidecar (the Zuplo model)
A separate service deployed in front of the app's existing REST API that
translates MCP calls into HTTP calls.

- ✅ Language-agnostic; works with any backend without code changes.
- ❌ Only sees HTTP. It doesn't know the app's users, sessions, or domain rules,
  so consent and per-user scoping end up bolted on.
- ❌ Tool quality is limited by the existing API's shape. Agents work best with
  intent-level tools ("reschedule my appointment"), not raw CRUD endpoints.
- ❌ One more service to deploy and keep running.

### 3. Open-source, in-process library (the Better Auth model)
`npm install usherjs`. Usher runs inside the app's own server, mounts its routes
(`/.well-known/oauth-*`, `/mcp`, consent pages), uses the app's database, and
calls the app's own functions as tools.

- ✅ Data never leaves the business's infrastructure, which removes the biggest
  adoption blocker.
- ✅ Direct access to the app's session and auth, so consent and per-user
  scoping are natural instead of bolted on.
- ✅ Tools are ordinary functions with the app's own validation and transactions.
- ✅ Free adoption loop through open source; it's the gap in the market.
- ❌ Harder to monetize; no central telemetry by default.
- ❌ Only covers the languages we ship a runtime for.

### 4. Open core: option 3 now, with an optional hosted control plane later
The library is the product and fully works on its own. Later we sell an
*optional* hosted dashboard: cross-app analytics, team management, agent
directory listings, managed WebMCP or gateway for non-JS backends.

## Decision

**Option 4 (open core), built as option 3 first.** For the foreseeable future,
Usher is an open-source, in-process TypeScript library. A hosted control plane is
a later phase (Phase 10) and must never be *required*.

Language-agnostic reach (option 2's main strength) is not dropped. It's
deferred: Phase 7 will add a standalone server or Docker mode, built from the
*same core*, for Python, Go, Rails, and other backends.

## Why

1. **Trust decides this market.** Agent access to customer accounts is a
   security-critical surface. "It runs in your app, against your database" is
   the single strongest adoption argument we can make, and hosted competitors
   can't make it.
2. **Consent needs the app's session.** The OAuth consent screen must know
   who is logged in and what they're allowed to do. In-process, that's one
   function call to the existing auth (Better Auth, Clerk, Supabase, NextAuth...).
   From outside, it's a fragile integration.
3. **Better tools.** Agents perform far better with a handful of intent-level
   tools than with a thin wrapper over 200 REST endpoints. Tools are written in the
   app's own code.
4. **Proven playbook.** Better Auth went from zero to millions of weekly
   downloads against hosted incumbents (Auth0, Clerk) using exactly this shape:
   in-process, owns-your-data, plugin-extensible, with a CLI that generates the
   database schema.
5. **Keeps options open.** A library can later grow a hosted control plane. A
   hosted product rarely becomes credibly self-hostable after the fact.

## Trade-offs (what we knowingly give up)

| We give up | Impact | Mitigation |
|---|---|---|
| Fast revenue | No income at launch | Open core: optional hosted dashboard, enterprise support, and a managed gateway later (Phase 10) |
| Non-JS backends at launch | Python/Go/Rails shops can't adopt v0 | Keep the core runtime-portable; ship standalone server mode in Phase 7 |
| Central telemetry | We can't see how Usher is used | Opt-in anonymous telemetry; plugin hooks for the app's own analytics |
| Control over deployments | Security fixes depend on users upgrading | Small, stable core; strict semver; security advisories; a `usher doctor` CLI check |
| Framework sprawl | Next, Express, Hono, Nest, Fastify... each needs an adapter | Build on the web-standard `Request -> Response` interface so most frameworks are thin wrappers |

## Scope boundaries (derived from this decision)

**In scope:** tool definitions, MCP endpoint, agent OAuth and consent, scopes,
confirmations, audit log, rate limits, plugins, database adapters, CLI, and the
"Connect your agent" UI.

**Out of scope:** running LLMs, model routing, hosting chatbots, storing the
customer's personal memory or preferences (that stays with their agent).

## MVP success criterion

> A developer adds Usher to an existing Next.js app, defines three tools, and in
> under 15 minutes a logged-in customer connects Claude or ChatGPT, approves a
> consent screen, and their agent successfully calls those tools, with every call
> visible in an audit log.

## Revisit when

- Most interest comes from non-JS backends, so the standalone gateway should
  come first.
- Design partners consistently refuse to self-host, so hosted should come
  first.
- MCP is displaced by another agent-access standard (re-evaluate in ADR for
  Phase 1).
