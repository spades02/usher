/**
 * Checks a deployed Usher from the outside, the way an agent will see it
 * (`npx usherjs doctor https://shop.example`). Most deployment bugs are
 * routing bugs: a missing `/.well-known` mount, or a proxy that changes
 * the origin. Both make agents fail at "connect" with unhelpful errors.
 */

export interface DeploymentCheck {
  name: string;
  ok: boolean;
  detail: string;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export async function checkDeployment(
  baseUrl: string,
  { basePath = "/api/usher", fetch: doFetch = (input, init) => fetch(input, init) }: { basePath?: string; fetch?: Fetch } = {},
): Promise<{ ok: boolean; checks: DeploymentCheck[] }> {
  const origin = new URL(baseUrl).origin;
  const issuer = origin + basePath.replace(/\/+$/, "");
  const resource = `${issuer}/mcp`;
  const checks: DeploymentCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(origin).hostname);
  add("HTTPS", origin.startsWith("https://") || local, origin.startsWith("https://") ? origin : `${origin} must use HTTPS: agents refuse plain HTTP outside localhost`);

  const getJson = async (url: string) => {
    try {
      const res = await doFetch(url, { headers: { accept: "application/json" }, redirect: "manual" });
      const body = res.headers.get("content-type")?.includes("json") ? ((await res.json()) as Record<string, unknown>) : null;
      return { status: res.status, body };
    } catch (error) {
      return { status: 0, body: null, error: error instanceof Error ? error.message : String(error) };
    }
  };
  const routeHint = (path: string) => `Route ${path} to Usher's handler (ADR 0008 lists the mount for each framework)`;

  const prmPath = `/.well-known/oauth-protected-resource${basePath}/mcp`;
  const prm = await getJson(origin + prmPath);
  if (prm.status !== 200 || !prm.body) add("Protected resource metadata", false, `GET ${prmPath} returned ${prm.status || "no response"}. ${routeHint("/.well-known/oauth-protected-resource/*")}`);
  else if (prm.body.resource !== resource) add("Protected resource metadata", false, `resource is ${String(prm.body.resource)}, expected ${resource}. Set \`baseUrl\` (or trustProxy) so Usher knows its public origin`);
  else add("Protected resource metadata", true, prmPath);

  const asPath = `/.well-known/oauth-authorization-server${basePath}`;
  const as = await getJson(origin + asPath);
  if (as.status !== 200 || !as.body) add("Authorization server metadata", false, `GET ${asPath} returned ${as.status || "no response"}. ${routeHint("/.well-known/oauth-authorization-server/*")}`);
  else if (as.body.issuer !== issuer) add("Authorization server metadata", false, `issuer is ${String(as.body.issuer)}, expected ${issuer}. Set \`baseUrl\``);
  else add("Authorization server metadata", true, asPath);

  try {
    const res = await doFetch(resource, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    const challenge = res.headers.get("www-authenticate") ?? "";
    add(
      "MCP endpoint challenge",
      res.status === 401 && challenge.includes("resource_metadata="),
      res.status === 401 ? `401 with ${challenge ? "WWW-Authenticate" : "no WWW-Authenticate header (is a proxy stripping it?)"}` : `POST ${basePath}/mcp returned ${res.status}, expected 401. ${routeHint(`${basePath}/*`)}`,
    );
  } catch (error) {
    add("MCP endpoint challenge", false, error instanceof Error ? error.message : String(error));
  }

  return { ok: checks.every((c) => c.ok), checks };
}
