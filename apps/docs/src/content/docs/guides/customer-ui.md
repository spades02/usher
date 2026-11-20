---
title: Customer UI
description: The "Connect your assistant" widget, the "Connected agents" page, and branding.
---

Two custom elements that work in any framework, or none.

```html
<!-- Any backend: Usher serves the script itself -->
<script src="/api/usher/elements.js"></script>

<usher-connect></usher-connect>   <!-- help or marketing page; works signed out -->
<usher-agents></usher-agents>     <!-- account settings -->
```

With a bundler, `import "@usherjs/core/elements"` instead. Importing it during
server rendering is a no-op.

## `<usher-connect>`

Shows your MCP URL with a Copy button, and short steps for ChatGPT, Claude,
Cursor, VS Code and any other MCP client. Cursor and VS Code get one-click
install links.

| Attribute | |
|---|---|
| `agents` | Which tabs, e.g. `agents="claude,chatgpt"`. Default: all |
| `base-path` | If you mounted Usher somewhere other than `/api/usher` |

## `<usher-agents>`

The customer's connected agents, newest first:

- a *Verified · domain* or *Unverified* badge, and when each was connected;
- one checkbox per tool, saved immediately. Changes apply on the agent's
  next call;
- **Recent activity**, if you pass `account: { activity: storage.auditSink }`;
- **Disconnect** (two clicks).

It fires `usher-change` and `usher-disconnect` events you can listen to.

## Styling

Both elements inherit your page's font and text color. Adjust the rest with
CSS custom properties and parts:

```css
usher-agents, usher-connect {
  --usher-accent: #4f46e5;
  --usher-accent-text: #fff;
  --usher-radius: 12px;
  --usher-border: #e5e7eb;
  --usher-danger: #b42318;
}
usher-agents::part(agent) { box-shadow: 0 1px 2px rgb(0 0 0 / 0.06); }
```

Parts: `title`, `agent`, `tools`, `activity`, `disconnect`, `url`, `copy`,
`install`.

## Branding the consent and approval pages

Those pages stay server-rendered by Usher, for security. You can brand them:

```ts
theme: {
  accentColor: "#4f46e5",
  logoUrl: "/logo.svg",                      // https:// or a path on your origin
  fontFamily: `"Inter", system-ui, sans-serif`,
  radius: 12,
  colorScheme: "auto",                       // or "light" / "dark"
  links: { accountSettings: "/settings/agents", privacy: "/privacy", support: "/help" },
}
```

Values are validated at startup. With `links.accountSettings`, the consent
page's "you can change this at any time" note links to your
`<usher-agents>` page.

## The API underneath

If you'd rather build your own UI, the elements call a small JSON API under
`/api/usher/account/`. Every call needs the `X-Usher-Request: 1` header, and
changes must come from your own origin:

- `GET agents`
- `PUT agents/:id` with `{ "scopes": [...] }`
- `DELETE agents/:id`
- `GET activity?agent=`
- `GET info` (public)
