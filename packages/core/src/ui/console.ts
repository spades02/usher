/**
 * The operator console (ADR 0011): a dashboard for the app's own staff,
 * served by the app's own Usher at `{basePath}/console`. It's not a hosted
 * service: customers' grants and activity never leave the app.
 *
 * Like the consent pages, it is server-rendered HTML with no JavaScript and
 * a CSP that loads nothing. Access is the app's own login plus an
 * `isOperator(user)` check. The one write (disconnecting an agent) is a
 * form POST guarded by a same-origin check and a signed, operator-bound,
 * short-lived token.
 */
import { escapeHtml as e, pageHeaders } from "../auth/consent-page.js";
import { signPayload, verifyPayload } from "../auth/crypto.js";
import type { GrantRecord } from "../auth/store.js";
import type { IdentityAdapter, UsherUser } from "../auth/types.js";
import type { QueryableAuditSink } from "../plugins/audit-log.js";
import type { UsherEvent } from "../plugins/types.js";
import type { ResolvedTheme } from "./theme.js";

export interface ConsoleOptions {
  /** Who may open the console: your staff. Called for every console request. */
  isOperator(user: UsherUser, request: Request): boolean | Promise<boolean>;
  /** The audit trail the console reads, e.g. `sqlStorage(db).auditSink`. */
  events: QueryableAuditSink;
}

interface Deps {
  basePath: string;
  appName: string;
  secret: string;
  ownOrigin?: string;
  identity: IdentityAdapter;
  theme: ResolvedTheme;
  options: ConsoleOptions;
  listGrants(userId: string): Promise<GrantRecord[]>;
  revokeByOperator(userId: string, grantId: string): Promise<void>;
}

/** How many recent events the overview aggregates. */
export const OVERVIEW_EVENTS = 2000;
const DAY = 86_400_000;
const TOKEN_TTL = 10 * 60;

interface RevokePayload {
  k: "console-revoke";
  op: string;
  u: string;
  g: string;
  exp: number;
}

export function createConsole(deps: Deps) {
  const { basePath, options } = deps;
  const root = `${basePath}/console`;
  const headers = pageHeaders(deps.theme);
  const nowSec = () => Math.floor(Date.now() / 1000);

  const html = (body: string, status = 200) => new Response(body, { status, headers });
  const userUrl = (id: string) => `${root}/users/${encodeURIComponent(id)}`;

  async function route(request: Request, pathname: string): Promise<Response | null> {
    if (pathname !== root && !pathname.startsWith(`${root}/`)) return null;
    const origin = deps.ownOrigin ?? new URL(request.url).origin;

    const user = await deps.identity.getUser(request);
    if (!user) {
      return new Response(null, { status: 302, headers: { location: deps.identity.loginUrl(new URL(request.url, origin).href) } });
    }
    if (!(await options.isOperator(user, request))) {
      return html(shell(deps, "No access", `<h1>No access</h1><p>The agent console is for ${e(deps.appName)} staff.</p>`), 403);
    }

    const path = pathname.slice(root.length) || "/";
    const url = new URL(request.url);

    if (path === "/" && request.method === "GET") return html(await overview(user));
    if (path === "/events" && request.method === "GET") return html(await eventsPage(url.searchParams));
    if (path === "/users" && request.method === "GET") {
      const id = url.searchParams.get("id")?.trim();
      return id ? new Response(null, { status: 303, headers: { location: userUrl(id) } }) : html(await overview(user));
    }
    const userPage = path.match(/^\/users\/([^/]+)$/);
    if (userPage && request.method === "GET") return html(await customer(user, decodeURIComponent(userPage[1]!), url.searchParams));

    const revoke = path.match(/^\/users\/([^/]+)\/grants\/([^/]+)\/revoke$/);
    if (revoke && request.method === "POST") {
      const sentOrigin = request.headers.get("origin");
      if (sentOrigin !== null && sentOrigin !== origin) return html(shell(deps, "Blocked", "<h1>Request blocked</h1>"), 403);
      const userId = decodeURIComponent(revoke[1]!);
      const grantId = decodeURIComponent(revoke[2]!);
      const form = new URLSearchParams(await request.text());
      const token = await verifyPayload<RevokePayload>(deps.secret, form.get("token") ?? "");
      if (token?.k !== "console-revoke" || token.op !== user.id || token.u !== userId || token.g !== grantId || token.exp < nowSec()) {
        return html(
          shell(deps, "Expired", `<h1>This page expired</h1><p><a href="${e(userUrl(userId))}">Reload it</a> and try again.</p>`),
          400,
        );
      }
      await deps.revokeByOperator(userId, grantId);
      return new Response(null, { status: 303, headers: { location: `${userUrl(userId)}?disconnected=1` } });
    }
    return html(shell(deps, "Not found", "<h1>Not found</h1>"), 404);
  }

  // --------------------------------------------------------------- overview

  async function overview(operator: UsherUser): Promise<string> {
    const events = await options.events.list({ limit: OVERVIEW_EVENTS });
    const since = Date.now() - DAY;
    const day = events.filter((ev) => ev.at >= since);
    const calls = day.filter((ev): ev is Extract<UsherEvent, { type: "call" }> => ev.type === "call");
    const count = (pred: (ev: (typeof calls)[number]) => boolean) => calls.filter(pred).length;
    const ok = count((c) => c.outcome === "success");
    const blocked = count((c) => c.outcome === "forbidden" || c.outcome === "denied");
    const failed = count((c) => c.outcome === "failed");
    const replays = day.filter((ev) => ev.type === "grant.revoked" && ev.reason === "token_replay");
    const decided = day.filter((ev): ev is Extract<UsherEvent, { type: "confirmation.decided" }> => ev.type === "confirmation.decided");

    const agents = new Map<string, { name: string; verified: boolean; customers: Set<string>; calls: number; problems: number }>();
    const tools = new Map<string, { calls: number; blocked: number; failed: number }>();
    for (const ev of day) {
      const a = agents.get(ev.agent.clientId) ?? {
        name: ev.agent.name,
        verified: ev.agent.verified,
        customers: new Set(),
        calls: 0,
        problems: 0,
      };
      a.customers.add(ev.userId);
      if (ev.type === "call") {
        a.calls++;
        if (ev.outcome === "failed" || ev.outcome === "forbidden" || ev.outcome === "denied") a.problems++;
        const t = tools.get(ev.tool) ?? { calls: 0, blocked: 0, failed: 0 };
        t.calls++;
        if (ev.outcome === "forbidden" || ev.outcome === "denied") t.blocked++;
        if (ev.outcome === "failed") t.failed++;
        tools.set(ev.tool, t);
      }
      agents.set(ev.agent.clientId, a);
    }

    const stat = (label: string, value: string | number, warn = false) =>
      `<div class="stat${warn ? " warn" : ""}"><div class="value">${e(String(value))}</div><div class="meta">${e(label)}</div></div>`;
    const alerts = [
      ...replays.map((ev) => ({ at: ev.at, text: `Stolen-token replay detected: ${ev.agent.name} was disconnected`, user: ev.userId })),
      ...calls
        .filter((c) => c.outcome === "failed")
        .slice(0, 10)
        .map((c) => ({ at: c.at, text: `${c.tool} crashed for ${c.agent.name} (see onError logs)`, user: c.userId })),
    ].sort((a, b) => b.at - a.at);

    const body = `
  <h1>Agent console</h1>
  <p class="meta">Last 24 hours · signed in as ${e(operator.name ?? operator.email ?? operator.id)}</p>
  <form method="get" action="${e(`${root}/users`)}" class="search">
    <input name="id" placeholder="Customer ID" aria-label="Customer ID" required>
    <button type="submit">Look up customer</button>
  </form>
  <div class="stats">
    ${stat("tool calls", calls.length)}
    ${stat("succeeded", calls.length ? `${Math.round((ok / calls.length) * 100)}%` : "—")}
    ${stat("customers active", new Set(day.map((ev) => ev.userId)).size)}
    ${stat("agents active", agents.size)}
    ${stat("new connections", day.filter((ev) => ev.type === "grant.created").length)}
    ${stat("disconnections", day.filter((ev) => ev.type === "grant.revoked").length)}
    ${stat("approvals", `${decided.filter((d) => d.approved).length} / ${decided.length}`)}
    ${stat("blocked calls", blocked, blocked > 0)}
    ${stat("crashed calls", failed, failed > 0)}
    ${stat("token replays", replays.length, replays.length > 0)}
  </div>
  ${
    alerts.length
      ? `<h2>Needs attention</h2><ul class="alerts">${alerts
          .map(
            (a) =>
              `<li><span class="meta">${time(a.at)}</span> ${e(a.text)} · <a href="${e(userUrl(a.user))}">customer ${e(a.user)}</a></li>`,
          )
          .join("")}</ul>`
      : ""
  }
  <h2>Agents</h2>
  ${table(
    ["Agent", "Identity", "Customers", "Calls", "Blocked or crashed"],
    [...agents.entries()]
      .sort((a, b) => b[1].calls - a[1].calls)
      .map(([clientId, a]) => [
        `<strong>${e(a.name)}</strong><div class="meta">${e(clientId)}</div>`,
        a.verified ? "Verified" : `<span class="warn">Unverified</span>`,
        String(a.customers.size),
        String(a.calls),
        String(a.problems),
      ]),
    "No agent activity in the last 24 hours.",
  )}
  <h2>Tools</h2>
  ${table(
    ["Tool", "Calls", "Blocked", "Crashed"],
    [...tools.entries()]
      .sort((a, b) => b[1].calls - a[1].calls)
      .map(([name, t]) => [e(name), String(t.calls), String(t.blocked), String(t.failed)]),
    "No tool calls in the last 24 hours.",
  )}
  <p class="meta">Computed from the latest ${OVERVIEW_EVENTS} audit events. <a href="${e(`${root}/events`)}">All events</a></p>`;
    return shell(deps, "Agent console", body);
  }

  // ----------------------------------------------------------------- events

  async function eventsPage(params: URLSearchParams): Promise<string> {
    const type = params.get("type") || undefined;
    const userId = params.get("user") || undefined;
    const events = await options.events.list({ type: type as UsherEvent["type"] | undefined, userId, limit: 200 });
    const types = ["call", "grant.created", "grant.updated", "grant.revoked", "confirmation.decided"];
    const body = `
  <p><a href="${e(root)}">← Overview</a></p>
  <h1>Events</h1>
  <form method="get" class="search">
    <select name="type" aria-label="Event type"><option value="">All types</option>${types
      .map((t) => `<option${t === type ? " selected" : ""}>${t}</option>`)
      .join("")}</select>
    <input name="user" placeholder="Customer ID" value="${e(userId ?? "")}" aria-label="Customer ID">
    <button type="submit">Filter</button>
  </form>
  ${eventTable(events)}`;
    return shell(deps, "Events · Agent console", body);
  }

  function eventTable(events: UsherEvent[]): string {
    return table(
      ["When", "Event", "Customer", "Agent", "Details"],
      events.map((ev) => [
        `<span class="meta">${time(ev.at)}</span>`,
        e(ev.type),
        `<a href="${e(userUrl(ev.userId))}">${e(ev.userId)}</a>`,
        `${e(ev.agent.name)}${ev.agent.verified ? "" : ` <span class="warn">(unverified)</span>`}`,
        e(details(ev)),
      ]),
      "No events.",
    );
  }

  // --------------------------------------------------------------- customer

  async function customer(operator: UsherUser, userId: string, params: URLSearchParams): Promise<string> {
    const grants = await deps.listGrants(userId);
    const events = await options.events.list({ userId, limit: 50 });
    const rows = await Promise.all(
      grants.map(async (g) => {
        const token = await signPayload(deps.secret, {
          k: "console-revoke",
          op: operator.id,
          u: userId,
          g: g.id,
          exp: nowSec() + TOKEN_TTL,
        } satisfies RevokePayload);
        return [
          `<strong>${e(g.clientName)}</strong><div class="meta">${e(g.clientId)}</div>`,
          g.clientSource === "cimd" ? "Verified" : `<span class="warn">Unverified</span>`,
          g.scopes.map((s) => e(s.replace(/^tool:/, ""))).join(", ") || "<span class=meta>nothing</span>",
          `<span class="meta">${time(g.createdAt * 1000)}</span>`,
          `<form method="post" action="${e(`${userUrl(userId)}/grants/${encodeURIComponent(g.id)}/revoke`)}">
            <input type="hidden" name="token" value="${e(token)}"><button type="submit" class="danger">Disconnect</button></form>`,
        ];
      }),
    );
    const body = `
  <p><a href="${e(root)}">← Overview</a></p>
  <h1>Customer ${e(userId)}</h1>
  ${params.get("disconnected") ? `<p class="notice">Agent disconnected. Its tokens stopped working immediately.</p>` : ""}
  <h2>Connected agents</h2>
  ${table(["Agent", "Identity", "May use", "Connected", ""], rows, "No agents connected.")}
  <h2>Recent activity</h2>
  ${eventTable(events)}`;
    return shell(deps, `Customer ${e(userId)} · Agent console`, body);
  }

  return { route };
}

// ------------------------------------------------------------------ helpers

function time(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function details(ev: UsherEvent): string {
  switch (ev.type) {
    case "call":
      return `${ev.tool}: ${ev.outcome}${ev.code ? ` (${ev.code})` : ""}, ${ev.durationMs} ms`;
    case "grant.created":
    case "grant.updated":
      return ev.scopes.map((s) => s.replace(/^tool:/, "")).join(", ") || "no tools";
    case "grant.revoked":
      return `reason: ${ev.reason}`;
    case "confirmation.decided":
      return `${ev.approved ? "approved" : "declined"}: ${ev.summary}`;
  }
}

/** Cells must already be escaped. */
function table(head: string[], rows: string[][], empty: string): string {
  if (rows.length === 0) return `<p class="meta">${e(empty)}</p>`;
  return `<div class="scroll"><table><thead><tr>${head.map((h) => `<th>${e(h)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}

const STYLE = `
  body { font: 15px/1.5 var(--font); color: var(--fg); background: var(--bg); margin: 0; padding: 16px; }
  main { max-width: 1040px; margin: 24px auto; }
  h1 { font-size: 1.4rem; margin: 0 0 4px; } h2 { font-size: 1.05rem; margin: 28px 0 8px; }
  a { color: var(--accent); }
  .meta { color: var(--muted); font-size: .85rem; }
  .warn { color: var(--warn); }
  .stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; margin: 16px 0; }
  .stat { border: 1px solid var(--line); border-radius: var(--radius); padding: 10px 12px; }
  .stat .value { font-size: 1.4rem; font-weight: 600; }
  .stat.warn { border-color: var(--warn); }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: .9rem; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 500; }
  .search { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0; }
  input, select, button { font: inherit; padding: 6px 10px; border-radius: var(--radius); border: 1px solid var(--line); background: transparent; color: var(--fg); }
  button { cursor: pointer; } button.danger { color: var(--warn); border-color: var(--warn); }
  form { margin: 0; }
  .alerts li { margin: 4px 0; }
  .notice { border: 1px solid var(--line); border-radius: var(--radius); padding: 8px 12px; }`;

/** `title` must already be escaped. */
function shell(deps: Pick<Deps, "theme" | "appName">, title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} · ${e(deps.appName)}</title>
<style>${deps.theme.css}${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}
