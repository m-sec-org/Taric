import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const workspacePackages = ["schemas", "core", "driver-bun-sqlite", "cli", "mcp"];
const startedAt = new Date().toISOString();
const temp = await mkdtemp(join(tmpdir(), "taric-clean-consumer-"));
const packed = join(temp, "packed");
const consumer = join(temp, "consumer");
const packages = [];
const sha256 = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

try {
  await mkdir(packed);
  await mkdir(consumer);
  for (const workspace of workspacePackages) {
    const result = await exec("npm", ["pack", "--json", "--pack-destination", packed, join(root, "packages", workspace)], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
    const info = JSON.parse(result.stdout)[0];
    assert.ok(info.filename, `npm pack returned a tarball for ${workspace}`);
    packages.push({ workspace, filename: info.filename, integrity: info.integrity, files: info.entryCount });
  }

  await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "taric-isolated-consumer", private: true, type: "module" }, null, 2));
  await exec("npm", ["install", "--no-audit", "--no-fund", "--package-lock=false", ...packages.map((item) => join(packed, item.filename))], { cwd: consumer, maxBuffer: 16 * 1024 * 1024 });

  const smoke = `
    import assert from "node:assert/strict";
    import { createCoreServiceForPath, createPrincipal } from "@taric/core";
    import { API_CONTRACT_VERSION, SCHEMA_VERSION, coreSchema } from "@taric/schemas";
    import { MCP_PACKAGE } from "@taric/mcp";
    assert.equal(API_CONTRACT_VERSION, "1.3.0");
    assert.equal(SCHEMA_VERSION, "1.0.0");
    assert.equal(coreSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(MCP_PACKAGE, "@taric/mcp");
    const db = process.env.TARIC_CONSUMER_DB;
    const content = process.env.TARIC_CONSUMER_CONTENT;
    const first = await createCoreServiceForPath(db, content);
    const initialized = await first.init({ name: "isolated consumer lifecycle", scope: { allowed_targets: ["https://consumer.fixture.invalid"], excluded_targets: [], rules_of_engagement_ref: "fixture:consumer" } });
    assert.equal(initialized.ok, true);
    const engagementId = initialized.data.id;
    await first.close();
    const restarted = await createCoreServiceForPath(db, content);
    const status = await restarted.dispatch("engagement.status", createPrincipal("operator", "consumer", engagementId), { engagement_id: engagementId });
    assert.equal(status.ok, true);
    assert.equal(status.data.schema_supported, true);
    await restarted.close();
    console.log(JSON.stringify({ api_contract_version: API_CONTRACT_VERSION, schema_version: SCHEMA_VERSION, engagement_id: engagementId, restart_read_passed: true }));
  `;
  await writeFile(join(consumer, "smoke.mjs"), smoke);
  const dbPath = join(consumer, "authority.sqlite");
  const contentRoot = join(consumer, "content");
  const smokeResult = await exec(process.execPath, [join(consumer, "smoke.mjs")], { cwd: consumer, env: { ...process.env, TARIC_CONSUMER_DB: dbPath, TARIC_CONSUMER_CONTENT: contentRoot }, maxBuffer: 4 * 1024 * 1024 });
  const coreLifecycle = JSON.parse(smokeResult.stdout.trim());
  assert.equal(coreLifecycle.restart_read_passed, true);

  const cliPath = join(consumer, "node_modules", "@taric", "cli", "dist", "bin.js");
  const cliEnv = { ...process.env, TARIC_DB: dbPath, TARIC_CONTENT_ROOT: contentRoot };
  const version = await exec(process.execPath, [cliPath, "--version"], { cwd: consumer, env: cliEnv });
  assert.equal(version.stdout.trim(), "1.3.0");
  const cliInitialized = await exec(process.execPath, [cliPath, "engagement.init", JSON.stringify({ name: "isolated CLI consumer", scope: { allowed_targets: ["https://consumer-cli.fixture.invalid"], excluded_targets: [], rules_of_engagement_ref: "fixture:consumer-cli" } })], { cwd: consumer, env: cliEnv });
  const cliEngagement = JSON.parse(cliInitialized.stdout).data;
  const cliStatus = await exec(process.execPath, [cliPath, "engagement.status", JSON.stringify({ engagement_id: cliEngagement.id })], { cwd: consumer, env: { ...cliEnv, TARIC_ENGAGEMENT_ID: cliEngagement.id } });
  assert.equal(JSON.parse(cliStatus.stdout).data.schema_supported, true);

  const bunSmokePath = join(consumer, "bun-smoke.mjs");
  await writeFile(bunSmokePath, `import assert from "node:assert/strict";\nimport { BunSqliteAuthorityDriver } from "@taric/driver-bun-sqlite";\nconst driver = new BunSqliteAuthorityDriver(":memory:");\nawait driver.ready;\nconst row = await driver.get("SELECT 1 AS value");\nassert.equal(row.value, 1);\nawait driver.close();\nconsole.log("bun-driver-import-and-query-passed");\n`);
  const bun = await exec("bun", [bunSmokePath], { cwd: consumer, maxBuffer: 4 * 1024 * 1024 });
  assert.match(bun.stdout, /bun-driver-import-and-query-passed/);

  const report = {
    version: "taric-clean-consumer/1",
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    runtime: { node: process.version, npm: (await exec("npm", ["--version"])).stdout.trim(), bun: (await exec("bun", ["--version"])).stdout.trim(), platform: process.platform, arch: process.arch },
    consumer: { isolated_temp_directory: true, workspace_linked: false, workspaces: packages, manifest_digest: sha256(await readFile(join(consumer, "package.json"))) },
    results: { package_imports: true, core_startup_and_migration: true, core_close_and_restart_read: true, cli_version_and_persistent_database: true, bun_driver_import_and_query: true },
    limitations: ["Packages were packed from the current workspace dist output; this validates local tarball contents and dependency closure, not registry publication or third-party host certification."]
  };
  const outputIndex = process.argv.indexOf("--output");
  const outputPath = outputIndex >= 0 ? resolve(process.argv[outputIndex + 1]) : undefined;
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) {
    const { writeFile: writeOutput, mkdir: mkdirOutput } = await import("node:fs/promises");
    await mkdirOutput(dirname(outputPath), { recursive: true });
    await writeOutput(outputPath, serialized);
  }
  process.stdout.write(serialized);
} finally {
  await rm(temp, { recursive: true, force: true });
}
