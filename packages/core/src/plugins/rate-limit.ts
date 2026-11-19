import type { UsherPlugin } from "./types.js";

export interface RateLimitRule {
  /** Calls allowed per window. */
  limit: number;
  windowSeconds: number;
}

/** Counter storage. Must be atomic per key when shared across instances (e.g. Redis INCR + EXPIRE). */
export interface RateLimitStore {
  /** Counts one hit in the current fixed window for `key`. `resetAt` is in milliseconds since the epoch. */
  hit(key: string, windowSeconds: number, now: number): Promise<{ count: number; resetAt: number }>;
}

/** Per-process fixed-window counters. With several instances, each keeps its own count. */
export function memoryRateLimitStore(): RateLimitStore {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return {
    async hit(key, windowSeconds, now) {
      let entry = windows.get(key);
      if (!entry || entry.resetAt <= now) {
        if (windows.size > 10_000) for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k);
        entry = { count: 0, resetAt: now + windowSeconds * 1000 };
        windows.set(key, entry);
      }
      entry.count++;
      return { ...entry };
    },
  };
}

export interface RateLimitOptions extends RateLimitRule {
  /** Stricter limits for specific tools, on top of the overall limit. */
  tools?: Record<string, RateLimitRule>;
  /** Default: in-memory, per process. */
  store?: RateLimitStore;
}

/**
 * Caps calls per connected agent: per customer + agent grant, so one
 * runaway agent can't drain another customer's quota, or even the same
 * customer's other agents.
 */
export function rateLimit(options: RateLimitOptions): UsherPlugin {
  assertRule(options, "rateLimit");
  for (const [tool, rule] of Object.entries(options.tools ?? {})) assertRule(rule, `rateLimit tools.${tool}`);
  const store = options.store ?? memoryRateLimitStore();

  return {
    id: "rate-limit",
    async beforeCall({ grantId, tool }) {
      const now = Date.now();
      const checks: [string, RateLimitRule][] = [[`grant:${grantId}`, options]];
      const toolRule = options.tools?.[tool.name];
      if (toolRule) checks.push([`grant:${grantId}:tool:${tool.name}`, toolRule]);

      for (const [key, rule] of checks) {
        const { count, resetAt } = await store.hit(key, rule.windowSeconds, now);
        if (count > rule.limit) {
          const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - now) / 1000));
          return {
            code: "rate_limited",
            message: `Too many calls${toolRule && key.includes(":tool:") ? ` to ${tool.name}` : ""}. Try again in ${retryAfterSeconds} seconds.`,
            retryAfterSeconds,
          };
        }
      }
    },
  };
}

function assertRule(rule: RateLimitRule, where: string) {
  for (const field of ["limit", "windowSeconds"] as const) {
    const value = rule?.[field];
    if (!Number.isInteger(value) || value <= 0) throw new Error(`[usher] ${where}: ${field} must be a positive integer`);
  }
}
