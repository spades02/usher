#!/usr/bin/env node
/**
 * `npx usherjs sql [postgres|sqlite] [--prefix usher_]`
 *
 * Prints Usher's schema for teams that manage migrations with their own tool
 * (Drizzle Kit, Prisma Migrate, Flyway, Rails...). Everyone else can call
 * `sqlStorage(db).migrate()` at boot instead (ADR 0007).
 */
import { schemaSql } from "./storage/sql.js";

const USAGE = `Usage: usherjs sql <postgres|sqlite> [--prefix usher_]

Prints the SQL for Usher's tables. Paste it into a migration, or call
sqlStorage(db).migrate() at startup instead.`;

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

const proc = (globalThis as { process?: { argv: string[]; exitCode?: number; stdout: { write(s: string): void } } }).process;
const invoked = proc?.argv[1]?.split("\\").join("/");
if (proc && invoked && /\/(cli\.(js|ts)|usherjs)$/.test(invoked)) {
  const { code, out } = main(proc.argv.slice(2));
  proc.stdout.write(out + "\n");
  proc.exitCode = code;
}
