#!/usr/bin/env node
/** bun 不存在时跳过（驱动测试只能在 Bun 运行时执行），存在则透传 `bun test`。 */
import { spawnSync } from "node:child_process";

const probe = spawnSync("bun", ["--version"], { encoding: "utf8" });
if (probe.status !== 0) {
  process.stderr.write("bun is not available; skipping @taric/driver-bun-sqlite tests\n");
  process.exit(0);
}
const result = spawnSync("bun", ["test"], { stdio: "inherit" });
process.exit(result.status ?? 1);
