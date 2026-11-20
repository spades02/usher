# ADR 0011: Docs site and dashboard. Executable docs, and a self-hosted operator console instead of a hosted dashboard

- **Status:** Accepted
- **Date:** 2026-11-20
- **Phase:** 10
- **Refines:** ADR 0001 ("hosted control plane later, never required")

## Context

Phase 10 was planned as "docs site and hosted dashboard". Two audiences
are still unserved:

1. **Developers integrating Usher.** They need guides per framework, the
   security model and a reference. The docs must stay correct as the API
   moves; in a security library, a wrong snippet becomes a vulnerable
   integration.
2. **The app's staff operating it.** Support ("my assistant did something
   odd") and security ("is someone replaying tokens?") need to see agent
   activity across customers and act on it. Customers already have
   `<usher-agents>` (ADR 0009), and backends have the admin API (ADR 0008).
   Staff have nothing.

ADR 0001 deferred an *optional* hosted control plane to this phase: Usher
running a service that apps report to. Building it now would mean
customers' grants, activity or tokens flowing to a third party, the exact
thing ADR 0001 chose an in-process library to avoid. It would also need
accounts, billing and operations that have nothing to do with making agent
access safe.

## Options considered

### Dashboard
1. **Hosted dashboard (Usher Cloud).** Apps send events to us, and we render
   them.
   - ✅ Cross-app views, and nothing for the app to host.
   - ❌ Customer activity leaves the app. It's a data processor relationship
     for every adopter, and an outage or breach of ours becomes theirs.
2. **No dashboard.** Point staff at SQL over `usher_audit_events`.
   - ✅ Nothing to build.
   - ❌ Incident response means a database console, and nobody can
     disconnect an agent without writing code.
3. **A self-hosted operator console in the library (chosen).** Server-rendered
   at `{basePath}/console`, from the app's own audit sink, behind the app's
   own login plus `isOperator(user)`.
   - ✅ Zero data leaves the app, and it ships with every install.
   - ✅ It reuses the hardened page design from consent and approval.
   - ❌ It's per app, with no cross-app view (see trade-offs).

### Docs
1. **A hosted docs SaaS (Mintlify, GitBook).**
   - ✅ Polished.
   - ❌ Content lives outside the repo, and code samples can't be compiled or
     run.
2. **VitePress.**
   - ✅ Light.
   - ❌ Its stable line hasn't had a release in over a year (2.0 is still
     alpha).
3. **Astro Starlight in the monorepo (chosen).**
   - ✅ Static output, built-in search (Pagefind), accessible defaults,
     actively maintained.
   - ✅ MDX can import code from files, so samples can be real files.

## Decision

### Operator console

```ts
createUsher({ console: { isOperator: (user) => user.email?.endsWith("@shop.example") ?? false, events: storage.auditSink } });
```

| Page | Shows |
|---|---|
| Overview | Last 24 hours, aggregated from the latest 2,000 events: tool calls, success rate, active customers and agents, connections and disconnections, approvals, blocked and crashed calls, token replays. A **Needs attention** list (replays, crashes). Per-agent and per-tool tables. Customer lookup |
| Events | The audit trail, filterable by type and customer |
| Customer | That customer's grants (agent, verified or not, tools, connected) with **Disconnect**, plus their recent activity |

**Security:** it gets the same treatment as the consent pages.

- Pages are server-rendered with no JavaScript, under
  `default-src 'none'; frame-ancestors 'none'`, `no-store` and `noindex`.
- Every value is escaped. Agent names are agent-chosen.
- Access requires the app's session. Signed-out staff go to the login page,
  and non-operators get a 403.
- Disconnect is a POST with a same-origin check and a signed token, bound to
  the operator, the customer and the grant, valid for 10 minutes.
- Console disconnects are a new revocation reason, `"operator"`, so the
  audit trail tells staff actions apart from customer ones.
- Tool inputs never appear: the console reads the same input-free events as
  everything else (ADR 0006).

The standalone server enables it with `"operators": ["staff_1", …]`.

### Docs site (`apps/docs`)

| Area | Choice |
|---|---|
| Structure | Start here (getting started, how it works, security model). Guides: tools, frameworks, storage, plugins, customer UI, operator console, standalone, deployment. A customer-facing "Connect your assistant" page apps can copy into their help center. Reference: the API |
| **Executable samples** | Code shown on the site is imported from `apps/docs/snippets/*` (`?raw`), never pasted. `pnpm typecheck` type-checks every TypeScript sample against the **built** package. `apps/docs/test` **runs** them: the quickstart `usher.ts` is booted on PGlite, passes `checkDeployment`, connects a real MCP SDK agent, calls a tool, and hits the approval flow. The standalone `usher.config.json` is validated against the real schema. The plugin example is exercised at 03:00 and 12:00 UTC. The **Python and Ruby** webhook verifiers are run against signatures produced by Usher's own `webhookTool` (each where its interpreter exists, and both on CI runners) |
| API reference | Rendered from the same `api/*.api.md` reports CI checks (ADR 0010). One source |
| Decisions | `scripts/sync-adrs.mjs` publishes `docs/adr/*.md` into the site at build time (git-ignored copies), so the ADRs stay the single source and are browsable |
| Broken links | `scripts/check-links.mjs` fails the build on any missing internal page or `#anchor` |
| CI | `pnpm build` builds the package and then the site. Typecheck covers the samples. The test matrix runs the docs tests on all three OSes |

### The hosted control plane, deferred with conditions

A future hosted service remains possible (ADR 0001), and must be:

1. **Optional.** Everything in this phase works without it.
2. **Fed only by an opt-in plugin** (`onEvent`) that sends aggregated,
   customer-free metadata, such as counts per agent and tool, or agent
   directory data.
3. **Never in the access path.** No tokens, grants or approvals live there,
   and an outage of it can't stop a single tool call.

## Why

1. **The data stays where ADR 0001 put it.** Staff get a dashboard without a
   single customer event leaving the app.
2. **The console reuses the most-tested surface Usher has.** Server-rendered,
   no-JS, CSRF-tokened pages with strict CSP are the consent and approval
   design from Phases 3–4. The new risk is small and known.
3. **Docs that can't rot.** Every TypeScript sample type-checks against the
   built package on every change. The quickstart and the non-JS verifiers
   actually run. If an API change breaks a reader's first hour, CI fails
   first.
4. **One source for everything.** The API reference is the checked API
   report, the decisions page is the ADRs, and the snippets are the samples.
   Nothing is maintained twice.

## Trade-offs

| We give up | Impact | Mitigation |
|---|---|---|
| A cross-app, hosted dashboard | Companies running several apps see each console separately | The deferred control plane (conditions above), or forwarding events from `onEvent` to their own analytics |
| Long-range analytics in the console | The overview aggregates the latest 2,000 events, effectively "recent", on busy apps | Documented. Query `usher_audit_events` for history. A time-range query on `AuditSink` can come later |
| Console write actions beyond disconnect | Staff can't edit a customer's tool choices from the console | Deliberate: changing what an agent may do is the customer's consent. Staff can only cut access |
| The console's own access control | `isOperator` is only as good as the app's login and the predicate | Required at startup (a missing `isOperator` throws). Documented as the app's responsibility |
| Assistant setup steps can drift | The menu names for ChatGPT and Claude, and the Cursor and VS Code deep links, are maintained by hand in two places (`<usher-connect>` and the customer page) | Called out on the page. They should move to one shared data file next |
| PHP, Go and .NET verifiers | Only Python, Ruby and Node samples are tested | The scheme is plain HMAC-SHA256. Add samples with tests when design partners need them |
| The docs aren't deployed | `apps/docs/dist` is static, but no hosting is configured yet | Any static host. A deploy job comes with the first public release |

## What was built in this phase

```text
packages/core/src/ui/console.ts     The operator console (overview, events, customer + disconnect)
apps/docs/                          Starlight site: 27 pages, search, ADRs, API reference
apps/docs/snippets/                 Every code sample on the site, as real files (TS, JSON, Python, Ruby)
apps/docs/test/snippets.test.ts     Runs the quickstart, config, plugin and webhook verifiers
apps/docs/scripts/                  sync-adrs.mjs, check-links.mjs
```

- `UsherOptions.console`, the `ConsoleOptions` type, and a new
  `grant.revoked` reason, `"operator"`. A changeset (minor) is included.
- The standalone config gains `operators`.
- Root scripts: `pnpm docs` (dev server). `pnpm verify` now also builds the
  site, checks links and type-checks the samples.
- **Tests:** 191 in the core package (6 new for the console, plus standalone
  console checks) and 5 for the docs, with Ruby skipped where there's no
  interpreter. `pnpm verify` passes locally.
- **Mutation-checked:** these were made one at a time, and tests failed each
  time:
  - no operator check;
  - no origin check;
  - a token not bound to the operator;
  - a token not bound to the grant;
  - an unescaped agent name;
  - no 24-hour window;
  - the wrong revoke reason.

  One backup check survives, because the signed token already prevents the
  same attack: the inner "grant belongs to this customer" test in
  `revokeByOperator`.
- **The link checker** was shown to catch a missing page and a missing
  anchor.

## Revisit when

- Adopters run several apps and ask for one view → the opt-in, metadata-only
  control plane.
- Staff need history beyond recent events → add `since`/`until` to
  `AuditQuery` (with a conformance case).
- Assistants change their connector UIs → move the setup steps to one
  shared data file used by `<usher-connect>` and the docs.
- First public release → deploy the docs site from CI.
