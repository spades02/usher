# ADR 0002 — Protocol surface: remote MCP first, behind a protocol-neutral tool model

- **Status:** Accepted
- **Date:** 2026-11-19
- **Phase:** 1

## Context

Usher's job is to let a customer's *own* agent act inside a business's app.
The first technical question is **what protocol agents use to reach the
app**. Whatever we pick is the thing ChatGPT, Claude, Gemini, Cursor and others
must already speak, because we cannot ship code into those agents.

What the landscape looks like in November 2026:

- **MCP (Model Context Protocol)** is the de facto standard for agents calling
  external tools. ChatGPT, Claude and Cursor connect to *remote* MCP servers over
  HTTPS. The **2026-07-28** revision made the core stateless: no `initialize`
  handshake, no `Mcp-Session-Id`, each request carries its own version and
  capabilities in `_meta`, plus `Mcp-Method`/`Mcp-Name` headers.
  **Most deployed clients still speak the 2025 revisions**, with the handshake.
- **WebMCP** lets a web page expose tools to an agent *inside the browser*
  (`document.modelContext`, formerly `navigator.modelContext`). It's in a
  Chrome origin trial (149–156). Its API names moved this year, and mainstream
  agent adoption is minimal.
- **OpenAPI / "Actions"** style REST descriptions still work for some agents but
  are a legacy path; the major clients have converged on MCP.
- **A2A (Agent-to-Agent)** targets agents delegating to other *agents*, not
  agents calling an app's tools.

## Options considered

### 1. Remote MCP only, coded directly against MCP types
- ✅ Simplest; reaches every major agent today.
- ❌ MCP concepts would leak into every tool, so adding WebMCP or the next
  protocol means rewriting the business's tool definitions.

### 2. WebMCP only
- ✅ Elegant: the user's in-browser agent reuses the logged-in session, so
  there's no OAuth flow at all.
- ❌ Origin-trial-only, API still moving, few agents call it. Only works while
  the user has the site open in a supporting browser. Doesn't help mobile apps
  (Flutter, native) at all.

### 3. OpenAPI / REST description
- ✅ Every backend already has an HTTP API.
- ❌ Not what modern agents prefer. No standard consent or auth discovery for
  agents. Encourages exposing raw CRUD instead of intent-level tools.

### 4. A protocol-neutral tool model, projected onto surfaces: remote MCP now, WebMCP later
Tools are defined once in Usher's own shape (`defineTool`). Each protocol is a
thin *surface* adapter that projects those tools onto the wire.

## Decision

**Option 4.** Usher tools are protocol-neutral. The first and only surface in
v0 is **remote MCP over Streamable HTTP**, served **statelessly for both
protocol eras** (2026-07-28 and 2025-era) from one handler. A WebMCP surface is
planned once the spec settles and agents adopt it.

Implementation sub-decision: **build on the official TypeScript SDK v2
(`@modelcontextprotocol/server`)** rather than implementing the wire protocol
ourselves. Its `createMcpHandler` is a web-standard `Request -> Response`
handler that already does era detection, header validation, `server/discover`,
and stateless serving of legacy traffic.

## Why

1. **Reach today.** Remote MCP is the only protocol every major agent speaks
   right now. That's what makes the MVP criterion (ADR 0001) achievable.
2. **Dual-era is mandatory, not optional.** A modern-only server would turn
   away most deployed clients. A legacy-only server would be obsolete within
   months. One handler serving both is the only safe position during the
   transition.
3. **Stateless fits Usher.** Without sessions, any instance can answer any
   request. This works on serverless and edge (Vercel, Workers) and in
   horizontally scaled Node, which keeps Phase 7's runtime options open.
4. **Neutral tools protect the business's investment.** The developer's code is
   `defineTool({ name, description, input, handler })`. If WebMCP or another
   protocol takes off, we add a surface and their tools work there unchanged.
5. **The official SDK carries the spec churn.** MCP just made its largest
   revision ever. Tracking header rules, error-code renumbering and era
   negotiation is a full-time job that the SDK maintainers already do.

## Trade-offs

| We give up | Impact | Mitigation |
|---|---|---|
| WebMCP's no-OAuth, in-browser elegance | Users must connect their agent through an OAuth flow (Phase 3) | WebMCP surface later, reusing the same tools |
| Full control of the wire layer | We depend on SDK v2's release cadence and bugs | Pin exact versions. All MCP coupling lives in `src/surfaces/mcp.ts`. Integration tests run real SDK clients and raw wire requests for both eras |
| Lowest-common-denominator features | Neutral tools can't express every MCP feature (resources, prompts, tasks, input-required round trips) | Add them to the neutral model only when there's a real use case. Surfaces may expose protocol-specific extras explicitly |
| Server push | Stateless serving means no long-lived per-client state | `subscriptions/listen` is available through the SDK's event bus if a use case appears |
| Mobile and native apps aren't a "surface" | Flutter or iOS apps don't host MCP | They don't need to: their *backend* runs Usher. The app only shows the "Connect your agent" UI (Phase 8) |

## What was built in this phase

- `packages/core` (`usherjs`), using a provisional pnpm workspace that Phase 9
  will formalize.
- `defineTool` / `UsherTool`: a protocol-neutral tool model (a Zod input schema,
  a read-only hint and a handler). Its final shape is Phase 2's decision.
- `createUsher({ app, tools })`: a web-standard `handler(Request)` that
  mounts `POST {basePath}/mcp`.
- MCP surface: the SDK v2 `createMcpHandler` with `legacy: "stateless"`, a
  fresh server per request, and in-band `isError` results that never leak
  stack traces.
- Origin validation (required by the MCP transport spec): requests with no
  Origin (server-side agents) or the app's own origin pass. Others must be
  allowlisted, or they get `403`.
- Tests for: the official SDK client end to end, the 2025-era `initialize`
  flow with no session id, the 2026-07-28 `server/discover` and handshake-free
  `tools/call`, header/body mismatch → `400`, origin enforcement, routing, and
  duplicate tool names.

**Not yet secure for production.** Any caller can invoke any tool. Agent
authentication and per-user identity are Phase 3; scopes are Phase 4.

## Revisit when

- WebMCP ships outside an origin trial and at least one major agent calls it →
  add the WebMCP surface.
- 2025-era traffic drops to negligible → switch to `legacy: "reject"` and
  delete the fallback path.
- The SDK becomes a blocker (bundle size on edge, bugs, release lag) →
  replace the internals of `surfaces/mcp.ts` only.
