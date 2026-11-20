---
title: Security model
description: What Usher guarantees, how it's tested, and what remains your job.
---

## What Usher guarantees

| Property | How |
|---|---|
| An agent only acts for the customer who connected it | Every token belongs to one grant (one customer, one agent). Handlers receive that customer's `user.id` |
| An agent only uses the tools the customer ticked | Scopes are checked before dispatch, from the live grant. Changes apply on the next call |
| Irreversible actions need the customer, every time | Approval is bound to grant + tool + exact input hash, works once, and expires in 15 minutes |
| A stolen refresh token is detected | Refresh tokens rotate, and reuse of a used one revokes the whole grant (`reason: token_replay`) |
| Codes, tokens and approvals are single-use across servers | A single atomic SQL statement each. CI races 24 real Postgres connections on them |
| Consent and approval can't be forged or framed | Signed, user-bound, expiring form tokens. Same-origin checks, `frame-ancestors 'none'`, no JavaScript |
| Agent-chosen text can't inject markup | Names are escaped on every server page and written as text in the custom elements |
| Internals don't leak to agents | Only `ToolError` messages reach the agent. Everything else becomes a generic error, with details to `onError` |
| Plugins can't widen access | Plugins run after Usher's own checks and can only deny. A crashing `beforeCall` denies (fails closed) |
| The audit trail holds no customer data | Events record an input *hash*, never the input |

Each guard is **mutation-checked**: the guard is broken on purpose to confirm
that a test fails. The design notes for each property are in the
[decision records](/decisions/0000-record-architecture-decisions/).

## What stays your job

- **Scope your handlers to `user.id`.** Usher tells you who the customer is.
  Your queries must use it.
- **Mark effects honestly.** A tool that sends money is `destructive`, even
  if its name sounds harmless.
- **Keep `secret` secret** and long (32+ characters), and set `baseUrl` in
  production.
- **Use durable storage** (`sqlStorage`) in production, and run `prune()` on
  a schedule.
- **Treat tool inputs as customer data** in your own logs.
- **Standalone server**: verify `Usher-Signature` on every webhook, and keep
  the webhooks on your internal network.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on the repository. See
`SECURITY.md` for scope and timelines.
