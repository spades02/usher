// Fails the docs build on any broken internal link or #anchor (ADR 0011).
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const pages = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.name.endsWith(".html")) pages.push(path);
  }
}
await walk(dist);

const ids = new Map();
const idsOf = async (file) => {
  if (!ids.has(file)) ids.set(file, new Set([...(await readFile(file, "utf8")).matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
  return ids.get(file);
};
const target = async (path) => {
  const clean = decodeURIComponent(path).replace(/^\//, "");
  for (const candidate of [join(dist, clean), join(dist, clean, "index.html"), join(dist, `${clean}.html`)]) {
    const s = await stat(candidate).catch(() => null);
    if (s?.isFile()) return candidate;
  }
  return null;
};

const broken = [];
for (const page of pages) {
  const html = await readFile(page, "utf8");
  const pagePath = `/${relative(dist, page)
    .split("\\")
    .join("/")
    .replace(/index\.html$/, "")}`;
  for (const [, href] of html.matchAll(/<a\s[^>]*href="([^"]+)"/g)) {
    if (/^(https?:|mailto:|cursor:|vscode:|data:)/.test(href)) continue;
    const [path, hash] = href.split("#");
    const resolved = path === "" ? pagePath : new URL(path, `https://x${pagePath}`).pathname;
    const file = await target(resolved);
    if (!file) broken.push(`${pagePath} → ${href}`);
    else if (hash && !(await idsOf(file)).has(decodeURIComponent(hash))) broken.push(`${pagePath} → ${href} (no #${hash})`);
  }
}
if (broken.length) {
  console.error(`Broken links:\n- ${[...new Set(broken)].join("\n- ")}`);
  process.exit(1);
}
console.log(`Links OK across ${pages.length} pages.`);
