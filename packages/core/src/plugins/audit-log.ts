import type { UsherEvent, UsherPlugin } from "./types.js";

/** Where audit events go: your database, a log pipeline, a SIEM. */
export interface AuditSink {
  write(event: UsherEvent): void | Promise<void>;
}

export interface AuditQuery {
  userId?: string;
  grantId?: string;
  type?: UsherEvent["type"];
  /** Default: 100. */
  limit?: number;
}

export interface MemoryAuditSink extends AuditSink {
  /** Newest first. Use it to show a customer what their agents did. */
  list(query?: AuditQuery): UsherEvent[];
}

/**
 * In-memory audit sink for development and tests. It keeps the newest `max`
 * events and loses everything on restart. Phase 6 adds durable sinks.
 */
export function memoryAuditSink({ max = 10_000 }: { max?: number } = {}): MemoryAuditSink {
  const events: UsherEvent[] = [];
  return {
    write(event) {
      events.push(event);
      if (events.length > max) events.splice(0, events.length - max);
    },
    list({ userId, grantId, type, limit = 100 } = {}) {
      const out: UsherEvent[] = [];
      for (let i = events.length - 1; i >= 0 && out.length < limit; i--) {
        const e = events[i]!;
        if ((userId && e.userId !== userId) || (grantId && e.grantId !== grantId) || (type && e.type !== type)) continue;
        out.push(e);
      }
      return out;
    },
  };
}

export interface AuditLogOptions {
  sink: AuditSink;
  /** Only record these event types. Default: all of them. */
  events?: readonly UsherEvent["type"][];
}

/**
 * Records every tool call, connection, permission change, disconnect and
 * approval. Arguments and results are never recorded, only a hash of the
 * input, so the log doesn't become a second copy of customer data.
 */
export function auditLog(options: AuditLogOptions): UsherPlugin {
  if (typeof options?.sink?.write !== "function") throw new Error("[usher] auditLog: `sink` must have a write(event) method");
  const only = options.events ? new Set(options.events) : null;
  return {
    id: "audit-log",
    async onEvent(event) {
      if (!only || only.has(event.type)) await options.sink.write(event);
    },
  };
}
