# ADR 0003 — Tool definition model: code-first, schema-library-neutral, effect-declared

- **Status:** Accepted
- **Date:** 2026-11-19
- **Phase:** 2

## Context

A *tool* is the unit of everything Usher does. It's what the agent sees, what
the customer consents to (Phase 3), what scopes guard (Phase 4), and what the
audit log records (Phase 5). How developers *define* tools is the API they
touch every day, so it decides whether Usher feels like Better Auth or like a
chore.

Forces:

- **Agents perform best with a few intent-level tools** ("cancel my order")
  rather than hundreds of raw CRUD endpoints. Every extra tool costs model
  context and raises the chance of a wrong call.
- **Tools run the business's real logic.** They must reuse the app's
  services, validation, and transactions.
- **Safety is part of the definition.** Whether a tool reads, writes, or
  destroys decides whether the agent needs confirmation. A forgotten flag must
  not silently mean "safe".
- **The ecosystem is split across schema libraries:** Zod, Valibot, ArkType,
  Effect Schema. Standard Schema (a cross-library interface), plus its
  Standard JSON Schema extension, now lets one API accept any of them. The
  MCP SDK v2 already accepts exactly that.
- **Third-party agents are untrusted readers.** Error messages and results go
  to an external AI provider's servers.

## Options considered

### 1. Auto-generate tools from the app's OpenAPI spec at runtime
- ✅ Zero code; instant coverage of the whole API.
- ❌ Produces CRUD-shaped, endpoint-per-tool sprawl that agents handle poorly.
- ❌ Descriptions are written for developers, not models.
- ❌ Easy to accidentally expose an internal or admin endpoint to every agent.
- ❌ Calls go back over HTTP, so the app's in-process auth context is lost.

### 2. Decorators or annotations on existing route handlers
- ✅ Minimal duplication for frameworks built on classes (NestJS).
- ❌ TypeScript decorators tie us to class-based frameworks. Most Next.js and
  Hono apps are functional.
- ❌ Still endpoint-shaped rather than intent-shaped.

### 3. Declarative config (YAML or dashboard) mapping tools to HTTP calls
- ✅ Non-developers can edit it; a natural fit for a hosted product.
- ❌ No type safety, and logic gets split between config and code.
- ❌ Conflicts with ADR 0001: the library runs in-process and owns no
  dashboard yet.

### 4. Code-first `defineTool()` with typed schemas
A plain object (name, description, input/output schema, effect, handler)
next to the app's code. The handler is an ordinary function.

## Decision

**Option 4**, with four specific sub-decisions:

1. **Schema-library neutral.** `input`/`output` accept any schema
   implementing *Standard Schema + Standard JSON Schema* (Zod ≥ 4.2,
   ArkType, Valibot via `toStandardJsonSchema`, or hand-written). Zod is
   only a peer dependency, used in docs and examples.
2. **A required, single `effect` field: `read | write | destructive`.** It
   maps to MCP's `readOnlyHint` / `destructiveHint` / `idempotentHint`. There
   is no default, so the developer must decide. It becomes the input to
   Phase 4's confirmation rules.
3. **Explicit error boundary.** `throw new ToolError(msg, { code })` is the
   only way a message reaches the agent. Any other thrown error becomes a
   generic message, and the real error goes to `onError`.
4. **Fail at startup, not at the first call.** Duplicate or invalid names,
   empty descriptions, a missing effect, non-object schemas and unsupported
   schema objects all throw when `createUsher()` runs.

OpenAPI isn't rejected outright. It becomes a future **codegen** command
(`usher import openapi`) that *scaffolds* `defineTool` stubs once, for a human
to curate. It's never a runtime auto-exposure.

## The resulting API

```ts
import { defineTool, ToolError } from "usherjs";
import { z } from "zod";

export const cancelOrder = defineTool({
  name: "cancel_order",
  description: "Cancel one of the customer's orders that hasn't shipped yet.",
  input: z.object({ orderId: z.string() }),
  output: z.object({ cancelled: z.string() }),   // optional; enables typed results
  effect: "destructive",                          // required
  idempotent: true,                               // optional; lets agents retry safely
  async handler({ orderId }, { request, signal }) { // input fully typed
    const order = await db.orders.find(orderId, { signal });
    if (!order) throw new ToolError("Order not found", { code: "not_found" });
    if (order.shipped) throw new ToolError("Shipped orders can't be cancelled");
    await db.orders.cancel(orderId);
    return { cancelled: orderId };                // checked against `output`
  },
});
```

## Why

1. **Intent-level tools need human authorship.** The single biggest factor in
   agent success is a small set of well-named, well-described tools.
   Code-first makes curation the default; generators make sprawl the default.
2. **In-process handlers keep the app's context.** They call the same
   services, ORM and transactions as the app, which Phase 3 extends with the
   authenticated customer.
3. **Standard Schema avoids locking in a library** at no cost: Zod users see
   no difference, and everyone else isn't forced to adopt Zod. The SDK accepts
   the same interface, so there's no conversion layer to maintain.
4. **A required `effect` is a safety affordance.** MCP's hints are four
   optional booleans whose defaults are permissive. One required field with
   three meaningful values is harder to get wrong, and it's exactly what
   consent screens and confirmation rules need.
5. **Opt-in error disclosure** matches the threat model. Results flow to a
   third-party AI provider, so "safe by default, explicit to reveal" is the
   only defensible stance.

## Trade-offs

| We give up | Impact | Mitigation |
|---|---|---|
| Zero-code onboarding | A developer must write each tool | Tools are short. Future `usher import openapi` scaffolds stubs. The MVP target is 3 tools in 15 minutes |
| Full MCP hint expressiveness | `openWorldHint` is fixed to `false`, and the hints can't be set independently | Matches Usher's domain (an app's own data). Add an override only if a real case appears |
| Required `effect` adds friction | One more field on every tool | It's one word, and it's the input to the consent and confirmation UX |
| Zod-specific niceties in core | We only use the standard interfaces | Libraries keep their own ergonomics; Usher stays out of the way |
| Raw error visibility for agents | Agents can't self-diagnose unexpected failures | `onError` hook for the developer. `ToolError` codes give agents something machine-readable to branch on |
| Non-object input or output | Tools can't take or return bare arrays or primitives | Required by MCP for input, and by 2025-era clients for structured output. Wrap them, e.g. `{ items: [...] }` |

## What was built in this phase

- `src/schema.ts`: the `UsherSchema` type, copied from the Standard Schema and
  Standard JSON Schema specs so the public API has no library or SDK type
  dependency.
- `src/tool.ts`: the final `defineTool` shape (`effect`, `idempotent`,
  `output`, a `signal` in the context, inferred handler types) and startup
  validation.
- `src/errors.ts`: `ToolError`, plus a generic fallback message.
- `src/surfaces/mcp.ts`: maps `effect` → MCP annotations, passes
  `outputSchema` through (the SDK validates results against it), wires the
  abort signal, and applies the error boundary. Adds the `onError` option on
  `createUsher`.
- Tests: startup rejections; a hand-rolled non-Zod schema served end to end;
  compile-time checks on handler input and output types; `ToolError` codes
  reach the agent; internal errors (`db.internal:5432`) do *not*; invalid
  input is rejected before the handler runs.

## Revisit when

- Design partners routinely have 50+ endpoints and ask for generation → build
  `usher import openapi` (codegen, never runtime).
- MCP adds hints that matter to Usher's domain → extend `effect` or add an
  explicit override.
- A popular schema library lacks Standard JSON Schema support → ship a small
  adapter package rather than special-casing it in core.
