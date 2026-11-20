import { usher } from "./usher.js";

// Bun.serve, Deno.serve, Cloudflare Workers: any Request → Response server.
// With Hono: app.all("*", (c, next) => (usher.matches(c.req.path) ? usher.handler(c.req.raw) : next()))
export default {
  async fetch(request: Request): Promise<Response> {
    if (usher.matches(new URL(request.url).pathname)) return usher.handler(request);
    return new Response("Your app");
  },
};
