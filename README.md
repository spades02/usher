# Usher

**Let your customers bring their own AI agent.**

Usher is an open-source library that makes any web or mobile app *agent-ready*.
Instead of forcing customers to talk to a generic support chatbot that knows the
business but nothing about them, Usher lets them connect the assistant they
already use — ChatGPT, Claude, Gemini, Cursor, or their own — which already knows
their context and preferences.

Think of it as **"Better Auth for agent access."**

## The problem

A SaaS chatbot knows the product catalog and the FAQ. It doesn't know that the
customer is vegetarian, travels for work every second week, prefers email over
calls, or already tried the troubleshooting steps yesterday. The customer's
*personal* agent knows all of that — but it has no safe way into the business's
app.

## What Usher does

1. **Define tools once** — typed actions like `listOrders`, `changePlan`, `bookSlot`.
2. **Expose them over standards** — a remote MCP server (ChatGPT, Claude, …) and,
   later, WebMCP for in-browser agents.
3. **Handle agent auth & consent** — OAuth 2.1, per-tool scopes, revocable grants,
   wired into the auth you already have.
4. **Guardrails** — confirmation for risky actions, per-agent rate limits, audit
   log, kill switch.
5. **"Connect your agent" widget** — sits next to (or replaces) your chatbot.

## What Usher is *not*

- Not an LLM or model router — the customer's agent does the thinking.
- Not a chatbot — you can keep yours as a fallback.
- Not a store of the customer's personal memory — that stays with their agent.

## Status

Pre-alpha. Built phase by phase; each phase records one architectural decision in
[`docs/adr/`](docs/adr/).

| Phase | Decision | ADR |
|---|---|---|
| 0 | Product shape | [0001](docs/adr/0001-product-shape.md) |
| 1 | Protocol surface | [0002](docs/adr/0002-protocol-surface.md) |
| 2 | Tool definition model | [0003](docs/adr/0003-tool-definition-model.md) |
| 3 | Agent auth & consent | [0004](docs/adr/0004-agent-auth-and-consent.md) |
| 4 | Permission model | [0005](docs/adr/0005-permission-model.md) |
| 5 | Plugin system | [0006](docs/adr/0006-plugin-system.md) |
| 6 | Persistence | [0007](docs/adr/0007-persistence.md) |
| 7 | Runtime & deployment | [0008](docs/adr/0008-runtime-and-deployment.md) |
| 8 | Customer-facing UI | — |
| 9 | Repo & release tooling | — |
| 10 | Docs site & hosted dashboard | — |
