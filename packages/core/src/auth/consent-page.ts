import type { AnyUsherTool, ToolEffect } from "../tool.js";
import { redirectRisk } from "./clients.js";
import type { ClientRecord } from "./store.js";
import type { UsherUser } from "./types.js";

/**
 * Default consent screen. Server-rendered, no JavaScript, no external assets.
 * Phase 8 makes it replaceable with the app's own UI.
 */

const EFFECT_LABEL: Record<ToolEffect, string> = {
  read: "View",
  write: "Make changes",
  destructive: "Irreversible actions",
};

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Headers that keep the consent page from being framed (clickjacking) or cached. */
export const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
};

export function renderConsentPage(input: {
  appName: string;
  client: ClientRecord;
  user: UsherUser;
  redirectUri: string;
  tools: readonly AnyUsherTool[];
  action: string;
  consentToken: string;
}): string {
  const { appName, client, user, redirectUri, tools, action, consentToken } = input;
  const e = escapeHtml;
  const redirectHost = new URL(redirectUri).host || new URL(redirectUri).protocol;
  const risk = redirectRisk(redirectUri);

  const identity =
    client.source === "cimd"
      ? `<p class="meta">Verified domain: <strong>${e(new URL(client.clientId).host)}</strong></p>`
      : `<p class="meta warn">This agent's identity is self-declared and could not be verified.</p>`;

  const riskNote =
    risk === "none"
      ? ""
      : `<p class="meta warn">After approval you'll be sent to <strong>${e(redirectHost)}</strong>, ${
          risk === "loopback" ? "a program running on your own device" : "a desktop or mobile app"
        }. Only continue if you started this connection yourself.</p>`;

  const groups = (["read", "write", "destructive"] as const)
    .map((effect) => {
      const items = tools.filter((t) => t.effect === effect);
      if (items.length === 0) return "";
      return `<h3 class="${effect}">${EFFECT_LABEL[effect]}</h3><ul>${items
        .map((t) => `<li><strong>${e(t.title ?? t.name)}</strong> — ${e(t.description)}</li>`)
        .join("")}</ul>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect ${e(client.clientName)} to ${e(appName)}</title>
<style>
  :root { color-scheme: light dark; --fg:#111; --bg:#fff; --muted:#555; --warn:#9a3412; --line:#ddd; --accent:#111; --accent-fg:#fff; }
  @media (prefers-color-scheme: dark) { :root { --fg:#eee; --bg:#111; --muted:#aaa; --warn:#fdba74; --line:#333; --accent:#eee; --accent-fg:#111; } }
  body { font: 16px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); margin: 0; padding: 16px; }
  main { max-width: 480px; margin: 40px auto; }
  h1 { font-size: 1.35rem; margin: 0 0 8px; }
  h3 { font-size: .95rem; margin: 20px 0 4px; }
  h3.destructive { color: var(--warn); }
  ul { margin: 0; padding-left: 20px; } li { margin: 4px 0; }
  .meta { color: var(--muted); font-size: .9rem; margin: 4px 0; }
  .warn { color: var(--warn); }
  form { display: flex; gap: 12px; margin-top: 28px; }
  button { flex: 1; font: inherit; padding: 10px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--fg); cursor: pointer; }
  button[value=allow] { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
</style>
</head>
<body>
<main>
  <h1>${e(client.clientName)} wants to access your ${e(appName)} account</h1>
  ${identity}
  <p class="meta">Signed in as <strong>${e(user.name ?? user.email ?? user.id)}</strong></p>
  ${riskNote}
  <p>If you allow it, this agent will be able to act for you:</p>
  ${groups || "<p class=meta>No actions are available yet.</p>"}
  <form method="post" action="${e(action)}">
    <input type="hidden" name="consent_token" value="${e(consentToken)}">
    <button type="submit" name="decision" value="deny">Deny</button>
    <button type="submit" name="decision" value="allow">Allow</button>
  </form>
  <p class="meta">You can disconnect this agent at any time from your account settings.</p>
</main>
</body>
</html>`;
}

export function renderErrorPage(appName: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Can't connect agent</title>
<style>:root{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:16px}main{max-width:480px;margin:40px auto}</style></head>
<body><main><h1>This agent can't connect to ${escapeHtml(appName)}</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}
