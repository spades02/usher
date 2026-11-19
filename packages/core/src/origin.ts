/**
 * Origin validation, required by the MCP Streamable HTTP transport to block
 * DNS-rebinding and cross-site requests from browsers.
 *
 * Remote agents (ChatGPT, Claude, ...) call from their servers and normally
 * send no `Origin` header, so absent Origin is allowed. A present Origin must
 * be the app's own origin or explicitly allowlisted.
 */
export function isOriginAllowed(
  request: Request,
  allowedOrigins: readonly string[],
  /** The app's public origin (from `baseUrl`). Behind a proxy the request URL's origin is the internal one. */
  ownOrigin = new URL(request.url).origin,
): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  if (origin === ownOrigin) return true;
  return allowedOrigins.includes(origin);
}
