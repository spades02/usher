/**
 * `@usherjs/core/node`: mounts Usher in Node's `(req, res)` world: Express,
 * Connect, Fastify (via `reply.raw`), Koa (`ctx.req`/`ctx.res`), NestJS,
 * Polka, or a bare `http.createServer` (ADR 0008).
 *
 * Mount it once at the root, and it serves `{basePath}/*` plus the
 * `/.well-known` discovery documents, passing every other request on:
 *
 * ```ts
 * app.use(toNodeHandler(usher)); // before or after express.json(): both work
 * ```
 *
 * No Node imports, and no framework types: everything is structural.
 */
import type { Usher } from "./index.js";

export interface NodeRequest extends AsyncIterable<Uint8Array | string> {
  method?: string;
  url?: string;
  /** Express rewrites `url` under a mount path; `originalUrl` keeps the full path. */
  originalUrl?: string;
  headers: Record<string, string | string[] | undefined>;
  /** A TLS socket has `encrypted: true`. */
  socket?: object | null;
  /** Set when a body parser (express.json, express.urlencoded...) already read the stream. */
  body?: unknown;
  readableEnded?: boolean;
}

export interface NodeResponse {
  statusCode: number;
  setHeader(name: string, value: string | string[]): unknown;
  write(chunk: Uint8Array): boolean;
  end(): unknown;
  once(event: "drain" | "close", listener: () => void): unknown;
  on(event: "close", listener: () => void): unknown;
  off?(event: "drain" | "close", listener: () => void): unknown;
  readonly writableEnded?: boolean;
  readonly headersSent?: boolean;
  destroy?(error?: Error): unknown;
}

export interface NodeHandlerOptions {
  /**
   * Trust `X-Forwarded-Proto` and `X-Forwarded-Host` from a reverse proxy
   * when building the request URL. Only enable this behind a proxy that sets
   * them. Setting `baseUrl` on Usher is still the most robust option.
   */
  trustProxy?: boolean;
}

type Next = (error?: unknown) => void;

/** Converts Usher into Connect-style middleware: `(req, res, next?) => Promise<void>`. */
export function toNodeHandler(usher: Pick<Usher, "handler" | "matches">, options: NodeHandlerOptions = {}) {
  return async function usherNodeHandler(req: NodeRequest, res: NodeResponse, next?: Next): Promise<void> {
    try {
      const url = requestUrl(req, options.trustProxy ?? false);
      if (!usher.matches(url.pathname)) {
        if (next) return next();
        res.statusCode = 404;
        res.setHeader("content-type", "text/plain");
        res.end();
        return;
      }

      // Aborts the tool handler's signal if the agent disconnects mid-call.
      const controller = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) controller.abort();
      });

      const method = (req.method ?? "GET").toUpperCase();
      const headers = toHeaders(req.headers);
      const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req, headers);
      if (body !== undefined) headers.delete("content-length"); // A re-encoded body has a different length.

      const response = await usher.handler(
        new Request(url, { method, headers, body: body as BodyInit | undefined, signal: controller.signal }),
      );
      await writeResponse(response, res);
    } catch (error) {
      if (next) return next(error);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      } else res.destroy?.(error instanceof Error ? error : undefined);
    }
  };
}

function first(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v?.split(",")[0]?.trim() || undefined;
}

function requestUrl(req: NodeRequest, trustProxy: boolean): URL {
  const forwardedProto = trustProxy ? first(req.headers["x-forwarded-proto"]) : undefined;
  const proto =
    forwardedProto === "https" || forwardedProto === "http"
      ? forwardedProto
      : (req.socket as { encrypted?: boolean } | null | undefined)?.encrypted
        ? "https"
        : "http";
  const host = (trustProxy ? first(req.headers["x-forwarded-host"]) : undefined) ?? first(req.headers.host) ?? "localhost";
  return new URL(req.originalUrl ?? req.url ?? "/", `${proto}://${host}`);
}

function toHeaders(raw: NodeRequest["headers"]): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined || name.startsWith(":")) continue; // Skip HTTP/2 pseudo-headers.
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  return headers;
}

async function readBody(req: NodeRequest, headers: Headers): Promise<Uint8Array | string | undefined> {
  // Stream not consumed yet: read the exact bytes the agent sent.
  if (!req.readableEnded) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of req) chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
    return concat(chunks);
  }
  // A body parser got there first: re-encode what it parsed.
  const parsed = req.body;
  if (parsed === undefined || parsed === null) return undefined;
  if (typeof parsed === "string" || parsed instanceof Uint8Array) return parsed;
  const type = headers.get("content-type") ?? "";
  if (type.includes("application/x-www-form-urlencoded")) {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      for (const v of Array.isArray(value) ? value : [value]) form.append(key, String(v));
    }
    return form.toString();
  }
  return JSON.stringify(parsed);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

async function writeResponse(response: Response, res: NodeResponse): Promise<void> {
  res.statusCode = response.status;
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) res.setHeader("set-cookie", cookies);
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") res.setHeader(name, value);
  });
  if (!response.body) {
    res.end();
    return;
  }
  // Stream chunk by chunk (SSE responses must not be buffered), honoring backpressure.
  const reader = response.body.getReader();
  let closed = false;
  res.once("close", () => {
    closed = true;
    void reader.cancel().catch(() => {});
  });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || closed) break;
      if (!res.write(value)) {
        await new Promise<void>((resolve) => {
          res.once("drain", resolve);
          res.once("close", resolve);
        });
      }
    }
  } finally {
    if (!closed) res.end();
  }
}
