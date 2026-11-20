import { definePlugin } from "usherjs";

// Plugins can only restrict (ADR 0006). This one keeps irreversible actions to office hours.
export const officeHours = definePlugin({
  id: "office-hours",
  beforeCall(call) {
    const hour = new Date().getUTCHours();
    if (call.tool.effect === "destructive" && (hour < 8 || hour >= 18)) {
      return { code: "outside_hours", message: "Irreversible actions are available 08:00-18:00 UTC." };
    }
  },
  onEvent(event) {
    if (event.type === "grant.revoked" && event.reason === "token_replay") {
      console.warn(`Stolen token detected for customer ${event.userId}; ${event.agent.name} was disconnected.`);
    }
  },
});
