import type { AuthStore, ClientRecord } from "./store.js";

export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
  }
}

const MAX_METADATA_BYTES = 64 * 1024;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 1000;

export type MetadataFetch = (url: URL, init: RequestInit) => Promise<Response>;

/**
 * Resolves a `client_id` to a known client.
 *
 * - An HTTPS URL is a Client ID Metadata Document (CIMD, preferred by MCP
 *   2026-07-28). We fetch it, and the domain becomes the agent's verifiable
 *   identity.
 * - Anything else must have been registered through Dynamic Client
 *   Registration (deprecated, kept for 2025-era clients).
 */
export function createClientResolver(store: AuthStore, fetchMetadata: MetadataFetch) {
  const cache = new Map<string, { client: ClientRecord; expiresAt: number }>();

  async function fetchCimd(clientId: string): Promise<ClientRecord> {
    const url = parseCimdUrl(clientId);

    const cached = cache.get(clientId);
    if (cached && cached.expiresAt > Date.now()) return cached.client;

    let response: Response;
    try {
      response = await fetchMetadata(url, {
        headers: { accept: "application/json" },
        // Redirects could bounce the fetch into the internal network (SSRF).
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new OAuthError("invalid_client", "Could not fetch the client metadata document");
    }
    if (!response.ok) {
      throw new OAuthError("invalid_client", `Client metadata document returned ${response.status}`);
    }
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_METADATA_BYTES) {
      throw new OAuthError("invalid_client", "Client metadata document is too large");
    }
    const body = await response.arrayBuffer();
    if (body.byteLength > MAX_METADATA_BYTES) {
      throw new OAuthError("invalid_client", "Client metadata document is too large");
    }

    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(new TextDecoder().decode(body));
    } catch {
      throw new OAuthError("invalid_client", "Client metadata document is not valid JSON");
    }

    if (doc.client_id !== clientId) {
      throw new OAuthError("invalid_client", "client_id in the metadata document does not match its URL");
    }
    const authMethod = doc.token_endpoint_auth_method;
    if (authMethod !== undefined && authMethod !== "none") {
      throw new OAuthError("invalid_client", "Only public clients (token_endpoint_auth_method \"none\") are supported");
    }

    const client: ClientRecord = {
      clientId,
      clientName: parseClientName(doc.client_name),
      redirectUris: parseRedirectUris(doc.redirect_uris),
      clientUri: optionalHttpsUrl(doc.client_uri),
      logoUri: optionalHttpsUrl(doc.logo_uri),
      source: "cimd",
      createdAt: Date.now(),
    };

    if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
    cache.set(clientId, { client, expiresAt: Date.now() + CACHE_TTL_MS });
    return client;
  }

  return {
    async resolve(clientId: string): Promise<ClientRecord> {
      if (clientId.startsWith("https://")) return fetchCimd(clientId);
      const client = await store.getClient(clientId);
      if (!client) throw new OAuthError("invalid_client", "Unknown client_id");
      return client;
    },
  };
}

function parseCimdUrl(clientId: string): URL {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw new OAuthError("invalid_client", "client_id is not a valid URL");
  }
  if (url.protocol !== "https:" || url.pathname === "/" || url.hash || url.username || url.password) {
    throw new OAuthError("invalid_client", "client_id URL must be HTTPS with a path and no fragment or credentials");
  }
  if (isPrivateHost(url.hostname)) {
    throw new OAuthError("invalid_client", "client_id URL must not point at a private or local address");
  }
  return url;
}

/**
 * Best-effort SSRF guard on the hostname. It can't see DNS (portable runtimes
 * have no resolver API), so deployments that need DNS-level protection should
 * supply a hardened `fetchClientMetadata`.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (!host.includes(".") && !host.includes(":")) return true; // single-label intranet names

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  if (host.includes(":")) {
    return host === "::1" || host === "::" || host.startsWith("fc") || host.startsWith("fd") ||
      host.startsWith("fe80") || host.startsWith("::ffff:");
  }
  return false;
}

function parseClientName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new OAuthError("invalid_client_metadata", "client_name is required");
  }
  return value.trim().slice(0, 100);
}

export function parseRedirectUris(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new OAuthError("invalid_redirect_uri", "redirect_uris must be a non-empty array");
  }
  for (const uri of value) {
    if (typeof uri !== "string" || !isAllowedRedirectUri(uri)) {
      throw new OAuthError("invalid_redirect_uri", `redirect_uri not allowed: ${String(uri)}`);
    }
  }
  return value as string[];
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const FORBIDDEN_SCHEMES = new Set(["javascript:", "data:", "file:", "blob:", "vbscript:", "about:"]);

/** HTTPS anywhere, HTTP only on loopback, or a private-use app scheme (RFC 8252), e.g. `cursor://`. */
export function isAllowedRedirectUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return LOOPBACK.has(url.hostname);
  return !FORBIDDEN_SCHEMES.has(url.protocol) && /^[a-z][a-z0-9+.-]*:$/.test(url.protocol);
}

export function redirectRisk(uri: string): "none" | "loopback" | "app-scheme" {
  const url = new URL(uri);
  if (url.protocol === "https:") return LOOPBACK.has(url.hostname) ? "loopback" : "none";
  if (url.protocol === "http:") return "loopback";
  return "app-scheme";
}

function optionalHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return new URL(value).protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}
