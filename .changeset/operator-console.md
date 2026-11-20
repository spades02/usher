---
"usherjs": minor
---

Add the operator console at `{basePath}/console` (`console: { isOperator, events }`): last-24-hour activity by agent and tool, alerts for stolen-token replays and crashing tools, the audit trail, and per-customer lookup with disconnect. Disconnects from the console are recorded as `grant.revoked` with the new reason `"operator"`. The standalone server enables it with `"operators": [...]`.
