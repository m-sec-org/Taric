import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = ["readme.md"];
const collect = (directory) => {
  if (!existsSync(join(root, directory))) return;
  if (!existsSync(join(root, directory))) return;
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (path !== "openspec/changes/archive") collect(path);
    } else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
  }
};
collect("docs");
collect("openspec/specs");
collect("openspec/changes");
const slug = (heading) => heading.toLowerCase().trim().replace(/[\p{P}\p{S}]/gu, (character) => character === "-" || character === "_" ? character : "").replace(/\s/g, "-");
const failures = [];
let checked = 0;
for (const file of [...new Set(files)].sort()) {
  const source = readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
  for (const match of source.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)) {
    const link = match[1];
    if (/^(?:https?:|mailto:|app:)/.test(link)) continue;
    const [path, anchor] = link.split("#");
    const target = path ? resolve(dirname(file), decodeURIComponent(path)) : resolve(file);
    checked++;
    if (!existsSync(target)) { failures.push(`${file}: missing target ${link}`); continue; }
    if (anchor && target.endsWith(".md")) {
      const content = readFileSync(target, "utf8").replace(/```[\s\S]*?```/g, "");
      const headings = [...content.matchAll(/^#{1,6}\s+(.+)$/gm)].map((heading) => slug(heading[1]));
      if (!headings.includes(decodeURIComponent(anchor))) failures.push(`${file}: missing anchor ${link}`);
    }
  }
}
process.stdout.write(`${JSON.stringify({ checked, failures }, null, 2)}\n`);
if (failures.length > 0) process.exitCode = 1;
