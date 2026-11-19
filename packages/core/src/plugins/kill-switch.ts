import type { CallInfo, UsherPlugin } from "./types.js";

export interface KillSwitchOptions {
  /**
   * Return `true` (or a message for the agent) to block the call. Read it
   * from wherever you can flip it fast: a feature flag, an env var, a DB row.
   */
  isBlocked(call: CallInfo): boolean | string | Promise<boolean | string>;
}

/**
 * The operator's emergency brake: stop all agent calls, one tool, or one
 * agent, without a deploy. To cut off a single customer's agent, use
 * `usher.grants.revoke` instead.
 */
export function killSwitch(options: KillSwitchOptions): UsherPlugin {
  if (typeof options?.isBlocked !== "function") throw new Error("[usher] killSwitch: `isBlocked` must be a function");
  return {
    id: "kill-switch",
    async beforeCall(call) {
      const blocked = await options.isBlocked(call);
      if (!blocked) return;
      return {
        code: "disabled",
        message: typeof blocked === "string" ? blocked : "This action is temporarily disabled by the app.",
      };
    },
  };
}
