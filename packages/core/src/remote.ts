/**
 * Building blocks for running Usher outside the app's process (ADR 0008):
 * identity over HTTP, and tools as signed webhooks. The standalone server
 * (`usherjs serve`) is built from these, and JS apps can mix them in too,
 * e.g. to expose one tool that lives in another service.
 */
import type { IdentityAdapter, UsherUser } from "./auth/types.js";
import { timingSafeEqual } from "./auth/crypto.js";
import { ToolError } from "./errors.js";
import type { InferOutput, UsherSchema } from "./schema.js";
import type { AnyUsherTool, ToolEffect } from "./tool.js";

type Fetch = (input: string | URL, init: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------- identity

export interface HttpIdentityOptions {
  /**
   * The app's endpoint that reports the signed-in user. Usher forwards the
   * browser's `Cookie` (and `Authorization`) header to it. Return `200` with
   * `{ "id": "...", "name"?: "...", "email"?: "..." }`, or `401` when signed out.
   * It must be your own app: it receives your customers' session cookies.
   */
  sessionUrl: string;
  /** Login page with a `{returnTo}` placeholder, e.g. `https://shop.example/login?next={returnTo}`. */
  loginUrl: string;
  /** Request headers to forward. Default: `["cookie", "authorization"]`. */
  forwardHeaders?: readonly string[];
  /** Default: 5000. */
  timeoutMs?: number;
  fetch?: Fetch;
}

/** An {@link IdentityAdapter} that asks the app over HTTP who is signed in. Works with any backend language. */
export function httpIdentity(options: HttpIdentityOptions): IdentityAdapter {
  const sessionUrl = new URL(options.sessionUrl); // Throws early on a relative or malformed URL.
  if (!options.loginUrl.includes("{returnTo}")) {
    throw new Error("[usher] httpIdentity `loginUrl` must contain a {returnTo} placeholder");
  }
  const forward = options.forwardHeaders ?? ["cookie", "authorization"];
  const doFetch: Fetch = options.fetch ?? ((input, init) => fetch(input, init));

  return {
    async getUser(request): Promise<UsherUser | null> {
      if (!forward.some((name) => request.headers.has(name))) return null; // Nothing that could identify anyone.
      const headers = new Headers({ accept: "application/json" });
      for (const name of forward) {
        const value = request.headers.get(name);
        if (value !== null) headers.set(name, value);
      }

      const res = await doFetch(sessionUrl, {
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
      });
      if ([204, 401, 403, 404].includes(res.status)) return null;
      if (res.status !== 200) throw new Error(`[usher] Session endpoint returned HTTP ${res.status}`);
      const body = (await res.json()) as Partial<UsherUser> | null;
      if (typeof body?.id !== "string" || body.id === "") throw new Error("[usher] Session endpoint returned no `id`");
      return {
        id: body.id,
        ...(typeof body.name === "string" ? { name: body.name } : {}),
        ...(typeof body.email === "string" ? { email: body.email } : {}),
      };
    },
    loginUrl: (returnTo) => options.loginUrl.split("{returnTo}").join(encodeURIComponent(returnTo)),
  };
}

// ---------------------------------------------------------------- webhooks

const SIGNATURE_HEADER = "usher-signature";
const encoder = new TextEncoder();

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `Usher-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`, the Stripe scheme. */
async function signatureHeader(secret: string, body: string, now: number): Promise<string> {
  const t = Math.floor(now / 1000);
  return `t=${t},v1=${await hmacHex(secret, `${t}.${body}`)}`;
}

/**
 * Checks a webhook from Usher: the HMAC matches and the timestamp is fresh.
 * Any language can do the same in a few lines; see ADR 0008.
 */
export async function verifyWebhook(
  secret: string,
  body: string,
  header: string | null,
  { toleranceSeconds = 300, now = Date.now() }: { toleranceSeconds?: number; now?: number } = {},
): Promise<boolean> {
  const parts = Object.fromEntries((header ?? "").split(",").map((p) => p.split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || typeof parts.v1 !== "string") return false;
  if (Math.abs(now / 1000 - t) > toleranceSeconds) return false;
  return timingSafeEqual(await hmacHex(secret, `${t}.${body}`), parts.v1);
}

export interface WebhookToolOptions<Input extends UsherSchema = UsherSchema> {
  name: string;
  title?: string;
  description: string;
  input: Input;
  output?: UsherSchema;
  effect: ToolEffect;
  idempotent?: boolean;
  confirm?: boolean | ((input: InferOutput<Input>) => string);
  /** Where Usher POSTs each call. HTTPS outside development. */
  url: string;
  /** Shared secret for the `Usher-Signature` header. At least 32 characters. */
  secret: string;
  /** Default: 10000. */
  timeoutMs?: number;
  fetch?: Fetch;
}

/**
 * A tool whose handler lives behind an HTTP endpoint in any language.
 *
 * Usher authenticates the agent, checks scopes, runs plugins and collects
 * approvals as for any tool, then POSTs
 * `{ tool, input, user: { id }, agent }` signed with `Usher-Signature`.
 *
 * - `2xx` with JSON: the result.
 * - `4xx` with `{ "error": "...", "code"?: "..." }`: a business failure the agent sees.
 * - Anything else, or a timeout: a generic failure (details go to `onError`).
 */
export function webhookTool<Input extends UsherSchema>(options: WebhookToolOptions<Input>): AnyUsherTool {
  const url = new URL(options.url);
  if (typeof options.secret !== "string" || options.secret.length < 32) {
    throw new Error(`[usher] webhookTool "${options.name}": \`secret\` must be at least 32 characters`);
  }
  const doFetch: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? 10_000;

  return {
    name: options.name,
    title: options.title,
    description: options.description,
    input: options.input,
    output: options.output,
    effect: options.effect,
    idempotent: options.idempotent,
    confirm: options.confirm,
    async handler(input, ctx) {
      const body = JSON.stringify({ tool: options.name, input, user: ctx.user, agent: ctx.agent });
      const res = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          [SIGNATURE_HEADER]: await signatureHeader(options.secret, body, Date.now()),
        },
        body,
        redirect: "manual",
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]),
      });
      const text = await res.text();
      const json = parseJson(text);
      if (res.status >= 200 && res.status < 300) return json ?? (text === "" ? {} : { text });
      if (res.status >= 400 && res.status < 500) {
        const { error, code } = (json ?? {}) as { error?: unknown; code?: unknown };
        throw new ToolError(typeof error === "string" ? error : "The app rejected this request.", {
          code: typeof code === "string" ? code : undefined,
        });
      }
      throw new Error(`[usher] Webhook for "${options.name}" returned HTTP ${res.status}`);
    },
  };
}

function parseJson(text: string): unknown {
  try {
    return text === "" ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}
