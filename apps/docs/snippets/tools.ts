import { defineTool, ToolError } from "usherjs";
import { z } from "zod";
import { orders } from "./session.js";

export const listOrders = defineTool({
  name: "list_orders",
  title: "List orders",
  description: "List the customer's orders, newest first. Optionally filter by status.",
  input: z.object({ status: z.enum(["open", "shipped", "cancelled"]).optional() }),
  effect: "read",
  // `user` is the customer who connected the agent. Always scope queries to it.
  handler: async ({ status }, { user }) => ({ orders: await orders.list(user.id, status) }),
});

export const cancelOrder = defineTool({
  name: "cancel_order",
  title: "Cancel order",
  description: "Cancel one of the customer's open orders.",
  input: z.object({ orderId: z.string() }),
  output: z.object({ cancelled: z.string() }),
  // Destructive tools ask the customer to approve each call on your site.
  effect: "destructive",
  confirm: ({ orderId }) => `Cancel order ${orderId}`,
  handler: async ({ orderId }, { user }) => {
    const order = await orders.get(user.id, orderId);
    if (!order) throw new ToolError("No such order.", { code: "not_found" });
    if (order.status !== "open") throw new ToolError("Only open orders can be cancelled.", { code: "not_open" });
    await orders.cancel(user.id, orderId);
    return { cancelled: orderId };
  },
});
