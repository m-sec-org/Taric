#!/usr/bin/env node
/**
 * 在 Bun 运行时下执行 @taric/driver-bun-sqlite 的 12 场景权威一致性测试，
 * 并把 conformance 报告归档为可提交的验收证据（scripts/benchmark-* 惯例）。
 * 用法：node scripts/benchmark-bun-driver.mjs [--output=<path>]
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = process.argv.find((value) => value.startsWith("--output="))?.slice("--output=".length)
  ?? resolve(root, "docs", "benchmarks", "bun-driver-conformance-v1.json");
const probe = spawnSync("bun", ["--version"], { encoding: "utf8" });
if (probe.status !== 0) {
  process.stderr.write("bun is not available; the Bun driver conformance cannot run\n");
  process.exit(1);
}
const result = spawnSync("bun", ["test", "test/conformance.test.ts"], {
  cwd: resolve(root, "packages", "driver-bun-sqlite"),
  stdio: "inherit",
  env: { ...process.env, TARIC_CONFORMANCE_REPORT: output },
});
if (result.status !== 0) process.exit(result.status ?? 1);
if (!existsSync(output)) {
  process.stderr.write("conformance report was not written\n");
  process.exit(1);
}
const report = JSON.parse(readFileSync(output, "utf8"));
if (report.report?.passed !== true) {
  process.stderr.write("conformance report is not passing\n");
  process.exit(1);
}
process.stdout.write(`${JSON.stringify({ ok: true, output, runtime: report.runtime, generated_at: report.generated_at, scenarios: report.report.scenarios.length })}\n`);
