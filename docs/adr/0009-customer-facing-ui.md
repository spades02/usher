# ADR 0009: Customer-facing UI. Framework-free custom elements over a cookie-authenticated customer API, and themeable server-rendered pages

- **Status:** Accepted
- **Date:** 2026-11-20
- **Phase:** 8

## Context

Customers meet Usher in four places:

1. **"Connect your agent"**: where they learn that they can bring their own
   assistant, and how.
2. **Consent** (ADR 0004/0005): choosing what an agent may do.
3. **Approval** (ADR 0005): approving one destructive action.
4. **"Connected agents"**: the settings page where they see, restrict or
   disconnect agents. The consent page already promises this ("You can
   change this or disconnect the agent at any time"). Until now, apps had to
   build it themselves from `usher.grants`.

Pages 2 and 3 are server-rendered by Usher and must stay that way: they
are security screens, guarded by CSRF tokens, `frame-ancestors 'none'` and
no JavaScript. Pages 1 and 4 live *inside the app's own UI*, which could be
React, Vue, Svelte, Angular, Rails views or Django templates. And since
Phase 7, the app may not be written in JavaScript at all.

## Options considered

### 1. React components (`@usher/react`), later Vue and Svelte
- ✅ The most common SaaS stack gets the most native API.
- ❌ One package per framework, each re-implementing the same states. Rails
  and Django apps get nothing, which contradicts Phase 7.

### 2. Headless hooks and a JSON API only
- ✅ Total control of the look.
- ❌ Every app rebuilds the same security-sensitive screen (two-step
  disconnect, verified badges, escaping agent-chosen names). The easy path
  should be the safe one.

### 3. Hosted pages only (`{basePath}/account` rendered by Usher)
- ✅ No integration work.
- ❌ It looks like someone else's product inside the app's settings, and
  can't sit next to the app's chatbot.

### 4. Custom elements over a small customer API, plus theming of the server-rendered pages (chosen)
- ✅ One implementation works in every framework (React 19 supports custom
  elements natively) and in plain HTML through `<script src>`.
- ✅ Shadow DOM isolates styles both ways. CSS custom properties and
  `::part()` let the app restyle it.
- ✅ The JSON API underneath is public, so teams that want option 2 have it.
- ❌ Server-side rendering frameworks render an empty shell until the
  script loads (see trade-offs).

## Decision

**Option 4.**

```html
<!-- Any backend: Usher serves the script itself -->
<script src="/api/usher/elements.js"></script>
<usher-connect></usher-connect>   <!-- marketing or help page; works signed out -->
<usher-agents></usher-agents>     <!-- account settings -->
```

```ts
// Bundled apps
import "usherjs/elements";
createUsher({
  theme: { accentColor: "#4f46e5", logoUrl: "/logo.svg", links: { accountSettings: "/settings/agents" } },
  account: { activity: storage.auditSink },
  ...
});
```

### The elements

| Element | Does |
|---|---|
| `<usher-connect>` | Shows the MCP URL with a Copy button, and tabs with steps for ChatGPT, Claude, Cursor, VS Code and "any MCP client". Cursor and VS Code get install deep links. `agents="claude,cursor"` picks the tabs, and `base-path` follows a custom mount |
| `<usher-agents>` | Lists the customer's agents, newest first: name, a *Verified · domain* or *Unverified* badge, and the connection date. Each tool has a checkbox with its effect and "asks you first" note, saved immediately. *Recent activity* is loaded on demand, and *Disconnect* takes two clicks |
| Both | Shadow DOM. Styling through `--usher-accent`, `--usher-accent-text`, `--usher-radius`, `--usher-border`, `--usher-danger` and `::part(title / agent / tools / disconnect / url / copy / install / activity)`. They inherit the page's font and color. Status messages go to an `aria-live` region. They fire `usher-change` and `usher-disconnect` events for the host app |

**Rule for the element code:** every server value is written with
`textContent` or as a DOM property, never as HTML. Agent names are chosen by
agents (DCR is self-asserted), so this is an XSS boundary. Disconnect needs
two clicks rather than `confirm()`, which some embedded webviews block.

**One source, two deliveries.** `installUsherElements(win)` is a single
self-contained function. The npm entry calls it, and `{basePath}/elements.js`
serves its own source text (`Function.prototype.toString`). The two can't
drift apart, and there's no bundler step or second build.

### The customer API (`{basePath}/account/*`)

| Route | |
|---|---|
| `GET info` | Public: app name, MCP URL and tool list |
| `GET agents` | The signed-in customer's agents, plus the tool list |
| `PUT agents/:id` | `{ scopes }`. Known scopes only, and only the customer's own grant. Takes effect on the agent's next call |
| `DELETE agents/:id` | Disconnects. Every token dies |
| `GET activity?agent=` | Audit events for this customer (when `account.activity` is set), with input hashes and user ids removed |

Authentication is the app's own session, through the existing
`IdentityAdapter`. Cookies are sent automatically, so the routes defend
against cross-site requests:

- **`X-Usher-Request: 1` is required** on every signed-in route. A
  cross-site page can't add a custom header without a CORS preflight, and
  these routes send no CORS headers.
- **Changes also require `Origin`** to equal the app's origin (`baseUrl`).
  Browsers always send it on `fetch` writes.
- **Ownership is checked in the API** and again in `usher.grants`. Another
  customer's grant id is a 404.
- **Signed-out requests get `401` with a `login_url`** that returns to the
  referring page, but only when that page is on the app's own origin.

### Theming the server-rendered pages

`theme` sets the accent and text colors, logo, font stack, radius, color
scheme and footer links (account settings, privacy, help). With
`links.accountSettings`, the consent page's "change this at any time" note
links to the page with `<usher-agents>`.

Every value is validated at startup:

- colors must be hex;
- fonts may only use name characters;
- the radius must be 0–24;
- URLs must be `https://` or a same-origin path.

Protocol-relative URLs, `javascript:` and `data:` are rejected, so a theme
can't inject markup, scripts or stylesheets. The pages' CSP grows by
exactly one directive, `img-src <logo origin>`, and only when a logo is set.
The standalone server accepts the same `theme` in its config and enables
the activity feed automatically.

## Why

1. **Custom elements are the only component model every framework, and no
   framework, can use.** That matches Phase 7's promise to apps not written
   in JS: a `<script>` tag on a Rails page gets the same UI as `import` in
   Next.js.
2. **The safe screen is the default screen.** Verified badges, escaping
   agent-chosen names, two-step disconnect and live permission edits are
   easy to get subtly wrong. Shipping them once means every app gets them
   right.
3. **The security pages stay on the server.** Consent and approval keep
   their no-JS, no-framing design and become *brandable* instead of
   *replaceable*. A replaceable consent page would make every app
   responsible for CSRF and for honest scope display, the two things that
   make consent meaningful.
4. **One function, served two ways.** The npm entry and the `<script>` tag
   run byte-identical code, checked in the tests, so there's no second
   artifact to keep in sync.
5. **The API is narrow and customer-scoped.** It exposes only what the
   signed-in customer can already see about themselves. The admin API
   (ADR 0008) stays separate, behind a bearer token, for the app's backend.

## Trade-offs

| We give up | Impact | Mitigation |
|---|---|---|
| A fully custom consent page | Apps can brand consent and approval but not replace their markup | Revisit with a signed "consent request" JSON API if design partners need it. Until then, the screen that grants access stays under Usher's control |
| Server-rendered widgets | SSR frameworks show an empty element until the script loads, and there's no HTML before hydration | The widgets are below the fold on settings pages. A declarative-shadow-DOM render can come later |
| Framework-native ergonomics | React users get `<usher-agents>` rather than `<UsherAgents onDisconnect>` | React 19 passes props and events to custom elements. Thin wrappers can be generated without new behavior |
| English only | Labels and the per-assistant steps are English | Strings are in one place, ready for a `labels` option when there is demand |
| Assistant menu paths can drift | "Settings → Connectors" steps for ChatGPT and Claude, and the Cursor and VS Code deep-link formats, follow those clients' current UIs and need upkeep | The URL and copy button always work. The steps are a convenience, and the docs site (Phase 10) will track them |
| A 403 for requests without the header | Plain HTML forms can't call the account API | By design: that's what blocks cross-site forms. Server-side code uses `usher.grants` or the admin API |
| Unminified script (~18 KB) | Slightly larger than necessary | Served with `max-age=3600`, and it compresses well. Minification arrives with the release tooling (Phase 9) |

## What was built in this phase

```text
src/ui/theme.ts      UsherTheme, resolveTheme: validated branding to CSS variables and CSP
src/ui/account.ts    The customer API: info, agents, scopes, disconnect, activity
src/ui/elements.ts   <usher-connect>, <usher-agents>; ELEMENTS_SCRIPT for {basePath}/elements.js
src/elements.ts      usherjs/elements: registers the elements in the browser (no-op on the server)
```

- New options: `theme` and `account.activity`. The consent, approval, done
  and error pages are themed, and their CSP is computed from the theme.
- The standalone config gains `theme`, and its activity feed is on.
- `package.json` gains the `usherjs/elements` subpath and `happy-dom` (tests
  only).
- Tests (179 total, 22 new):
  - **Customer API:**
    - public info;
    - list, edit and disconnect, where edits take effect as step-up on the
      agent's next call and disconnect kills tokens;
    - cross-site defenses: the header, a missing or foreign `Origin`, no
      CORS on preflight;
    - other customers get 404;
    - unknown scopes are rejected;
    - the signed-out login URL returns to the referring page;
    - activity carries no input hashes or user ids.
  - **Theme:** a branded consent page with exactly one extra CSP source, an
    unchanged default, and seven unsafe values rejected at startup.
  - **Elements, in a real DOM (happy-dom):**
    - the served script equals the npm code and installs idempotently;
    - permission toggles save, and a failed save reverts;
    - activity loads on demand;
    - two-step disconnect;
    - an HTML-named agent renders as text;
    - signed-out customers are asked to sign in;
    - Connect shows the URL, copy works, the tabs and Cursor deep link are
      right, and `base-path` is honored.
  - **Standalone:** serves the widgets and API, and rejects an unsafe theme
    in its config.
  - **Mutation-checked.** These changes were made one at a time, and tests
    failed each time:
    - dropping the header check;
    - accepting a missing Origin;
    - skipping the ownership check;
    - exposing `inputHash`;
    - accepting unknown scopes;
    - ignoring the return page;
    - rendering an agent name as HTML;
    - a one-click disconnect;
    - not reverting a failed save;
    - unvalidated colors;
    - an `http:` logo;
    - a protocol-relative logo;
    - `img-src *`.

## Revisit when

- Design partners need full control of consent → a signed consent-request
  API with the same CSRF and scope-display guarantees.
- Apps ask for other languages → `labels` / locale option.
- SSR matters for these widgets → declarative shadow DOM output from the
  server.
- Assistants change their connector menus → update the guides (Phase 10 docs).
