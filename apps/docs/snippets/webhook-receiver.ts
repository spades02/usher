import { verifyWebhook } from "@usherjs/core";
import express from "express";
import { orders } from "./session.js";

const cancelOrder = orders.cancel;

// A tool webhook for the standalone server, written in Node. Other languages: see the guide.
const app = express();
app.post("/usher/hooks/cancel_order", express.text({ type: "application/json" }), async (req, res) => {
  const ok = await verifyWebhook(process.env.USHER_WEBHOOK_SECRET!, req.body, req.get("usher-signature") ?? null);
  if (!ok) {
    res.status(401).end();
    return;
  }
  const { input, user } = JSON.parse(req.body) as { input: { orderId: string }; user: { id: string } };
  await cancelOrder(user.id, input.orderId); // Your code, scoped to the customer.
  res.json({ cancelled: input.orderId });
});
app.listen(3000);
