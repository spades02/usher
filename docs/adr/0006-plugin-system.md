# ADR 0006 — Plugin system: fixed hook points in one call pipeline, restrict-only

- **Status:** Accepted
- **Date:** 2026-11-20
- **Phase:** 5

## Context

Every app needs things Usher's core shouldn't hard-code:

- an **audit log**, written to *their* database or SIEM
- **rate limits**, so one runaway agent can't hammer the app
- a **kill switch**, to stop agent traffic during an incident
- their own rules: business hours, fraud scores, plan limits

Better Auth's success comes largely from its plugin model. The product is a
small core plus composable extensions, and our thesis (ADR 0001) is to be
"Better Auth for agent access".

Two constraints come from earlier phases:

1. **Security checks must not be weakened by extensions.** Scope
   enforcement (ADR 0005), confirmation and the error boundary (ADR 0003)
   are the product. A badly written plugin must not be able to skip them.
2. **Logic must not live in a protocol surface.** Until now, the tool
   execution logic (permission check, handler, error mapping) lived inside
   the MCP surface. WebMCP (ADR 0002) would have had to duplicate it.

## Options considered

### 1. Events only (observe, can't act)
- ✅ Trivially safe: plugins can't affect calls.
- ❌ Rate limits and kill switches need to **stop** calls. That's half the
  use cases.

### 2. Middleware chain around each call (`(ctx, next) => …`, Koa or Express style)
- ✅ Maximally powerful: plugins can change inputs, outputs and ordering.
- ❌ Too powerful. A plugin placed first, or one that forgets
  `await next()`, can skip scope checks, run handlers twice, or swallow
  confirmation. Ordering bugs become security bugs.
- ❌ The types for result-rewriting middleware get complicated fast.

### 3. Fixed hook points in a core-owned pipeline (chosen)
Usher owns the order. Plugins attach to named points with narrow powers:

```text
authenticate → scope check → beforeCall (plugins) → confirmation → handler → onEvent (plugins)
```

- ✅ Plugins can **deny** but never **allow**: they run after the scope
  check and can't skip confirmation.
- ✅ Every call, connection, permission change and approval becomes one
  typed event stream.
- ❌ Plugins can't rewrite inputs or outputs. That's deliberate for now.

## Decision

**Option 3.** A plugin is a plain object:

```ts
interface UsherPlugin {
  id: string;
  beforeCall?(call: CallInfo): PluginDenial | void | Promise<PluginDenial | void>;
  onEvent?(event: UsherEvent): void | Promise<void>;
}

createUsher({
  plugins: [
    auditLog({ sink }),
    rateLimit({ limit: 60, windowSeconds: 60, tools: { refund: { limit: 3, windowSeconds: 3600 } } }),
    killSwitch({ isBlocked: ({ tool }) => flags.isOff(`agents.${tool.name}`) }),
  ],
  ...
});
```

| Area | Choice |
|---|---|
| Pipeline | New `pipeline.ts`, protocol-neutral, owns the order. The MCP surface now only maps `CallResult` → MCP, so WebMCP gets plugins for free |
| Hook order | Scope check → `beforeCall` plugins in array order (first denial wins) → confirmation → handler → `onEvent` |
| Before confirmation | Plugins run *before* an approval link is created, so a rate limit also stops an agent from spamming the customer with links |
| Failure semantics | `beforeCall` throws → call **denied** (fail closed, `code: "unavailable"`, details only in `onError`). `onEvent` throws → reported, call unaffected, later observers still run |
| Events | `call` (outcome, code, duration, inputHash), `grant.created`, `grant.updated`, `grant.revoked` (reason: `customer`, `agent` or `token_replay`), `confirmation.decided` |
| Privacy | Events never contain arguments or results, only a SHA-256 of the canonical input. Plugins see the input in `beforeCall`, and the docs say to treat it as customer data |
| Delivery | `onEvent` is awaited, so a durable audit write completes before the agent gets its answer |
| Startup | Unique non-empty ids, hooks must be functions, at least one hook, and plugin options validated when the plugin is built |
| Agent-facing denial | A tool error with `code`, `message` and `retry_after_seconds`. The model can read it and explain it |

First-party plugins:

| Plugin | What it does |
|---|---|
| `auditLog({ sink, events? })` | Writes events to any `AuditSink`. `memoryAuditSink()` keeps the newest N, with `list({ userId, grantId, type, limit })` for a customer's activity view |
| `rateLimit({ limit, windowSeconds, tools?, store? })` | Fixed-window limits **per grant** (customer + agent), plus optional stricter per-tool limits. The `RateLimitStore` interface is ready for Redis; `memoryRateLimitStore()` is the default |
| `killSwitch({ isBlocked })` | The operator's emergency brake for all calls, one tool or one agent. It can return a message for the agent |

## Why

1. **Restrict-only is the property that matters.** With fixed points
   after the scope check, no plugin, however buggy, can grant access the
   customer didn't give. Middleware can't promise that.
2. **Fail closed for gates, fail open for observers.** A broken rate
   limiter should stop traffic, not wave it through. A broken log shipper
   shouldn't take the app down.
3. **One event stream serves several phases.** The same events feed the
   audit log now, the customer's "activity" page (Phase 8) and the hosted
   dashboard (Phase 10).
4. **Per-grant limits are the fair unit.** Per user would let one agent
   starve the customer's other agents. Per client would let one heavy
   customer of ChatGPT throttle every other customer of ChatGPT.
5. **Moving the pipeline out of the MCP surface** finishes what ADR 0002
   promised: the surfaces are thin protocol adapters.

## Trade-offs

| We give up | Impact | Mitigation |
|---|---|---|
| Input/output rewriting (redaction, enrichment) | Plugins can't change what handlers receive or return | Do it in the handler. Add an explicit, typed `transformResult` hook later if real demand appears |
| Non-blocking event delivery | A slow `onEvent` adds latency to every call | Sinks should buffer. A batched async sink helper is planned with the Phase 6 storage adapters |
| Plugin-owned HTTP routes and DB schema (Better Auth has both) | Plugins can't add endpoints or tables yet | Phase 6 (schema and migrations) and Phase 7 (routing) are the right places |
| Exact rate limits across instances | `memoryRateLimitStore` counts per process | The `RateLimitStore` interface matches Redis `INCR` + `EXPIRE`. Phase 6 adapter |
| A fixed window, not a sliding one | Up to 2× bursts at window edges | Simple and cheap. A sliding-window store can implement the same interface |
| Input hashes, not inputs, in the log | Logs prove *that* something happened, not *with what* | Deliberate (data minimization). An app that must log arguments can do it in its own `beforeCall` plugin |
| Validated output in events | A `success` event is recorded before the SDK validates output against `outputSchema` | Output mismatches are developer bugs caught in tests. Revisit if surfaces start validating themselves |

## What was built in this phase

```text
src/pipeline.ts           Protocol-neutral pipeline: scope → plugins → confirmation → handler → events
src/plugins/types.ts      UsherPlugin, CallInfo, PluginDenial, UsherEvent, definePlugin, startup validation
src/plugins/audit-log.ts  auditLog + memoryAuditSink
src/plugins/rate-limit.ts rateLimit + RateLimitStore + memoryRateLimitStore
src/plugins/kill-switch.ts killSwitch
```

- `surfaces/mcp.ts` maps `CallResult` to MCP and no longer contains any
  business logic.
- `auth/server.ts` emits grant and confirmation events. All revocations go
  through one function, so every one is recorded with a reason.
- `createUsher` accepts `plugins`, and `onError` now reports
  `{ tool?, plugin? }`.
- Tests (95 total, 15 new):
  - **Audit log:** a full lifecycle audit, ten events in order, with no
    arguments leaked. Also revocation reasons, filters, the size cap and
    query order.
  - **Plugin contract:** `CallInfo` contents; plugins run after the scope
    check; first denial wins, before any approval link; fail closed on
    crash; observer isolation; startup rejection.
  - **Rate limit:** per-grant budgets, per-tool limits, counting
    approval-link requests, window reset.
  - **Kill switch:** per tool and global, with a custom message.
  - **Pipeline, called directly:** its own scope check (defense in depth)
    and fail closed when the confirmation store errors.
  - **Mutation-checked.** These changes were made one at a time, and tests
    failed each time: plugin crash failing open, plugins before the scope
    check, confirmation before plugins, and observer crashes not isolated.

## Revisit when

- Developers ask to redact or enrich results → add a typed `transformResult`
  hook that runs after the handler and before the surface, still unable to
  affect authorization.
- Phase 6 → durable `AuditSink` and `RateLimitStore` adapters, and
  plugin-declared schema.
- Phase 7 → plugin-declared HTTP routes (for example, an activity feed
  endpoint).
