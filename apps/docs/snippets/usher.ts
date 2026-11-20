import { auditLog, createUsher, rateLimit, sqlStorage } from "usherjs";
import { db } from "./db.js";
import { getSession } from "./session.js";
import { cancelOrder, listOrders } from "./tools.js";

const storage = sqlStorage(db);
await storage.migrate(); // Idempotent: safe on every boot, from every instance.

export const usher = createUsher({
  app: { name: "Example Shop", version: "1.0.0" },
  baseUrl: "https://shop.example",
  secret: process.env.USHER_SECRET!, // openssl rand -base64 32
  tools: [listOrders, cancelOrder],

  // The bridge to the login you already have.
  identity: {
    async getUser(request) {
      const session = await getSession(request.headers);
      return session ? { id: session.user.id, name: session.user.name, email: session.user.email } : null;
    },
    loginUrl: (returnTo) => `/login?next=${encodeURIComponent(returnTo)}`,
  },

  store: storage.store,
  plugins: [auditLog({ sink: storage.auditSink }), rateLimit({ limit: 60, windowSeconds: 60, store: storage.rateLimitStore })],
  // Lets <usher-agents> show customers what their agents did.
  account: { activity: storage.auditSink },
  // The operator console at /api/usher/console, for your staff only.
  console: { isOperator: (user) => user.email?.endsWith("@shop.example") ?? false, events: storage.auditSink },
  theme: { accentColor: "#4f46e5", logoUrl: "/logo.svg", links: { accountSettings: "/settings/agents" } },
});

// Delete expired codes, tokens and approvals once an hour.
setInterval(() => void storage.prune({ auditRetentionDays: 90 }), 60 * 60 * 1000).unref();
