import { needsConfirmation, toolScope, type AnyUsherTool, type ToolEffect } from "../tool.js";
import { redirectRisk } from "./clients.js";
import type { ClientRecord, ConfirmationRecord } from "./store.js";
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
  /** The tools offered for approval (requested, plus any already granted). */
  tools: readonly AnyUsherTool[];
  /** Scopes whose checkbox starts ticked. */
  checked: ReadonlySet<string>;
  /** True when the agent is already connected and asks for more. */
  update: boolean;
  action: string;
  consentToken: string;
}): string {
  const { appName, client, user, redirectUri, tools, checked, update, action, consentToken } = input;
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
        .map((t) => {
          const scope = toolScope(t.name);
          const note = needsConfirmation(t) ? `<span class="meta"> Asks you before each use.</span>` : "";
          return `<li><label><input type="checkbox" name="scope" value="${e(scope)}"${checked.has(scope) ? " checked" : ""}> <strong>${e(t.title ?? t.name)}</strong> — ${e(t.description)}</label>${note}</li>`;
        })
        .join("")}</ul>`;
    })
    .join("");

  return page(
    `Connect ${e(client.clientName)} to ${e(appName)}`,
    `<h1>${e(client.clientName)} wants ${update ? "more " : ""}access to your ${e(appName)} account</h1>
  ${identity}
  <p class="meta">Signed in as <strong>${e(user.name ?? user.email ?? user.id)}</strong></p>
  ${riskNote}
  <form method="post" action="${e(action)}">
    <p>Choose what this agent may do for you:</p>
    ${groups || "<p class=meta>No actions are available yet.</p>"}
    <input type="hidden" name="consent_token" value="${e(consentToken)}">
    <div class="buttons">
      <button type="submit" name="decision" value="deny">Deny</button>
      <button type="submit" name="decision" value="allow">Allow selected</button>
    </div>
  </form>
  <p class="meta">You can change this or disconnect the agent at any time from your account settings.</p>`,
  );
}

/** The customer approves or rejects one specific action an agent wants to take (ADR 0005). */
export function renderConfirmPage(input: {
  appName: string;
  confirmation: ConfirmationRecord;
  tool: AnyUsherTool;
  verified: boolean;
  user: UsherUser;
  action: string;
  confirmToken: string;
}): string {
  const { appName, confirmation: c, tool, verified, user, action, confirmToken } = input;
  const e = escapeHtml;
  return page(
    `Approve action in ${e(appName)}`,
    `<h1>${e(c.clientName)} wants to: ${e(c.summary)}</h1>
  ${verified ? "" : `<p class="meta warn">This agent's identity is self-declared and could not be verified.</p>`}
  <p class="meta">Signed in as <strong>${e(user.name ?? user.email ?? user.id)}</strong></p>
  <h3 class="${tool.effect}">${EFFECT_LABEL[tool.effect]}: ${e(tool.title ?? tool.name)}</h3>
  <p>${e(tool.description)}</p>
  <details><summary class="meta">Exact details</summary><pre>${e(c.details)}</pre></details>
  <p class="meta">Only approve if you asked your agent to do this. This approval works once, for exactly these details.</p>
  <form method="post" action="${e(action)}">
    <input type="hidden" name="confirm_token" value="${e(confirmToken)}">
    <div class="buttons">
      <button type="submit" name="decision" value="deny">Don't do it</button>
      <button type="submit" name="decision" value="allow">Approve</button>
    </div>
  </form>`,
  );
}

/** Shown after a decision: the customer goes back to their agent. */
export function renderDonePage(appName: string, heading: string, message: string): string {
  return page(`${escapeHtml(heading)} - ${escapeHtml(appName)}`, `<h1>${escapeHtml(heading)}</h1><p>${escapeHtml(message)}</p>`);
}

export function renderErrorPage(appName: string, message: string, heading = `This agent can't connect to ${appName}`): string {
  return page("Something went wrong", `<h1>${escapeHtml(heading)}</h1><p>${escapeHtml(message)}</p>`);
}

const STYLE = `
  :root { color-scheme: light dark; --fg:#111; --bg:#fff; --muted:#555; --warn:#9a3412; --line:#ddd; --accent:#111; --accent-fg:#fff; }
  @media (prefers-color-scheme: dark) { :root { --fg:#eee; --bg:#111; --muted:#aaa; --warn:#fdba74; --line:#333; --accent:#eee; --accent-fg:#111; } }
  body { font: 16px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); margin: 0; padding: 16px; }
  main { max-width: 480px; margin: 40px auto; }
  h1 { font-size: 1.35rem; margin: 0 0 8px; }
  h3 { font-size: .95rem; margin: 20px 0 4px; }
  h3.destructive { color: var(--warn); }
  ul { margin: 0; padding: 0; list-style: none; } li { margin: 6px 0; }
  label { cursor: pointer; } input[type=checkbox] { margin: 0 6px 0 0; }
  pre { white-space: pre-wrap; word-break: break-word; font-size: .85rem; border: 1px solid var(--line); border-radius: 8px; padding: 8px; }
  .meta { color: var(--muted); font-size: .9rem; margin: 4px 0; }
  .warn { color: var(--warn); }
  .buttons { display: flex; gap: 12px; margin-top: 28px; }
  button { flex: 1; font: inherit; padding: 10px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--fg); cursor: pointer; }
  button[value=allow] { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }`;

/** `title` must already be escaped. */
function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  ${body}
</main>
</body>
</html>`;
}
