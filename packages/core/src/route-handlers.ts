import type { Usher } from "./index.js";

/** What file-routed frameworks pass to a route export: the Request itself, or an event that carries it. */
type RouteInput = Request | { request: Request };

type RouteHandler = (input: RouteInput, ...rest: unknown[]) => Promise<Response>;

export interface RouteHandlers {
  GET: RouteHandler;
  POST: RouteHandler;
  OPTIONS: RouteHandler;
  DELETE: RouteHandler;
}

/**
 * Per-method exports for file-routed frameworks. They receive either a
 * `Request` (Next.js, Bun) or an event with `.request` (SvelteKit, Astro,
 * Remix / React Router, SolidStart, TanStack Start), so one helper fits all:
 *
 * ```ts
 * // app/api/usher/[...usher]/route.ts (Next.js)
 * export const { GET, POST, OPTIONS, DELETE } = toRouteHandlers(usher);
 * ```
 */
export function toRouteHandlers(usher: Pick<Usher, "handler">): RouteHandlers {
  const handle: RouteHandler = (input) => usher.handler(isRequest(input) ? input : input.request);
  return { GET: handle, POST: handle, OPTIONS: handle, DELETE: handle };
}

function isRequest(input: RouteInput): input is Request {
  // Duck-typed: frameworks may use their own Request subclass or another realm's.
  return typeof (input as Request).url === "string" && typeof (input as Request).headers?.get === "function";
}
