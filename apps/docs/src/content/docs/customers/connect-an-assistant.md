---
title: Connect your assistant
description: A page you can adapt for your own customers' help center.
---

:::tip[For your help center]
This page is written for **your customers**. Copy it into your help center
and replace *Example Shop* and the URL. The same steps are built into
[`<usher-connect>`](/guides/customer-ui/). Assistants rename their menus
from time to time, so check them against the current apps when you publish.
:::

You can use your own AI assistant with Example Shop. It can look things up
and act for you, but only in the ways you allow. You can see everything it
did, and disconnect it at any time.

**Connection URL:** `https://shop.example/api/usher/mcp`

## Claude

1. In Claude, open **Settings → Connectors**.
2. Choose **Add custom connector** and paste the connection URL.
3. Select **Connect**, sign in to Example Shop, and choose what Claude may do.

## ChatGPT

1. In ChatGPT, open **Settings → Apps & Connectors**.
2. Create a connector (you may need to turn on developer mode first) and paste the connection URL.
3. Sign in to Example Shop when asked, and choose what ChatGPT may do.

## Cursor and VS Code

Use the **Add to Cursor** or **Add to VS Code** button on our
Connect page. Or add the connection URL as a remote (HTTP) MCP server
in the editor's settings, then sign in when it asks.

## Any other assistant

Any assistant that supports remote MCP servers can connect. Add the
connection URL, then sign in to Example Shop when asked.

## What to expect

- **You choose what it may do.** You tick each action on a page on our site.
  Actions that can't be undone, like cancelling an order, also ask you
  before **each** use, on our site.
- **Verified or not.** Assistants that prove who they are show *Verified*
  with their web domain. Treat *Unverified* ones with care.
- **Change your mind any time.** Under **Settings → Connected agents** you
  can see recent activity, untick actions, or disconnect an assistant. It
  takes effect immediately.
