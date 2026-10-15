import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const files = ["docs/agent-integration.md", "docs/authority-storage-runbook.md", "docs/context-recovery.md", "docs/multi-host-authority-runbook.md", "docs/postgres-runtime-readiness.md", "docs/taric-api.md", "docs/taric-code-design.md", "docs/taric-design.md", "docs/taric-implementation-analysis-review.md", "openspec/changes/harden-taric-authority-runtime/release-report.md"];
const slug = (heading) => heading.toLowerCase().trim().replace(/[\p{P}\p{S}]/gu, (character) => character === "-" || character === "_" ? character : "").replace(/\s/g, "-");
const failures = [];
let checked = 0;
for (const file of files) {
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
