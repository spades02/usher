---
title: How it works
description: From "add connector" to an approved, audited tool call.
---

Usher is a library that runs inside your app. It speaks the **Model Context
Protocol (MCP)** to agents, and **OAuth 2.1** to connect them to customers.
Your app keeps its own login and database throughout.

## 1. Discovery

The customer pastes `https://your-app.example/api/usher/mcp` into their
assistant. The assistant calls it, gets `401 Unauthorized`, and follows the
standard discovery documents:

- `/.well-known/oauth-protected-resource/api/usher/mcp` (RFC 9728), which
  names the authorization server;
- `/.well-known/oauth-authorization-server/api/usher` (RFC 8414), which
  lists its endpoints.

## 2. The agent identifies itself

Modern assistants publish a **Client ID Metadata Document** at an HTTPS URL
they control. Usher fetches it, so the agent's identity is proven by its
domain, and the consent page shows *Verified · claude.ai*. Older agents
register themselves (dynamic client registration). Their names are
self-declared, and Usher labels them *Unverified* everywhere.

## 3. The customer signs in and consents

The assistant opens your consent page at `/api/usher/oauth/authorize`:

- If the customer isn't signed in, they're sent to **your** login page and
  come back.
- They see the agent, its verified domain, and one checkbox per tool,
  grouped by effect. Destructive tools are marked *Asks you before each
  use*.
- What they approve becomes a **grant**: one customer, one agent, a set of
  `tool:<name>` scopes.

The agent receives short-lived access tokens and a rotating refresh token.
Tokens are stored only as hashes. Reusing an old refresh token is treated as
theft, and it disconnects the agent.

## 4. Calls

Every `tools/call` goes through the same pipeline:

```text
authenticate → scope check → plugins (beforeCall) → approval → your handler → plugins (onEvent)
```

- **Scope check**: if the customer didn't grant this tool, the agent gets an
  HTTP 403 `insufficient_scope` challenge and can ask the customer for more
  (step-up).
- **Plugins** can only add restrictions: rate limits, kill switches, your
  own rules.
- **Approval**: a destructive tool pauses with a link to your site. The
  customer approves that exact call (same tool, same arguments, once), and
  the agent retries.
- **Your handler** receives the validated input and the customer's
  `user.id`. Scope every query to it.

## 5. Afterwards

Every step emits an event (`call`, `grant.created`, `grant.revoked`, ...)
without the call's inputs. The audit log stores them. Customers see them in
`<usher-agents>`, and your staff in the [operator console](/guides/operator-console/).
A customer can narrow or disconnect any agent at any time, and it takes
effect on the agent's next call.
