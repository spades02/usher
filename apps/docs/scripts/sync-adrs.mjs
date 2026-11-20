// Copies docs/adr/*.md into the site (ADR 0011). The ADRs stay the single
// source; the copies are generated and git-ignored.
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../../../docs/adr/", import.meta.url));
const target = fileURLToPath(new URL("../src/content/docs/decisions/", import.meta.url));
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });

const files = (await readdir(source)).filter((f) => /^\d{4}-.*\.md$/.test(f)).sort();
for (const [i, file] of files.entries()) {
  const text = await readFile(source + file, "utf8");
  const heading = text.match(/^# (.+)$/m)?.[1] ?? file;
  const [, number, title] = heading.match(/^ADR (\d+)\s*[—:-]\s*(.+)$/) ?? [null, file.slice(0, 4), heading];
  const short = title.split(/[.:]/)[0].trim();
  const body = text.replace(/^# .+$/m, "").trimStart();
  const frontmatter = [
    "---",
    `title: ${JSON.stringify(`ADR ${number}: ${short}`)}`,
    `description: ${JSON.stringify(title)}`,
    "sidebar:",
    `  order: ${i}`,
    "editUrl: false",
    "---",
    "",
    "<!-- Generated from docs/adr by scripts/sync-adrs.mjs. Edit the ADR, not this file. -->",
    "",
  ].join("\n");
  // Links between ADRs point at sibling pages on the site.
  await writeFile(target + file, frontmatter + body.replace(/\]\((\d{4}-[a-z0-9-]+)\.md\)/g, "](../$1/)"));
}
console.log(`Synced ${files.length} ADRs.`);
