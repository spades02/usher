/**
 * Branding for the pages Usher renders on the app's domain (consent,
 * approval, done, error). See ADR 0009.
 *
 * Every value is validated at startup and ends up in CSS or an attribute,
 * so a theme can't inject markup, scripts or remote stylesheets.
 */

export interface UsherTheme {
  /** Buttons and links, as a hex color. Default: near-black (near-white in dark mode). */
  accentColor?: string;
  /** Text on accent buttons, as a hex color. Default: white (black in dark mode). */
  accentTextColor?: string;
  /** Shown above the heading. An `https://` URL, or a path on your own origin like `/logo.svg`. */
  logoUrl?: string;
  /** A CSS font stack of installed fonts, e.g. `"Inter", system-ui, sans-serif`. Web fonts are blocked by the pages' CSP. */
  fontFamily?: string;
  /** Corner radius in pixels, 0 to 24. Default: 8. */
  radius?: number;
  /** Default: `auto`, which follows the customer's OS setting. */
  colorScheme?: "light" | "dark" | "auto";
  /** Links in the page footer. Same rules as `logoUrl`. */
  links?: {
    /** Where customers manage connected agents, e.g. the page with `<usher-agents>`. */
    accountSettings?: string;
    privacy?: string;
    support?: string;
  };
}

export interface ResolvedTheme {
  css: string;
  logoUrl?: string;
  links: { label: string; href: string }[];
  accountSettings?: string;
  /** CSP `img-src` for the logo, if any. */
  imgSrc?: string;
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FONT = /^[\w\s,"'-]{1,200}$/;

function checkUrl(name: string, value: string): { href: string; src: string } {
  if (value.startsWith("/") && !value.startsWith("//")) return { href: value, src: "'self'" };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`[usher] theme.${name} must be an https:// URL or a path starting with /`);
  }
  if (url.protocol !== "https:") throw new Error(`[usher] theme.${name} must use https://`);
  return { href: url.href, src: url.origin };
}

export function resolveTheme(theme: UsherTheme = {}): ResolvedTheme {
  const light = { fg: "#111", bg: "#fff", muted: "#555", warn: "#9a3412", line: "#ddd", accent: "#111", accentFg: "#fff" };
  const dark = { fg: "#eee", bg: "#111", muted: "#aaa", warn: "#fdba74", line: "#333", accent: "#eee", accentFg: "#111" };

  for (const key of ["accentColor", "accentTextColor"] as const) {
    const value = theme[key];
    if (value !== undefined && !HEX.test(value)) throw new Error(`[usher] theme.${key} must be a hex color like #4f46e5`);
  }
  if (theme.fontFamily !== undefined && !FONT.test(theme.fontFamily)) {
    throw new Error("[usher] theme.fontFamily may only contain font names, quotes, commas and spaces");
  }
  const radius = theme.radius ?? 8;
  if (!Number.isFinite(radius) || radius < 0 || radius > 24) throw new Error("[usher] theme.radius must be between 0 and 24");
  const scheme = theme.colorScheme ?? "auto";
  if (!["light", "dark", "auto"].includes(scheme)) throw new Error("[usher] theme.colorScheme must be light, dark or auto");

  // A custom accent applies in both schemes; the customer chose one brand color.
  for (const palette of [light, dark]) {
    if (theme.accentColor) palette.accent = theme.accentColor;
    if (theme.accentTextColor) palette.accentFg = theme.accentTextColor;
  }
  const vars = (p: typeof light) =>
    `--fg:${p.fg}; --bg:${p.bg}; --muted:${p.muted}; --warn:${p.warn}; --line:${p.line}; --accent:${p.accent}; --accent-fg:${p.accentFg};`;
  const base = `--radius:${radius}px; --font:${theme.fontFamily ?? "system-ui, sans-serif"};`;
  const css =
    scheme === "auto"
      ? `:root { color-scheme: light dark; ${base} ${vars(light)} }\n  @media (prefers-color-scheme: dark) { :root { ${vars(dark)} } }`
      : `:root { color-scheme: ${scheme}; ${base} ${vars(scheme === "dark" ? dark : light)} }`;

  const logo = theme.logoUrl ? checkUrl("logoUrl", theme.logoUrl) : undefined;
  const links: ResolvedTheme["links"] = [];
  const labels = { accountSettings: "Connected agents", privacy: "Privacy", support: "Help" } as const;
  for (const key of ["accountSettings", "privacy", "support"] as const) {
    const value = theme.links?.[key];
    if (value !== undefined) links.push({ label: labels[key], href: checkUrl(`links.${key}`, value).href });
  }

  return {
    css,
    logoUrl: logo?.href,
    imgSrc: logo?.src,
    links,
    accountSettings: links.find((l) => l.label === labels.accountSettings)?.href,
  };
}
