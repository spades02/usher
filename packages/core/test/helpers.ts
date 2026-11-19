import {
  Client,
  StreamableHTTPClientTransport,
  auth,
  type OAuthClientProvider,
} from "@modelcontextprotocol/client";
import { expect } from "vitest";
import type { IdentityAdapter, Usher, UsherOptions } from "../src/index.js";

export const BASE = "https://shop.example";
export const MCP_URL = `${BASE}/api/usher/mcp`;
export const SECRET = "test-secret-0123456789-abcdefghijklmnop";

/** Fake app auth: the `session` cookie holds the user id. */
export const identity: IdentityAdapter = {
  getUser(request) {
    const id = request.headers.get("cookie")?.match(/session=([^;]+)/)?.[1];
    return id ? { id, name: `User ${id}` } : null;
  },
  loginUrl: (returnTo) => `${BASE}/login?returnTo=${encodeURIComponent(returnTo)}`,
};

export const AGENT_CIMD = "https://agent.example/oauth/client.json";
export const AGENT_REDIRECT = "https://agent.example/callback";

/** Client ID Metadata Documents "hosted" on the internet, for the in-process fetch. */
export const cimdDocuments = new Map<string, unknown>([
  [
    AGENT_CIMD,
    {
      client_id: AGENT_CIMD,
      client_name: "Test Agent",
      redirect_uris: [AGENT_REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
  ],
]);

export const authOptions = {
  identity,
  secret: SECRET,
  auth: {
    fetchClientMetadata: async (url: URL) => {
      const doc = cimdDocuments.get(url.toString());
      return doc ? Response.json(doc) : new Response("Not found", { status: 404 });
    },
  },
} satisfies Partial<UsherOptions>;

/** An agent's OAuth state, kept in memory, the way ChatGPT or Claude would persist it. */
export class MemoryProvider implements OAuthClientProvider {
  authorizationUrl?: URL;
  private info: any;
  private savedTokens: any;
  private verifier = "";

  constructor(private readonly mode: "cimd" | "dcr") {}

  get redirectUrl() {
    return AGENT_REDIRECT;
  }
  get clientMetadataUrl() {
    return this.mode === "cimd" ? AGENT_CIMD : undefined;
  }
  get clientMetadata() {
    return {
      client_name: "Test Agent",
      redirect_uris: [AGENT_REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "web",
    };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: unknown) {
    this.info = info;
  }
  tokens() {
    return this.savedTokens;
  }
  saveTokens(tokens: unknown) {
    this.savedTokens = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  private discovery: any;
  saveDiscoveryState(state: unknown) {
    this.discovery = state;
  }
  discoveryState() {
    return this.discovery;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
}

export const fetchVia = (usher: Usher) => (input: RequestInfo | URL, init?: RequestInit) =>
  usher.handler(new Request(input, init));

/** Checkbox values on a consent page: every offered scope, and the ones ticked by default. */
export function consentScopes(html: string) {
  const boxes = [...html.matchAll(/<input type="checkbox" name="scope" value="([^"]+)"( checked)?>/g)];
  return { offered: boxes.map((m) => m[1]!), checked: boxes.filter((m) => m[2]).map((m) => m[1]!) };
}

export interface ConsentOptions {
  userId?: string;
  decision?: "allow" | "deny";
  /** Scopes to tick before submitting. Default: whatever the page pre-ticks. */
  scopes?: string[];
}

/** Plays the customer's browser on the consent screen. Returns the agent callback URL. */
export async function consentInBrowser(
  usher: Usher,
  authorizationUrl: URL | string,
  { userId = "user_1", decision = "allow", scopes }: ConsentOptions = {},
): Promise<URL> {
  const cookie = `session=${userId}`;
  const page = await usher.handler(new Request(authorizationUrl, { headers: { cookie } }));
  if (page.status === 302) return new URL(page.headers.get("location")!);

  expect(page.status).toBe(200);
  const html = await page.text();
  const consentToken = html.match(/name="consent_token" value="([^"]+)"/)?.[1];
  expect(consentToken).toBeTruthy();

  const decided = await usher.handler(
    new Request(`${BASE}/api/usher/oauth/authorize`, {
      method: "POST",
      headers: { cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams([
        ["consent_token", consentToken!],
        ["decision", decision],
        ...(scopes ?? consentScopes(html).checked).map((s) => ["scope", s]),
      ]),
    }),
  );
  expect(decided.status).toBe(302);
  return new URL(decided.headers.get("location")!);
}

/** Runs the full MCP authorization flow with the official SDK client. */
export async function authorizeAgent(
  usher: Usher,
  { userId = "user_1", mode = "cimd", scopes }: { userId?: string; mode?: "cimd" | "dcr"; scopes?: string[] } = {},
) {
  const provider = new MemoryProvider(mode);
  const fetchFn = fetchVia(usher);

  expect(await auth(provider, { serverUrl: MCP_URL, fetchFn })).toBe("REDIRECT");
  const callback = await consentInBrowser(usher, provider.authorizationUrl!, { userId, scopes });
  const code = callback.searchParams.get("code");
  expect(code).toBeTruthy();

  const result = await auth(provider, {
    serverUrl: MCP_URL,
    authorizationCode: code!,
    iss: callback.searchParams.get("iss") ?? undefined,
    fetchFn,
  });
  expect(result).toBe("AUTHORIZED");
  return { provider, accessToken: provider.tokens().access_token as string, refreshToken: provider.tokens().refresh_token as string };
}

/** An authorized, connected MCP client acting for `userId`. */
export async function connectAgent(
  usher: Usher,
  opts: { userId?: string; mode?: "cimd" | "dcr"; scopes?: string[] } = {},
) {
  const { provider } = await authorizeAgent(usher, opts);
  const client = new Client({ name: "test-agent", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { fetch: fetchVia(usher), authProvider: provider });
  await client.connect(transport);
  return Object.assign(client, { provider, http: transport });
}
