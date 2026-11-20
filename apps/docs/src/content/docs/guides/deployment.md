---
title: Deployment
description: A production checklist, and npx @usherjs/core doctor.
---

## Checklist

- **`baseUrl`** is set to your public origin (`https://shop.example`).
- **`secret`** is 32+ random characters (`openssl rand -base64 32`), from
  your secret store, and the same on every instance.
- **Durable storage**: `store: storage.store` plus `migrate()` at boot, or
  the SQL in your migrations. See [Storage](/guides/storage/).
- **`prune()`** runs hourly.
- **Routing**: `/api/usher/*` and `/.well-known/oauth-*` reach Usher. See
  [Frameworks](/guides/frameworks/).
- **HTTPS** everywhere. Agents refuse plain HTTP outside localhost.
- **`onError`** goes to your error tracker.
- **An audit log and a rate limit** are on.

## Check it from the outside

```sh
npx @usherjs/core doctor https://shop.example
```

```text
ok    HTTPS: https://shop.example
ok    Protected resource metadata: /.well-known/oauth-protected-resource/api/usher/mcp
ok    Authorization server metadata: /.well-known/oauth-authorization-server/api/usher
ok    MCP endpoint challenge: 401 with WWW-Authenticate

Ready for agents.
```

Common failures:

| Message | Fix |
|---|---|
| `GET /.well-known/... returned 404` | Route `/.well-known/oauth-*` to Usher (the second route file in Next.js and SvelteKit) |
| `resource is http://10.0.0.7:3000/...` | Set `baseUrl`. Usher sees your proxy's internal address |
| `no WWW-Authenticate header` | Your proxy or CDN strips it. Let it through on `/api/usher/mcp` |
| `expected 401` | `/api/usher/*` doesn't reach Usher |

`doctor` is also a function (`checkDeployment(url)`) for a post-deploy check
in CI.

## Serverless

The handler runs unchanged on Vercel, Netlify, Cloudflare Workers, AWS
Lambda (behind a Request/Response adapter) and Deno Deploy. Use a pooled
or HTTP Postgres driver, and call `migrate()` once per deploy, or
idempotently at cold start.
