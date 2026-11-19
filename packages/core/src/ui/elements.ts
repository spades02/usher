/**
 * `<usher-connect>` and `<usher-agents>`: framework-free custom elements for
 * the app's own pages (ADR 0009). They work in React, Vue, Svelte, Angular,
 * Rails views or plain HTML.
 *
 * This function is also served as a standalone script at
 * `{basePath}/elements.js` (via `Function.prototype.toString`), so it must
 * be self-contained: it touches the page only through `win` and references
 * nothing from module scope.
 *
 * Every value from the server is written with `textContent` or as a
 * property, never as HTML. Agent names are chosen by agents.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function installUsherElements(win: any): void {
  if (!win?.customElements || win.customElements.get("usher-agents")) return;
  const doc = win.document;

  type Child = Node | string | null | undefined | false;
  function h(tag: string, props: Record<string, unknown> = {}, ...children: Child[]): HTMLElement {
    const el = doc.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
      else if (key === "part" || key.startsWith("aria-") || key === "role" || key === "for" || key === "slot" || key === "name") {
        el.setAttribute(key, String(value));
      } else (el as unknown as Record<string, unknown>)[key] = value;
    }
    for (const child of children) {
      if (child === null || child === undefined || child === false) continue;
      el.append(typeof child === "string" ? doc.createTextNode(child) : child);
    }
    return el;
  }

  const CSS = `
    :host { display: block; font: inherit; color: inherit; line-height: 1.5;
      --_accent: var(--usher-accent, currentColor); --_accent-fg: var(--usher-accent-text, Canvas);
      --_radius: var(--usher-radius, 8px);
      --_line: var(--usher-border, color-mix(in srgb, currentColor 18%, transparent));
      --_muted: color-mix(in srgb, currentColor 62%, transparent);
      --_warn: var(--usher-danger, #b42318); }
    * { box-sizing: border-box; }
    h2 { font-size: 1.1em; margin: 0 0 4px; } h3 { font-size: 1em; margin: 0; }
    p { margin: 4px 0; }
    .muted { color: var(--_muted); font-size: .9em; }
    .card { border: 1px solid var(--_line); border-radius: var(--_radius); padding: 14px 16px; margin: 12px 0; }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .grow { flex: 1; min-width: 0; }
    button, .button { font: inherit; padding: 6px 12px; border-radius: var(--_radius); border: 1px solid var(--_line);
      background: transparent; color: inherit; cursor: pointer; text-decoration: none; display: inline-block; }
    button.primary, .button.primary { background: var(--_accent); color: var(--_accent-fg); border-color: var(--_accent); }
    button.danger { color: var(--_warn); border-color: currentColor; }
    button:disabled { opacity: .55; cursor: default; }
    button:focus-visible, input:focus-visible, a:focus-visible { outline: 2px solid var(--_accent); outline-offset: 2px; }
    input[type=text] { font: inherit; width: 100%; padding: 6px 10px; border: 1px solid var(--_line);
      border-radius: var(--_radius); background: transparent; color: inherit; }
    ul { list-style: none; padding: 0; margin: 8px 0 0; } li { margin: 6px 0; }
    label { display: flex; gap: 8px; align-items: flex-start; cursor: pointer; }
    input[type=checkbox] { margin-top: .3em; }
    .badge { font-size: .8em; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--_line); }
    .badge.unverified { color: var(--_warn); }
    .tabs { display: flex; gap: 4px; margin: 12px 0 8px; flex-wrap: wrap; }
    .tabs button[aria-selected=true] { border-color: var(--_accent); font-weight: 600; }
    ol { margin: 4px 0; padding-left: 20px; }
    .destructive { color: var(--_warn); }
    .actions { margin-top: 12px; }
    .status:empty { display: none; }`;

  type Json = Record<string, any>;

  function api(el: HTMLElement, path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
    const base = (el.getAttribute("base-path") ?? "/api/usher").replace(/\/+$/, "");
    const headers: Record<string, string> = { "x-usher-request": "1", accept: "application/json" };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    return win.fetch(`${base}/account/${path}`, {
      method: init.method ?? "GET",
      headers,
      credentials: "same-origin",
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  }

  function emit(el: HTMLElement, type: string, detail: unknown) {
    el.dispatchEvent(new win.CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  class Base extends win.HTMLElement {
    root: ShadowRoot;
    status: HTMLElement;
    constructor() {
      super();
      this.root = (this as unknown as HTMLElement).attachShadow({ mode: "open" });
      this.status = h("p", { className: "status muted", role: "status", "aria-live": "polite" });
    }
    render(...children: Child[]) {
      const style = doc.createElement("style");
      style.textContent = CSS;
      this.root.replaceChildren(style, ...children.filter((c): c is Node | string => !!c), this.status);
    }
    say(message: string) {
      this.status.textContent = message;
    }
  }

  // ------------------------------------------------------------ usher-connect

  type Guide = { label: string; steps: string[]; link?: (name: string, url: string) => { href: string; text: string } };
  const GUIDES: Record<string, Guide> = {
    chatgpt: {
      label: "ChatGPT",
      steps: [
        "In ChatGPT, open Settings, then Apps & Connectors.",
        "Create a connector (you may need to turn on developer mode first) and paste the URL above.",
        "Sign in to {app} when asked, and choose what ChatGPT may do.",
      ],
    },
    claude: {
      label: "Claude",
      steps: [
        "In Claude, open Settings, then Connectors.",
        "Choose Add custom connector and paste the URL above.",
        "Select Connect, sign in to {app}, and choose what Claude may do.",
      ],
    },
    cursor: {
      label: "Cursor",
      steps: ["Use the button below, or add the URL above as a remote MCP server in Cursor's settings.", "Sign in to {app} when Cursor asks."],
      link: (name, url) => ({
        href: `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(name)}&config=${win.btoa(JSON.stringify({ url }))}`,
        text: "Add to Cursor",
      }),
    },
    vscode: {
      label: "VS Code",
      steps: ["Use the button below, or run “MCP: Add Server” and choose HTTP with the URL above.", "Sign in to {app} when VS Code asks."],
      link: (name, url) => ({
        href: `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name, type: "http", url }))}`,
        text: "Add to VS Code",
      }),
    },
    other: {
      label: "Other",
      steps: [
        "Any assistant that supports remote MCP servers can connect.",
        "Add the URL above as a remote (HTTP) MCP server, then sign in to {app} when asked.",
      ],
    },
  };

  class UsherConnect extends Base {
    info: Json | null = null;
    selected = "";
    connectedCallback() {
      void this.load();
    }
    async load() {
      try {
        const res = await api(this as unknown as HTMLElement, "info");
        if (!res.ok) throw new Error(String(res.status));
        this.info = (await res.json()) as Json;
        this.draw();
      } catch {
        this.render(h("p", {}, "Couldn't load connection details."));
      }
    }
    agents(): string[] {
      const wanted = ((this as unknown as HTMLElement).getAttribute("agents") ?? "chatgpt,claude,cursor,vscode,other")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => GUIDES[s]);
      return wanted.length ? wanted : ["other"];
    }
    draw() {
      const info = this.info!;
      const app = String(info.app.name);
      const url = String(info.mcpUrl);
      const agents = this.agents();
      if (!agents.includes(this.selected)) this.selected = agents[0]!;
      const guide = GUIDES[this.selected]!;

      const field = h("input", { type: "text", readOnly: true, value: url, "aria-label": "Connection URL", part: "url" }) as HTMLInputElement;
      const copy = h(
        "button",
        {
          type: "button",
          className: "primary",
          part: "copy",
          onclick: async () => {
            try {
              await win.navigator.clipboard.writeText(url);
              this.say("Copied.");
            } catch {
              field.select();
              this.say("Press Ctrl+C (or ⌘C) to copy.");
            }
          },
        },
        "Copy",
      );
      const tabs = h(
        "div",
        { className: "tabs", role: "tablist", "aria-label": "Your assistant" },
        ...agents.map((id) =>
          h(
            "button",
            {
              type: "button",
              role: "tab",
              "aria-selected": String(id === this.selected),
              onclick: () => {
                this.selected = id;
                this.draw();
              },
            },
            GUIDES[id]!.label,
          ),
        ),
      );
      const link = guide.link?.(app, url);
      this.render(
        h("h2", { part: "title" }, `Connect your AI assistant to ${app}`),
        h("p", { className: "muted" }, "Use the assistant you already have. It will ask you to sign in and choose what it may do. You can disconnect it at any time."),
        h("div", { className: "row" }, h("div", { className: "grow" }, field), copy),
        tabs,
        h("ol", { role: "tabpanel" }, ...guide.steps.map((s) => h("li", {}, s.split("{app}").join(app)))),
        link ? h("a", { className: "button", href: link.href, part: "install" }, link.text) : null,
      );
    }
  }

  // ------------------------------------------------------------- usher-agents

  const EFFECT: Record<string, string> = { read: "View", write: "Make changes", destructive: "Irreversible" };

  function describe(event: Json): string {
    const when = new Date(event.at).toLocaleString();
    switch (event.type) {
      case "call": {
        const outcome: Record<string, string> = {
          success: "used",
          tool_error: "tried (it didn't work)",
          failed: "tried (something went wrong)",
          forbidden: "was blocked from",
          confirmation_required: "asked for your approval to use",
          declined: "was declined for",
          denied: "was stopped from using",
        };
        return `${when}: ${outcome[event.outcome] ?? "used"} ${event.tool}`;
      }
      case "confirmation.decided":
        return `${when}: you ${event.approved ? "approved" : "declined"} “${event.summary}”`;
      case "grant.created":
        return `${when}: connected`;
      case "grant.updated":
        return `${when}: permissions changed`;
      case "grant.revoked":
        return `${when}: disconnected`;
      default:
        return `${when}: ${event.type}`;
    }
  }

  class UsherAgents extends Base {
    data: Json | null = null;
    connectedCallback() {
      void this.load();
    }
    async load() {
      this.render(h("p", { className: "muted" }, "Loading connected agents…"));
      try {
        const res = await api(this as unknown as HTMLElement, "agents");
        if (res.status === 401) {
          const body = (await res.json()) as Json;
          this.render(
            h("p", {}, "Sign in to manage the AI agents connected to your account."),
            typeof body.login_url === "string" ? h("a", { className: "button primary", href: body.login_url }, "Sign in") : null,
          );
          return;
        }
        if (!res.ok) throw new Error(String(res.status));
        this.data = (await res.json()) as Json;
        this.draw();
      } catch {
        this.render(h("p", {}, "Couldn't load your connected agents. Try again later."));
      }
    }
    draw() {
      const { agents, tools } = this.data!;
      if (agents.length === 0) {
        this.render(
          h("h2", { part: "title" }, "Connected agents"),
          h("p", { className: "muted" }, "No AI agents are connected to your account."),
          h("slot", { name: "empty" }),
        );
        return;
      }
      this.render(
        h("h2", { part: "title" }, "Connected agents"),
        h("p", { className: "muted" }, "These assistants can act for you. Choose what each may do, or disconnect it."),
        ...agents.map((agent: Json) => this.card(agent, tools)),
      );
    }
    card(agent: Json, tools: Json[]): HTMLElement {
      const self = this as unknown as HTMLElement;
      const badge = agent.verified
        ? h("span", { className: "badge", title: "Its identity is proven by its web domain" }, `Verified · ${agent.domain ?? ""}`)
        : h("span", { className: "badge unverified", title: "This agent named itself; its identity couldn't be verified" }, "Unverified");

      const boxes: HTMLInputElement[] = [];
      const save = async () => {
        const scopes = boxes.filter((b) => b.checked).map((b) => b.value);
        boxes.forEach((b) => (b.disabled = true));
        try {
          const res = await api(self, `agents/${encodeURIComponent(agent.id)}`, { method: "PUT", body: { scopes } });
          if (!res.ok) throw new Error(String(res.status));
          agent.scopes = ((await res.json()) as Json).agent.scopes;
          this.say(`Saved. ${agent.name} can use ${agent.scopes.length} of ${tools.length} actions.`);
          emit(self, "usher-change", { agent });
        } catch {
          boxes.forEach((b) => (b.checked = agent.scopes.includes(b.value)));
          this.say("Couldn't save that change. Try again.");
        } finally {
          boxes.forEach((b) => (b.disabled = false));
        }
      };
      const list = h(
        "ul",
        { part: "tools" },
        ...tools.map((tool: Json) => {
          const box = h("input", { type: "checkbox", value: tool.scope, checked: agent.scopes.includes(tool.scope), onchange: save }) as HTMLInputElement;
          boxes.push(box);
          return h(
            "li",
            {},
            h(
              "label",
              {},
              box,
              h(
                "span",
                {},
                h("strong", {}, tool.title),
                " ",
                h("span", { className: `muted ${tool.effect}` }, `${EFFECT[tool.effect] ?? tool.effect}${tool.asksFirst ? " · asks you first" : ""}`),
                h("br"),
                h("span", { className: "muted" }, tool.description),
              ),
            ),
          );
        }),
      );

      const activity = h("ul", { part: "activity", hidden: true });
      const activityButton = this.data!.activity
        ? h(
            "button",
            {
              type: "button",
              "aria-expanded": "false",
              onclick: async (e: Event) => {
                const button = e.currentTarget as HTMLButtonElement;
                const open = button.getAttribute("aria-expanded") !== "true";
                button.setAttribute("aria-expanded", String(open));
                activity.hidden = !open;
                if (!open) return;
                activity.replaceChildren(h("li", { className: "muted" }, "Loading…"));
                try {
                  const res = await api(self, `activity?agent=${encodeURIComponent(agent.id)}&limit=10`);
                  const { events } = (await res.json()) as Json;
                  activity.replaceChildren(
                    ...(events.length ? events.map((ev: Json) => h("li", { className: "muted" }, describe(ev))) : [h("li", { className: "muted" }, "No activity yet.")]),
                  );
                } catch {
                  activity.replaceChildren(h("li", { className: "muted" }, "Couldn't load activity."));
                }
              },
            },
            "Recent activity",
          )
        : null;

      // Two-step disconnect, without a blocking confirm() dialog.
      const disconnect = h("button", { type: "button", className: "danger", part: "disconnect" }, "Disconnect") as HTMLButtonElement;
      const cancel = h("button", { type: "button", hidden: true }, "Keep connected") as HTMLButtonElement;
      let armed = false;
      cancel.addEventListener("click", () => {
        armed = false;
        disconnect.textContent = "Disconnect";
        cancel.hidden = true;
      });
      disconnect.addEventListener("click", async () => {
        if (!armed) {
          armed = true;
          disconnect.textContent = `Yes, disconnect ${agent.name}`;
          cancel.hidden = false;
          return;
        }
        disconnect.disabled = true;
        try {
          const res = await api(self, `agents/${encodeURIComponent(agent.id)}`, { method: "DELETE" });
          if (!res.ok && res.status !== 404) throw new Error(String(res.status));
          this.data!.agents = this.data!.agents.filter((a: Json) => a.id !== agent.id);
          this.draw();
          this.say(`${agent.name} was disconnected. It can't act for you any more.`);
          emit(self, "usher-disconnect", { agent });
        } catch {
          disconnect.disabled = false;
          this.say("Couldn't disconnect. Try again.");
        }
      });

      return h(
        "section",
        { className: "card", part: "agent" },
        h("div", { className: "row" }, h("h3", { className: "grow" }, agent.name), badge),
        h("p", { className: "muted" }, `Connected ${new Date(agent.connectedAt).toLocaleDateString()}`),
        list,
        h("div", { className: "row actions" }, activityButton, h("span", { className: "grow" }), cancel, disconnect),
        activity,
      );
    }
  }

  win.customElements.define("usher-connect", UsherConnect);
  win.customElements.define("usher-agents", UsherAgents);
}

/** The same code as a classic script, served at `{basePath}/elements.js` for any backend. */
export const ELEMENTS_SCRIPT = `/* Usher elements (ADR 0009) */\n(${installUsherElements.toString()})(window);\n`;
