#!/usr/bin/env node
/**
 * `npx usherjs sql [postgres|sqlite] [--prefix usher_]`
 * `npx usherjs serve [usher.config.json]`
 *
 * Prints Usher's schema for teams that manage migrations with their own tool
 * (Drizzle Kit, Prisma Migrate, Flyway, Rails...). Everyone else can call
 * `sqlStorage(db).migrate()` at boot instead (ADR 0007).
 */
import { schemaSql } from "./storage/sql.js";

const USAGE = `Usage:
  usherjs sql <postgres|sqlite> [--prefix usher_]
  usherjs serve [usher.config.json]
  usherjs doctor <https://your-app.example> [--base-path /api/usher]

Prints the SQL for Usher's tables. Paste it into a migration, or call
sqlStorage(db).migrate() at startup instead.

serve runs Usher as its own server for apps not written in JavaScript
(see docs/adr/0008-runtime-and-deployment.md).

doctor checks a deployment from the outside, the way an agent sees it.`;

export function main(args: readonly string[]): { code: number; out: string } {
  const [command, dialect, ...rest] = args;
  if (command !== "sql" || (dialect !== "postgres" && dialect !== "sqlite")) return { code: 1, out: USAGE };
  let tablePrefix: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--prefix" && rest[i + 1] !== undefined) tablePrefix = rest[++i];
    else return { code: 1, out: USAGE };
  }
  try {
    return { code: 0, out: schemaSql(dialect, { tablePrefix }) };
  } catch (error) {
    return { code: 1, out: error instanceof Error ? error.message : String(error) };
  }
}

/** `usherjs doctor <url> [--base-path /api/usher]` */
export async function doctor(args: readonly string[], fetchFn?: typeof fetch): Promise<{ code: number; out: string }> {
  const [url, flag, basePath] = args;
  if (!url || !/^https?:\/\//.test(url) || (flag !== undefined && (flag !== "--base-path" || !basePath))) return { code: 1, out: USAGE };
  const { checkDeployment } = await import("./doctor.js");
  const result = await checkDeployment(url, { basePath, fetch: fetchFn });
  const lines = result.checks.map((c) => `${c.ok ? "ok  " : "FAIL"}  ${c.name}: ${c.detail}`);
  lines.push(result.ok ? "\nReady for agents." : "\nAgents can't connect until the failures above are fixed.");
  return { code: result.ok ? 0 : 1, out: lines.join("\n") };
}

const proc = (globalThis as { process?: { argv: string[]; exitCode?: number; stdout: { write(s: string): void } } }).process;
const invoked = proc?.argv[1]?.split("\\").join("/");
if (proc && invoked && /\/(cli\.(js|ts)|usherjs)$/.test(invoked)) {
  if (proc.argv[2] === "doctor") {
    const { code, out } = await doctor(proc.argv.slice(3));
    proc.stdout.write(`${out}\n`);
    proc.exitCode = code;
  } else if (proc.argv[2] === "serve") {
    const { serveFromFile } = await import("./standalone.js");
    await serveFromFile(proc.argv[3] ?? "usher.config.json").catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      proc.exitCode = 1;
    });
  } else {
    const { code, out } = main(proc.argv.slice(2));
    proc.stdout.write(`${out}\n`);
    proc.exitCode = code;
  }
}
