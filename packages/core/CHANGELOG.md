# @usherjs/core

## 0.1.0

### Minor Changes

- f1ba1ed: First public release. Usher lets a SaaS's customers connect their own AI agent (ChatGPT, Claude, Cursor, or any MCP client) to the app: typed tools exposed over MCP, an embedded OAuth 2.1 server with per-tool consent, step-up and out-of-band approval for destructive actions, restrict-only plugins (audit log, rate limit, kill switch), durable Postgres/SQLite storage, Node and file-routed framework adapters, a standalone server for apps not written in JS, and the `<usher-connect>` / `<usher-agents>` elements.
- 21cb391: Add the operator console at `{basePath}/console` (`console: { isOperator, events }`): last-24-hour activity by agent and tool, alerts for stolen-token replays and crashing tools, the audit trail, and per-customer lookup with disconnect. Disconnects from the console are recorded as `grant.revoked` with the new reason `"operator"`. The standalone server enables it with `"operators": [...]`.
