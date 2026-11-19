# ADR 0005 — Permission model: per-tool scopes, step-up, and out-of-band confirmation

- **Status:** Accepted
- **Date:** 2026-11-20
- **Phase:** 4

## Context

After Phase 3, an approved agent could call *every* tool. "Allow" was all
or nothing. Two separate questions remain:

1. **Standing permission.** Which tools may this agent use at all? The
   customer should be able to say "read my orders, but don't touch my
   address", and change their mind later without reconnecting.
2. **Per-action consent.** Some actions are serious enough that even an
   allowed agent shouldn't do them alone: cancelling an order, deleting
   an account, refunding money. The customer must approve *that specific
   action*.

The threat that drives question 2: the agent is an LLM reading untrusted
text (emails, web pages, product reviews). A prompt injection can make it
call any tool it has, with any arguments. MCP's `destructiveHint` asks
*clients* to confirm, but that's advisory. The business can't verify that
the client did it, and it's the business that ends up cancelling the order.

Relevant protocol facts (MCP 2025-11-25 and 2026-07-28):
- **Step-up authorization.** A server answers a call the token doesn't cover
  with HTTP 403 and `WWW-Authenticate: Bearer error="insufficient_scope",
  scope="..."`. The client unions the scopes it has with the ones in the
  challenge and re-authorizes. The official SDK client does this automatically.
- **URL-mode elicitation.** A server can ask the client to send the user to
  a URL. On 2026-07-28 it rides the stateless *input-required* round trip:
  the server returns `resultType: "input_required"`, and the client retries
  the call after the user is done. A stateless 2025-era server can't see
  the client's capabilities, so it can't rely on this there.

## Options considered

### Granularity of standing permission
1. **Effect-level scopes** (`read`, `write`, `destructive`). Three checkboxes.
   ❌ Too coarse: "add to cart" and "change payment method" are both writes.
2. **Per-tool scopes** (`tool:list_orders`), derived automatically.
   ✅ Matches what the consent screen already shows. Zero configuration.
   ❌ A long scope string for apps with many tools.
3. **Developer-defined scope groups** (`orders:read`). ✅ Compact.
   ❌ Every developer must design a scope taxonomy before shipping, and a
   group can't be split later without breaking grants.

### Where permission lives
1. **In the token** (scopes frozen at issuance). Changes wait for token expiry.
2. **In the grant, read on every call.** Changes apply on the next call.
   Phase 3 already looks up the grant on every call, so this costs nothing.

### Ungranted tools in `tools/list`
1. **Hide them.** The agent can't use what it can't see, so step-up never
   happens. The customer asks the agent to cancel and gets "I can't do that".
2. **List them, and answer calls with step-up.** The agent tries, the
   customer is asked in context ("Test Agent wants more access"), and
   can say yes.

### Per-action confirmation
1. **Trust the agent's client** to confirm (annotations only). ❌ Not
   verifiable. A compromised or careless client skips it.
2. **A `confirm: true` argument** the agent must pass. ❌ A prompt-injected
   model sets it too.
3. **Form-mode elicitation** inside the agent's UI. ❌ The dialog is
   rendered by the party we're guarding against. A stateless 2025-era
   server can't send it either.
4. **Out-of-band approval on the app's own site.** The call is parked. The
   customer opens a link on the app's domain, signed in with their normal
   session, and sees the exact action. The agent retries after approval.

## Decision

- **Per-tool scopes** (`tool:<name>`), stored on the **grant** and
  enforced live.
- The consent screen has a **checkbox per tool**, grouped by effect. The
  customer can untick any of them.
- **Every tool is listed.** A call to an ungranted tool gets an HTTP 403
  step-up challenge.
- **Out-of-band confirmation** for `destructive` tools by default. Any
  tool can opt in or out with `confirm`.

```ts
defineTool({
  name: "cancel_order",
  effect: "destructive",                            // confirmation on by default
  confirm: ({ orderId }) => `Cancel order ${orderId}`, // plain words for the approval page
  ...
});

defineTool({ name: "refund", effect: "write", confirm: true, ... });          // opt in
defineTool({ name: "clear_cart", effect: "destructive", confirm: false, ... }); // explicit opt out
```

| Area | Choice |
|---|---|
| Scope format | `tool:<name>`. Unknown scopes (`openid`, `offline_access`, removed tools) are ignored |
| Open request (no known scope) | Offer every tool, all ticked. If already connected, skip the screen and keep the current grant |
| Explicit request | Skip the screen if the grant already covers it. Otherwise offer *granted ∪ requested*, all ticked |
| Approval | The ticked boxes **replace** the grant's scopes. Boxes not on the page are ignored, even if the form is edited. Nothing ticked counts as Deny |
| Grants | Still one per customer + agent. A step-up updates it rather than adding another |
| Token response | Includes `scope`, so clients can compute the union on step-up |
| Enforcement | HTTP 403 `insufficient_scope` before the MCP layer, with `scope` = granted ∪ needed. The same check runs again inside the surface (defense in depth) |
| Live changes | `usher.grants.setScopes(userId, grantId, scopes)` applies on the agent's next call |
| Confirmation binding | One grant + one tool + the SHA-256 of the canonical JSON input. **Single use**, atomic. Expires after 15 minutes |
| Confirmation delivery | 2026-07-28 clients that declare `elicitation.url` get native URL elicitation (`input_required`) and retry by themselves. Everyone else gets a tool error with `code: "confirmation_required"` and the link, which the model relays to the customer |
| Approval page | Same-origin + a signed, user-bound token (its kind can't be swapped with a consent token). Signed-out customers go to login and come back. Other accounts get 403. It can't be framed and isn't cached. Arguments are shown escaped |
| Decline | The next retry gets `confirmation_declined` once, then a fresh request starts over |

## Why

1. **Per-tool scopes cost developers nothing.** They come from tool names
   the developer already wrote, and they match the consent screen
   one-to-one. Developer-defined groups can be added later as an alias
   layer without breaking existing grants.
2. **Grant-based enforcement makes "change permissions" instant.** The
   per-call grant lookup already exists for instant revocation (ADR 0004),
   so this is free.
3. **Listing everything plus step-up puts the customer in the loop at the
   moment of need.** Hiding tools would quietly turn "no for now" into
   "never". Each step-up needs a human click, so an agent can annoy the
   customer but never escalate on its own.
4. **Only out-of-band confirmation survives prompt injection.** Usher shows
   the approval page on the app's own domain, so neither the model nor its
   client can fake the click. Binding approval to the exact arguments
   blocks "approve `o_1`, execute `o_2`". Single use blocks replays.
5. **It degrades gracefully.** Native URL elicitation where the client
   supports it, and a link in a tool error everywhere else. Every MCP
   client in use today can relay a link.

## Trade-offs

| We give up | Impact | Mitigation |
|---|---|---|
| Short scope strings | Long `scope` values for apps with many tools | ~20 bytes per tool. Scope groups as aliases if apps exceed ~50 tools |
| Scope stability across renames | Renaming a tool drops it from existing grants | The agent hits step-up and the customer re-approves. Documented: names are part of the API |
| A quiet tool list | Agents see tools they can't use yet and may trigger consent prompts | Each prompt needs a human. Descriptions are unchanged, so there's no context bloat beyond the existing catalog |
| One-step destructive actions | The customer leaves the agent to approve on the app's site | It's the point. `confirm: false` for low-stakes destructive tools. Future: a "trust this agent for X" setting |
| Seamless fallback UX | Clients without URL elicitation depend on the model relaying a link | The tool error is explicit and machine-readable (`confirmation_required`, `confirm_url`) |
| Free-form approvals | Different arguments, even an added optional field, need a new approval | Exact binding is the safety property. Agents can call again once arguments are final |
| HTTP-level step-up for batches | A batch with one ungranted call fails as a whole with 403 | Batching was removed from MCP in 2025-06. It only affects older clients |
| Summary text from the developer | `confirm(input)` receives agent-controlled values that could be misleading | Escaped HTML, a 200-character cap, and the exact arguments always shown below the summary |

## What was built in this phase

- `tool.ts`: `confirm?: boolean | (input) => string`, `needsConfirmation()`,
  `toolScope()`, and startup validation.
- `auth/store.ts`: `updateGrantScopes`, plus `ConfirmationRecord` with
  save/get/find/decide and an atomic consume.
- `auth/server.ts`:
  - Scope parsing; checkbox consent with granted ∪ requested; grant upsert;
    `scope` in token responses; live scopes on the principal.
  - The `insufficientScope` 403; `checkCall` (the permission layer);
    approval pages at `{basePath}/confirm/{id}`; `grants.setScopes`.
- `auth/consent-page.ts`: checkboxes, an approval page, a "done" page,
  and a shared page shell.
- `surfaces/mcp.ts`: runs the policy before every handler and maps each
  decision to MCP. That means `input_required` + `elicitUrl` for 2026
  clients that support it, and tool errors otherwise.
- `index.ts`: the 403 step-up check before dispatch, and
  `grants.setScopes`.
- Tests (80 total, 20 new):
  - **Scopes:** consent defaults; partial grants; 403 challenge contents;
    the SDK client's full step-up with one grant kept; covered or
    uncovered requests; reconnect and `prompt=consent` editing; forged
    form scopes; empty Allow; live `setScopes`.
  - **Confirmation:** handler not run before approval; reuse of a pending
    approval; binding to exact arguments; single use; a concurrent-retry
    race; decline; `confirm` overrides; native URL elicitation and its
    no-loop retry.
  - **Approval page security:** login round-trip, other accounts,
    escaping, framing, cross-site POST, tampered tokens, consent-token
    swap, expiry, revoked agent.
  - **Mutation-checked.** These protections were removed one at a time,
    and tests failed each time: scope enforcement, single-use approval,
    argument binding, offered-scope filtering, and the approval user
    checks.

## Revisit when

- Apps routinely exceed ~50 tools → add developer-defined scope groups as
  aliases over `tool:<name>`.
- Customers ask to skip repeated approvals → add per-grant "always allow
  this action" with a cap and an expiry, shown on the Phase 8 settings page.
- MCP clients broadly support URL elicitation on 2025-era transports, or
  the 2025 era fades → drop the tool-error fallback.
- Phase 5 (plugins) → expose `checkCall` decisions as audit events and rate
  limit triggers.
