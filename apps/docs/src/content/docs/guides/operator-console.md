---
title: Operator console
description: A dashboard for your staff, served by your own Usher.
---

The console shows your support and security staff what agents are doing in
your app. It is served by **your** Usher at `/api/usher/console`, from your
own database. There is no hosted Usher service, and your customers' data
never leaves your app.

```ts
createUsher({
  // ...
  console: {
    isOperator: (user) => user.email?.endsWith("@shop.example") ?? false,
    events: storage.auditSink,
  },
});
```

`isOperator` runs on every console request, with the user from your own
login. Signed-out staff are sent to your login page. Customers get a 403.

## What it shows

- **Overview (last 24 hours):**
  - tool calls and success rate;
  - active customers and agents;
  - new connections and disconnections;
  - approvals;
  - blocked and crashed calls;
  - stolen-token replays.

  Below the numbers are a **Needs attention** list, plus tables by agent
  (verified or not, customers, calls, problems) and by tool.
- **Events**: the audit trail, filterable by type and customer.
- **Customer lookup**: a customer's connected agents and what each may use,
  their recent activity, and a **Disconnect** button. It's for support
  ("my assistant is doing something weird") and for incident response.
  Disconnecting is recorded as `grant.revoked` with `reason: "operator"`.

The pages are server-rendered with no JavaScript, can't be framed, and
aren't cached. Disconnect is a form protected by a same-origin check and a
short-lived token bound to the operator and the grant.

## Standalone server

List operator user ids in the config:

```json
{ "operators": ["staff_1", "staff_2"] }
```

## Limits

The overview aggregates the latest 2,000 audit events. For long-range
analytics, query your audit table (`usher_audit_events`) or forward events
from a plugin's `onEvent` to your analytics stack.
