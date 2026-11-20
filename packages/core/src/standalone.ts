/**
 * `usherjs/standalone`: Usher as its own process, for apps not written in
 * JavaScript (Rails, Django, Laravel, Go, .NET...). See ADR 0008.
 *
 * The app keeps its logic and its login. It exposes:
 * - a session endpoint that says who is signed in (forwarded cookies), and
 * - one webhook per tool, verified with `Usher-Signature`.
 *
 * The reverse proxy routes `{basePath}/*` and `/.well-known/oauth-*` on the
 * app's own domain to this server, so it sees the app's session cookie.
 */

import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve as resolvePath } from "node:path";
import { z } from "zod";
import { timingSafeEqual } from "./auth/crypto.js";
import { createUsher, type Usher } from "./index.js";
import { toNodeHandler } from "./node.js";
import { auditLog } from "./plugins/audit-log.js";
import { rateLimit } from "./plugins/rate-limit.js";
import type { UsherPlugin } from "./plugins/types.js";
import { httpIdentity, webhookTool } from "./remote.js";
import type { UsherSchema } from "./schema.js";
import { postgresExecutor, type SqlExecutor, sqliteExecutor, sqlStorage } from "./storage/sql.js";
import type { AnyUsherTool } from "./tool.js";
import type { UsherTheme } from "./ui/theme.js";

// ------------------------------------------------------------------ config

const toolConfig = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string(),
  effect: z.enum(["read", "write", "destructive"]),
  idempotent: z.boolean().optional(),
  /** `true`/`false`, or an approval-page summary like `"Cancel order {orderId}"`. */
  confirm: z.union([z.boolean(), z.string()]).optional(),
  /** JSON Schema for the arguments (an object schema). */
  input: z.record(z.string(), z.unknown()),
  output: z.record(z.string(), z.unknown()).optional(),
  url: z.url(),
  timeoutMs: z.number().int().positive().optional(),
});

export const standaloneConfigSchema = z.object({
  app: z.object({ name: z.string(), version: z.string() }),
  /** Public origin of the app, e.g. `https://shop.example`. Required: this server sits behind a proxy. */
  baseUrl: z.url(),
  basePath: z.string().optional(),
  secret: z.string().min(32),
  instructions: z.string().optional(),
  identity: z.object({ sessionUrl: z.url(), loginUrl: z.string(), timeoutMs: z.number().int().positive().optional() }),
  /** `sqlite:./usher.db`, `sqlite::memory:`, or a `postgres://` URL (needs the `pg` package). */
  database: z.string(),
  tablePrefix: z.string().optional(),
  /** Signs every webhook. At least 32 characters. */
  webhookSecret: z.string().min(32),
  /** Bearer token for the admin API the app calls to build a "Connected agents" page. At least 32 characters. */
  adminToken: z.string().min(32).optional(),
  tools: z.array(toolConfig).min(1),
  rateLimit: z.object({ limit: z.number().int().positive(), windowSeconds: z.number().int().positive() }).optional(),
  allowedOrigins: z.array(z.string()).optional(),
  /** Branding for consent and approval pages (ADR 0009). Validated when the server starts. */
  theme: z.record(z.string(), z.unknown()).optional(),
  /** User ids (as your session endpoint reports them) who may open the operator console at {basePath}/console (ADR 0011). */
  operators: z.array(z.string()).optional(),
  port: z.number().int().min(0).max(65535).optional(),
});

export type StandaloneConfig = z.input<typeof standaloneConfigSchema>;

/** Replaces `"env:NAME"` strings with the environment variable, so secrets stay out of the file. */
export function resolveEnv<T>(value: T, env: Record<string, string | undefined>): T {
  if (typeof value === "string" && value.startsWith("env:")) {
    const name = value.slice(4);
    const resolved = env[name];
    if (resolved === undefined) throw new Error(`[usher] Environment variable ${name} is not set`);
    return resolved as T;
  }
  if (Array.isArray(value)) return value.map((v) => resolveEnv(v, env)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveEnv(v, env)])) as T;
  }
  return value;
}

/** Wraps a plain JSON Schema as an {@link UsherSchema}: agents see it verbatim, and inputs are validated against it. */
export function jsonSchema(schema: Record<string, unknown>): UsherSchema {
  const validator = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
  return {
    "~standard": {
      version: 1,
      vendor: "usher-json-schema",
      validate: (value) => validator["~standard"].validate(value) as never,
      jsonSchema: { input: () => schema, output: () => schema },
    },
  };
}

function template(summary: string) {
  return (input: unknown) =>
    summary.replace(/\{(\w+)\}/g, (_m, key: string) => {
      const value = (input as Record<string, unknown> | null)?.[key];
      return value === undefined ? `{${key}}` : String(value);
    });
}

async function openDatabase(url: string): Promise<SqlExecutor> {
  if (url.startsWith("sqlite:")) {
    const { DatabaseSync } = (await import("node:sqlite" as string)) as {
      DatabaseSync: new (path: string) => { prepare(sql: string): { all(...p: unknown[]): unknown[] } };
    };
    const path = url.slice("sqlite:".length);
    return sqliteExecutor(new DatabaseSync(path === ":memory:" ? path : resolvePath(path)));
  }
  if (/^postgres(ql)?:\/\//.test(url)) {
    let pg: { default?: { Pool: new (o: object) => never }; Pool?: new (o: object) => never };
    try {
      pg = (await import("pg" as string)) as typeof pg;
    } catch {
      throw new Error("[usher] A postgres:// database needs the `pg` package: npm install pg");
    }
    const Pool = pg.Pool ?? pg.default!.Pool;
    return postgresExecutor(new Pool({ connectionString: url }));
  }
  throw new Error("[usher] `database` must start with sqlite: or postgres://");
}

// ------------------------------------------------------------------ server

export interface StandaloneServer {
  usher: Usher;
  server: Server;
  /** Starts listening. Resolves with the bound port. */
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

/** Builds the standalone server from a config object (already env-resolved). */
export async function createStandaloneServer(input: StandaloneConfig): Promise<StandaloneServer> {
  const config = standaloneConfigSchema.parse(input);
  const storage = sqlStorage(await openDatabase(config.database), { tablePrefix: config.tablePrefix });
  await storage.migrate();

  const tools: AnyUsherTool[] = config.tools.map((t) =>
    webhookTool({
      name: t.name,
      title: t.title,
      description: t.description,
      effect: t.effect,
      idempotent: t.idempotent,
      confirm: typeof t.confirm === "string" ? template(t.confirm) : t.confirm,
      input: jsonSchema(t.input),
      output: t.output ? jsonSchema(t.output) : undefined,
      url: t.url,
      secret: config.webhookSecret,
      timeoutMs: t.timeoutMs,
    }),
  );
  const plugins: UsherPlugin[] = [auditLog({ sink: storage.auditSink })];
  if (config.rateLimit) plugins.push(rateLimit({ ...config.rateLimit, store: storage.rateLimitStore }));

  const usher = createUsher({
    app: config.app,
    baseUrl: config.baseUrl,
    basePath: config.basePath,
    secret: config.secret,
    instructions: config.instructions,
    allowedOrigins: config.allowedOrigins,
    theme: config.theme as UsherTheme | undefined,
    // <usher-agents> on the app's pages shows the audit trail to each customer.
    account: { activity: storage.auditSink },
    console: config.operators?.length
      ? { isOperator: (user) => config.operators!.includes(user.id), events: storage.auditSink }
      : undefined,
    identity: httpIdentity(config.identity),
    store: storage.store,
    tools,
    plugins,
  });

  const node = toNodeHandler(usher);
  const admin = config.adminToken ? adminApi(usher, config.adminToken, storage.auditSink.list) : null;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0]!;
    if (path === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    if (admin && path.startsWith(`${usher.basePath}/admin/`)) return admin(req, res, path.slice(`${usher.basePath}/admin`.length));
    await node(req, res);
  });

  // Expired codes, tokens and approvals are deleted hourly (ADR 0007).
  const pruner = setInterval(() => void storage.prune().catch((e) => console.error("[usher] prune failed:", e)), 3_600_000);
  pruner.unref();

  return {
    usher,
    server,
    listen: (port = config.port ?? 8787, host) =>
      new Promise((ok, fail) => {
        server.once("error", fail);
        server.listen(port, host, () => ok((server.address() as { port: number }).port));
      }),
    close: () =>
      new Promise((ok) => {
        clearInterval(pruner);
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}

/**
 * A small JSON API for the app's backend (never the browser), so apps in any
 * language can list, revoke and edit a customer's connected agents:
 *
 * - `GET    /admin/users/:userId/grants`
 * - `DELETE /admin/users/:userId/grants/:grantId`
 * - `PUT    /admin/users/:userId/grants/:grantId/scopes`  body `{ "scopes": [...] }`
 * - `GET    /admin/users/:userId/events?limit=50`
 */
function adminApi(usher: Usher, token: string, listEvents: ReturnType<typeof sqlStorage>["auditSink"]["list"]) {
  const expected = `Bearer ${token}`;
  const send = (res: ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };

  return async (req: IncomingMessage, res: ServerResponse, path: string) => {
    const auth = req.headers.authorization ?? "";
    if (!timingSafeEqual(auth, expected)) return send(res, 401, { error: "unauthorized" });
    const m = path.match(/^\/users\/([^/]+)\/(grants|events)(?:\/([^/]+)(\/scopes)?)?$/);
    if (!m) return send(res, 404, { error: "not_found" });
    const userId = decodeURIComponent(m[1]!);
    const grantId = m[3] ? decodeURIComponent(m[3]) : undefined;
    try {
      if (m[2] === "events" && !grantId && req.method === "GET") {
        const limit = Number(new URL(req.url ?? "/", "http://x").searchParams.get("limit") ?? 50);
        return send(res, 200, { events: await listEvents({ userId, limit: Math.min(Math.max(limit, 1), 500) }) });
      }
      if (m[2] !== "grants") return send(res, 404, { error: "not_found" });
      if (!grantId && req.method === "GET") return send(res, 200, { grants: await usher.grants.list(userId) });
      if (grantId && !m[4] && req.method === "DELETE") {
        await usher.grants.revoke(userId, grantId);
        return send(res, 204);
      }
      if (grantId && m[4] && req.method === "PUT") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const scopes = (JSON.parse(body || "{}") as { scopes?: unknown }).scopes;
        if (!Array.isArray(scopes) || !scopes.every((s) => typeof s === "string"))
          return send(res, 400, { error: "scopes must be a string array" });
        await usher.grants.setScopes(userId, grantId, scopes);
        return send(res, 204);
      }
      return send(res, 405, { error: "method_not_allowed" });
    } catch (error) {
      return send(res, 400, { error: error instanceof Error ? error.message : "bad_request" });
    }
  };
}

/** `usherjs serve [usher.config.json]`: reads the config, resolves `env:` values, listens. */
export async function serveFromFile(path: string, env: Record<string, string | undefined> = process.env): Promise<StandaloneServer> {
  const raw = JSON.parse(await readFile(path, "utf8")) as StandaloneConfig;
  const standalone = await createStandaloneServer(resolveEnv(raw, env));
  const port = await standalone.listen(env.PORT ? Number(env.PORT) : undefined);
  console.log(`[usher] Serving ${standalone.usher.basePath}/mcp on port ${port}`);
  return standalone;
}
