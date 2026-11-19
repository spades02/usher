// Checks the built package the way users get it (ADR 0010). Run after `build`.
// 1. Every export and the bin resolve to real files.
// 2. The main entry never imports node:* (it must run on edge runtimes).
// 3. The minified elements script registers both elements in a real DOM and
//    renders the Connect widget, within its size budget.
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Window } from "happy-dom";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const failures = [];
const fail = (message) => failures.push(message);
const exists = (path) =>
  stat(join(root, path)).then(
    () => true,
    () => false,
  );

// 1. Exports and bin.
for (const [subpath, target] of Object.entries(pkg.exports)) {
  for (const [condition, file] of Object.entries(target)) {
    if (!(await exists(file))) fail(`exports["${subpath}"].${condition} → ${file} is missing`);
  }
}
for (const [name, file] of Object.entries(pkg.bin ?? {})) {
  if (!(await exists(file))) fail(`bin.${name} → ${file} is missing`);
  else if (!(await readFile(join(root, file), "utf8")).startsWith("#!/usr/bin/env node")) fail(`bin.${name} has no shebang`);
}

// 2. Edge-safe main entry: walk its static and dynamic relative imports.
const seen = new Set();
async function walk(file, chain) {
  if (seen.has(file)) return;
  seen.add(file);
  const source = await readFile(file, "utf8");
  for (const [, spec] of source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
    if (spec.startsWith("node:")) fail(`main entry imports ${spec} via ${[...chain, file].map((f) => f.slice(root.length)).join(" → ")}`);
    else if (spec.startsWith(".")) await walk(resolve(dirname(file), spec), [...chain, file]);
  }
}
await walk(join(root, pkg.exports["."].import), []);

// 3. The served script, minified, in a DOM.
const { ELEMENTS_SCRIPT } = await import(pathToFileURL(join(root, "dist/ui/elements-script.js")).href);
const BUDGET = 14_000;
if (ELEMENTS_SCRIPT.length > BUDGET) fail(`elements.js is ${ELEMENTS_SCRIPT.length} bytes, over the ${BUDGET} byte budget`);
const { installUsherElements } = await import(pathToFileURL(join(root, "dist/ui/elements.js")).href);
const ratio = ELEMENTS_SCRIPT.length / installUsherElements.toString().length;
if (ratio > 0.75) fail(`elements.js doesn't look minified (${Math.round(ratio * 100)}% of the source)`);
const win = new Window({ url: "https://shop.example/settings" });
win.fetch = async () => Response.json({ app: { name: "Shop" }, mcpUrl: "https://shop.example/api/usher/mcp", tools: [] });
new Function("window", ELEMENTS_SCRIPT)(win);
for (const name of ["usher-connect", "usher-agents"]) if (!win.customElements.get(name)) fail(`<${name}> isn't registered`);
win.document.body.innerHTML = "<usher-connect></usher-connect>";
await new Promise((r) => setTimeout(r, 50));
const url = win.document.body.firstElementChild.shadowRoot?.querySelector("input")?.value;
if (url !== "https://shop.example/api/usher/mcp") fail(`<usher-connect> rendered ${url ?? "nothing"}`);
await win.happyDOM.close();

if (failures.length) {
  console.error(`Package check failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`Package check passed (${seen.size} modules in the main entry, elements.js ${ELEMENTS_SCRIPT.length} bytes).`);
