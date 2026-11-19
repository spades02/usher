import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { sha256 } from "../src/auth/crypto.js";
import { createUsher, defineTool, memoryStore, type AuthStore, type TokenRecord, type Usher } from "../src/index.js";
import {
  AGENT_CIMD,
  AGENT_REDIRECT,
  BASE,
  MCP_URL,
  SECRET,
  authOptions,
  authorizeAgent,
  cimdDocuments,
  connectAgent,
  consentInBrowser,
  identity,
} from "./helpers.js";

const AUTHORIZE = `${BASE}/api/usher/oauth/authorize`;
const TOKEN = `${BASE}/api/usher/oauth/token`;

const whoami = defineTool({
  name: "whoami",
  description: "Returns who the agent is acting for.",
  input: z.object({}),
  effect: "read",
  handler: (_input, { user, agent }) => ({ userId: user.id, agent }),
});
const deleteAccount = defineTool({
  name: "delete_account",
  description: "Permanently deletes the account.",
  input: z.object({}),
  effect: "destructive",
  handler: () => ({ ok: true }),
});

function makeUsher(overrides: Partial<Parameters<typeof createUsher>[0]> = {}): Usher {
  return createUsher({
    ...authOptions,
    app: { name: "Example Shop", version: "1.0.0" },
    tools: [whoami, deleteAccount],
    ...overrides,
  });
}

function mcpCall(usher: Usher, token?: string) {
  return usher.handler(
    new Request(MCP_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } },
      }),
    }),
  );
}

const VERIFIER = "test-verifier-0123456789-abcdefghijklmnopqrstuvwxyz";

function authorizeUrl(params: Record<string, string | null> = {}) {
  const url = new URL(AUTHORIZE);
  const defaults: Record<string, string> = {
    response_type: "code",
    client_id: AGENT_CIMD,
    redirect_uri: AGENT_REDIRECT,
    code_challenge_method: "S256",
    state: "state-123",
    resource: MCP_URL,
  };
  for (const [k, v] of Object.entries({ ...defaults, ...params })) if (v !== null) url.searchParams.set(k, v);
  return url;
}

async function getCode(usher: Usher, userId = "user_1") {
  const url = authorizeUrl({ code_challenge: await sha256(VERIFIER) });
  const callback = await consentInBrowser(usher, url, { userId });
  return callback.searchParams.get("code")!;
}

function tokenRequest(usher: Usher, params: Record<string, string>) {
  return usher.handler(
    new Request(TOKEN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    }),
  );
}

const exchange = (usher: Usher, code: string, verifier = VERIFIER) =>
  tokenRequest(usher, {
    grant_type: "authorization_code",
    code,
    client_id: AGENT_CIMD,
    redirect_uri: AGENT_REDIRECT,
    code_verifier: verifier,
    resource: MCP_URL,
  });

afterEach(() => vi.useRealTimers());

describe("discovery", () => {
  const usher = makeUsher();

  it("answers unauthenticated MCP calls with 401 pointing at resource metadata", async () => {
    const res = await mcpCall(usher);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/api/usher/mcp"`,
    );
  });

  it("serves protected resource metadata at the path-suffixed and root locations", async () => {
    for (const path of ["/.well-known/oauth-protected-resource/api/usher/mcp", "/.well-known/oauth-protected-resource"]) {
      const body = await (await usher.handler(new Request(BASE + path))).json();
      expect(body).toMatchObject({ resource: MCP_URL, authorization_servers: [`${BASE}/api/usher`] });
    }
  });

  it("serves authorization server metadata at the RFC 8414 location", async () => {
    const res = await usher.handler(new Request(`${BASE}/.well-known/oauth-authorization-server/api/usher`));
    expect(await res.json()).toMatchObject({
      issuer: `${BASE}/api/usher`,
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      registration_endpoint: `${BASE}/api/usher/oauth/register`,
    });
  });

  it("uses baseUrl instead of the request origin when configured", async () => {
    const proxied = makeUsher({ baseUrl: BASE });
    const res = await proxied.handler(new Request("http://10.0.0.7:3000/.well-known/oauth-protected-resource"));
    expect((await res.json()).resource).toBe(MCP_URL);
  });
});

describe("connecting an agent", () => {
  it("CIMD agents connect as a verified identity and act for the consenting user", async () => {
    const usher = makeUsher();
    const client = await connectAgent(usher, { userId: "user_1", mode: "cimd" });
    const result = await client.callTool({ name: "whoami", arguments: {} });
    expect(result.structuredContent).toEqual({
      userId: "user_1",
      agent: { clientId: AGENT_CIMD, name: "Test Agent", verified: true },
    });
    await client.close();
  });

  it("DCR agents connect but are marked unverified", async () => {
    const usher = makeUsher();
    const client = await connectAgent(usher, { userId: "user_2", mode: "dcr" });
    const result = await client.callTool({ name: "whoami", arguments: {} });
    expect(result.structuredContent).toMatchObject({ userId: "user_2", agent: { verified: false } });
    await client.close();
  });

  it("each customer's token only ever acts for that customer", async () => {
    const usher = makeUsher();
    const alice = await connectAgent(usher, { userId: "alice" });
    const bob = await connectAgent(usher, { userId: "bob" });
    expect((await alice.callTool({ name: "whoami", arguments: {} })).structuredContent).toMatchObject({ userId: "alice" });
    expect((await bob.callTool({ name: "whoami", arguments: {} })).structuredContent).toMatchObject({ userId: "bob" });
  });

  it("sends signed-out customers to the app's login, then back to the same request", async () => {
    const usher = makeUsher();
    const url = authorizeUrl({ code_challenge: await sha256(VERIFIER) });
    const res = await usher.handler(new Request(url));
    expect(res.status).toBe(302);
    const login = new URL(res.headers.get("location")!);
    expect(login.pathname).toBe("/login");
    const returnTo = new URL(login.searchParams.get("returnTo")!);
    expect(returnTo.pathname).toBe("/api/usher/oauth/authorize");
    expect(returnTo.searchParams.get("client_id")).toBe(AGENT_CIMD);
  });

  it("skips the consent screen for an already-connected agent unless prompt=consent", async () => {
    const usher = makeUsher();
    await getCode(usher);
    const cookie = { cookie: "session=user_1" };
    const again = await usher.handler(new Request(authorizeUrl({ code_challenge: await sha256(VERIFIER) }), { headers: cookie }));
    expect(again.status).toBe(302);
    expect(new URL(again.headers.get("location")!).searchParams.get("code")).toBeTruthy();

    const forced = await usher.handler(
      new Request(authorizeUrl({ code_challenge: await sha256(VERIFIER), prompt: "consent" }), { headers: cookie }),
    );
    expect(forced.status).toBe(200);
  });

  it("returns access_denied, with state and iss, when the customer clicks Deny", async () => {
    const usher = makeUsher();
    const callback = await consentInBrowser(usher, authorizeUrl({ code_challenge: await sha256(VERIFIER) }), { decision: "deny" });
    expect(callback.origin + callback.pathname).toBe(AGENT_REDIRECT);
    expect(callback.searchParams.get("error")).toBe("access_denied");
    expect(callback.searchParams.get("state")).toBe("state-123");
    expect(callback.searchParams.get("iss")).toBe(`${BASE}/api/usher`);
    expect(callback.searchParams.get("code")).toBeNull();
  });
});

describe("consent screen", () => {
  const usher = makeUsher();
  const page = async (params: Record<string, string | null> = {}) =>
    usher.handler(
      new Request(authorizeUrl({ code_challenge: await sha256(VERIFIER), ...params }), {
        headers: { cookie: "session=user_1" },
      }),
    );

  it("names the agent and its verified domain, and flags irreversible actions", async () => {
    const html = await (await page()).text();
    expect(html).toContain("Test Agent wants to access your Example Shop account");
    expect(html).toContain("Verified domain: <strong>agent.example</strong>");
    expect(html).toMatch(/class="destructive">Irreversible actions<\/h3><ul><li><strong>delete_account/);
  });

  it("cannot be framed or cached", async () => {
    const res = await page();
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("escapes agent-supplied names", async () => {
    const reg = await usher.handler(
      new Request(`${BASE}/api/usher/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "<script>alert(1)</script>", redirect_uris: [AGENT_REDIRECT] }),
      }),
    );
    const { client_id } = await reg.json();
    const html = await (await page({ client_id })).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("self-declared");
  });

  it("warns when the agent redirects to a local program", async () => {
    const reg = await usher.handler(
      new Request(`${BASE}/api/usher/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "CLI agent", redirect_uris: ["http://127.0.0.1:8765/cb"] }),
      }),
    );
    const { client_id } = await reg.json();
    const html = await (await page({ client_id, redirect_uri: "http://127.0.0.1:8765/cb" })).text();
    expect(html).toContain("a program running on your own device");
  });
});

describe("authorization request validation", () => {
  const usher = makeUsher();
  const asUser = { headers: { cookie: "session=user_1" } };

  it("never redirects to an unregistered redirect_uri (open redirect)", async () => {
    const res = await usher.handler(
      new Request(authorizeUrl({ code_challenge: await sha256(VERIFIER), redirect_uri: "https://evil.example/cb" }), asUser),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("requires PKCE S256", async () => {
    const res = await usher.handler(new Request(authorizeUrl(), asUser));
    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("invalid_request");
    expect(location.searchParams.get("iss")).toBe(`${BASE}/api/usher`);
  });

  it("refuses tokens for any other resource", async () => {
    const res = await usher.handler(
      new Request(authorizeUrl({ code_challenge: await sha256(VERIFIER), resource: "https://other.example/mcp" }), asUser),
    );
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("invalid_target");
  });

  it("rejects a CIMD document whose client_id doesn't match its URL", async () => {
    const impostor = "https://agent.example/oauth/impostor.json";
    cimdDocuments.set(impostor, { client_id: AGENT_CIMD, client_name: "Impostor", redirect_uris: [AGENT_REDIRECT] });
    const res = await usher.handler(
      new Request(authorizeUrl({ code_challenge: await sha256(VERIFIER), client_id: impostor }), asUser),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("does not match");
  });

  it.each(["https://localhost/c.json", "https://10.0.0.5/c.json", "https://169.254.169.254/c.json", "https://db.internal/c.json"])(
    "won't fetch CIMD documents from private address %s (SSRF)",
    async (clientId) => {
      let fetched = false;
      const guarded = makeUsher({
        auth: { fetchClientMetadata: async () => ((fetched = true), new Response("{}")) },
      });
      const res = await guarded.handler(
        new Request(authorizeUrl({ code_challenge: await sha256(VERIFIER), client_id: clientId }), asUser),
      );
      expect(res.status).toBe(400);
      expect(fetched).toBe(false);
    },
  );
});

describe("consent form CSRF protection", () => {
  const usher = makeUsher();

  async function consentToken() {
    const res = await usher.handler(
      new Request(authorizeUrl({ code_challenge: await sha256(VERIFIER) }), { headers: { cookie: "session=user_1" } }),
    );
    return (await res.text()).match(/name="consent_token" value="([^"]+)"/)![1]!;
  }
  const submit = (token: string, headers: Record<string, string>) =>
    usher.handler(
      new Request(AUTHORIZE, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
        body: new URLSearchParams({ consent_token: token, decision: "allow" }),
      }),
    );

  it("rejects a tampered consent token", async () => {
    const token = await consentToken();
    const tampered = `${token.slice(0, -2)}xx`;
    expect((await submit(tampered, { cookie: "session=user_1" })).status).toBe(400);
  });

  it("rejects a consent token submitted by a different signed-in user", async () => {
    expect((await submit(await consentToken(), { cookie: "session=mallory" })).status).toBe(403);
  });

  it("rejects cross-site form posts", async () => {
    const res = await submit(await consentToken(), { cookie: "session=user_1", origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });
});

describe("token endpoint", () => {
  it("rejects a wrong PKCE verifier", async () => {
    const usher = makeUsher();
    const res = await exchange(usher, await getCode(usher), "wrong-verifier-0123456789-abcdefghijklmnopqrstuvwxyz");
    expect(await res.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("on authorization code replay, refuses and revokes everything issued from it", async () => {
    const usher = makeUsher();
    const code = await getCode(usher);
    const first = await (await exchange(usher, code)).json();
    expect((await mcpCall(usher, first.access_token)).status).toBe(200);

    const replay = await exchange(usher, code);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });
    expect((await mcpCall(usher, first.access_token)).status).toBe(401);
  });

  it("rotates refresh tokens and revokes the grant if an old one is reused", async () => {
    const usher = makeUsher();
    const first = await (await exchange(usher, await getCode(usher))).json();
    const refresh = (token: string) =>
      tokenRequest(usher, { grant_type: "refresh_token", refresh_token: token, client_id: AGENT_CIMD });

    const second = await (await refresh(first.refresh_token)).json();
    expect(second.access_token).toBeTruthy();
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect((await mcpCall(usher, second.access_token)).status).toBe(200);

    // An attacker replays the stolen, already-rotated refresh token.
    expect(await (await refresh(first.refresh_token)).json()).toMatchObject({ error: "invalid_grant" });
    expect((await mcpCall(usher, second.access_token)).status).toBe(401);
  });

  it("expires access tokens", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const usher = makeUsher({ auth: { ...authOptions.auth, accessTokenTtl: 60 } });
    const tokens = await (await exchange(usher, await getCode(usher))).json();
    expect((await mcpCall(usher, tokens.access_token)).status).toBe(200);
    vi.setSystemTime(Date.now() + 61_000);
    const res = await mcpCall(usher, tokens.access_token);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("stores only hashes of codes and tokens", async () => {
    const saved: TokenRecord[] = [];
    const inner = memoryStore();
    const spy: AuthStore = { ...inner, saveToken: async (t) => (saved.push(t), inner.saveToken(t)) };
    const usher = makeUsher({ store: spy });
    const tokens = await (await exchange(usher, await getCode(usher))).json();
    const stored = JSON.stringify(saved);
    expect(stored).not.toContain(tokens.access_token);
    expect(stored).not.toContain(tokens.refresh_token);
    expect(saved.map((t) => t.hash)).toContain(await sha256(tokens.access_token));
  });
});

describe("disconnecting agents", () => {
  it("lets the customer list and revoke connected agents, instantly", async () => {
    const usher = makeUsher();
    const { accessToken } = await authorizeAgent(usher, { userId: "user_1" });
    const grants = await usher.grants.list("user_1");
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ clientName: "Test Agent", clientSource: "cimd" });

    // Another user can't revoke it.
    await usher.grants.revoke("mallory", grants[0]!.id);
    expect((await mcpCall(usher, accessToken)).status).toBe(200);

    await usher.grants.revoke("user_1", grants[0]!.id);
    expect((await mcpCall(usher, accessToken)).status).toBe(401);
    expect(await usher.grants.list("user_1")).toHaveLength(0);
  });

  it("supports RFC 7009 token revocation by the agent", async () => {
    const usher = makeUsher();
    const { accessToken } = await authorizeAgent(usher);
    const res = await usher.handler(
      new Request(`${BASE}/api/usher/oauth/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: accessToken, client_id: AGENT_CIMD }),
      }),
    );
    expect(res.status).toBe(200);
    expect((await mcpCall(usher, accessToken)).status).toBe(401);
  });
});

describe("dynamic client registration", () => {
  const register = (usher: Usher, body: unknown) =>
    usher.handler(
      new Request(`${BASE}/api/usher/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  it.each([["javascript:alert(1)"], ["http://evil.example/cb"], ["https://agent.example/cb#frag"]])(
    "rejects dangerous redirect URI %s",
    async (uri) => {
      const res = await register(makeUsher(), { client_name: "x", redirect_uris: [uri] });
      expect(await res.json()).toMatchObject({ error: "invalid_redirect_uri" });
    },
  );

  it("accepts app schemes and loopback for native agents", async () => {
    const res = await register(makeUsher(), {
      client_name: "Desktop agent",
      redirect_uris: ["cursor://anysphere.cursor/oauth/callback", "http://127.0.0.1:33418/cb"],
      application_type: "native",
    });
    expect(res.status).toBe(201);
  });

  it("can be switched off, leaving CIMD only", async () => {
    const usher = makeUsher({ auth: { ...authOptions.auth, dynamicClientRegistration: false } });
    const meta = await (await usher.handler(new Request(`${BASE}/.well-known/oauth-authorization-server/api/usher`))).json();
    expect(meta.registration_endpoint).toBeUndefined();
    expect((await register(usher, { client_name: "x", redirect_uris: [AGENT_REDIRECT] })).status).toBe(404);
  });
});

describe("startup checks", () => {
  it("requires a strong secret", () => {
    expect(() => makeUsher({ secret: "short" })).toThrow(/at least 32 characters/);
  });
  it("requires an identity adapter", () => {
    expect(() => makeUsher({ identity: {} as never })).toThrow(/identity/);
  });
  it("accepts the documented options", () => {
    expect(() => makeUsher({ identity, secret: SECRET })).not.toThrow();
  });
});
