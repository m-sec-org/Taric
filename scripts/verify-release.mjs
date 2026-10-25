import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { cpus, totalmem } from "node:os";
import { spawnSync } from "node:child_process";
import { coreSchema, operationContracts } from "@taric/schemas";
import { buildReleaseReport, buildSharedAuthorityReleaseEvidence, PostgresAuthorityStore, runAuthorityRuntimeConformance, policyDigest, qualitySampleDigest, runtimeImplementationDigest, TARIC_COMPATIBILITY_MANIFEST } from "../packages/core/dist/index.js";
import { buildProfileVerificationManifest, validateProfileVerificationManifest } from "./profile-verification.mjs";

const root = resolve(import.meta.dirname, "..");
const digest = (input) => `sha256:${createHash("sha256").update(input).digest("hex")}`;
const sourceFiles = [];
const collect = (path) => {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (["node_modules", "dist", "__pycache__"].includes(entry.name) || entry.name.endsWith(".pyc")) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) collect(child); else if (entry.isFile()) sourceFiles.push(relative(root, child));
  }
};
collect(join(root, "packages")); collect(join(root, "scripts"));
sourceFiles.push("package.json", "package-lock.json", "compatibility-matrix.json", "tsconfig.json", "AGENTS.md", "readme.md"); sourceFiles.sort();
const sourceDigest = digest(Buffer.concat(sourceFiles.flatMap((path) => [Buffer.from(`${path}\0`), readFileSync(join(root, path)), Buffer.from("\0")])));
const bunVersion = spawnSync("bun", ["--version"], { cwd: root, encoding: "utf8" });
const runtimeVersions = {
  node: process.version,
  bun: bunVersion.status === 0 ? bunVersion.stdout.trim() : null,
  python: spawnSync("python3", ["--version"], { cwd: root, encoding: "utf8" }).stdout.trim() || null,
};
const buildDigest = (checkout) => {
  const files = [];
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) files.push(relative(checkout, child));
    }
  };
  for (const packageName of ["schemas", "core", "cli", "mcp", "driver-bun-sqlite"]) visit(join(checkout, "packages", packageName, "dist"));
  files.sort();
  return digest(Buffer.concat(files.flatMap((path) => [Buffer.from(`${path}\0`), readFileSync(join(checkout, path)), Buffer.from("\0")])));
};
const base_commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
const source_tree_clean = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout.trim() === "";
const directory = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "taric-clean-verification-"));
const steps = []; const counts = [];
const liveRequested = Boolean(process.env.TARIC_TEST_DATABASE_URL);
const run = (id, command, args, cwd = directory) => {
  const start = performance.now(); const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 20 * 1024 ** 2, env: { ...process.env, NODE_NO_WARNINGS: "1" } });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const passed = result.status === 0;
  process.stderr.write(`verify-release: ${id} ${passed ? "passed" : "failed"}\n`);
  steps.push({ id, passed, elapsed_ms: performance.now() - start, command: [command, ...args].join(" "), output_digest: digest(output), output: output.slice(-256000) });
  if (id.startsWith("tests:")) {
    const number = (key) => Number(new RegExp(`^# ${key} (\\d+)$`, "m").exec(output)?.[1] ?? 0);
    if (id === "tests:hermes") counts.push({ package: "hermes", tests: Number(/Ran (\d+) tests/.exec(output)?.[1] ?? 0), pass: passed ? Number(/Ran (\d+) tests/.exec(output)?.[1] ?? 0) : 0, fail: passed ? 0 : 1, skipped: 0 });
    else if (id === "tests:driver-bun-sqlite") {
      const pass = Number(/^[ \t]*(\d+) pass[ \t]*$/m.exec(output)?.[1] ?? 0);
      const fail = Number(/^[ \t]*(\d+) fail[ \t]*$/m.exec(output)?.[1] ?? 0);
      const skipped = Number(/^[ \t]*(\d+) skip[ \t]*$/m.exec(output)?.[1] ?? 0);
      counts.push({ package: "driver-bun-sqlite", tests: pass + fail + skipped, pass, fail, skipped });
    }
    else counts.push({ package: id.slice(6), tests: number("tests"), pass: number("pass"), fail: number("fail"), skipped: number("skipped") });
  }
  return passed;
};
try {
  // Export the current implementation into an empty directory. No old dist or
  // local dependency tree can mask a missing source/build input.
  for (const path of sourceFiles) { const target = join(directory, path); mkdirSync(dirname(target), { recursive: true }); cpSync(join(root, path), target); }
  for (const path of ["docs", "openspec"]) cpSync(join(root, path), join(directory, path), { recursive: true });
  const built = run("dependencies", "npm", ["ci", "--ignore-scripts"]) && run("clean-build", "npm", ["run", "build"]) && run("typecheck", "npm", ["run", "typecheck"]);
  if (built) for (const packageName of ["schemas", "core", "cli", "mcp", "hermes", "driver-bun-sqlite"]) {
    if (packageName === "hermes") run("tests:hermes", "python3", ["-m", "unittest", "discover", "-s", "tests"], join(directory, "packages/hermes-plugin"));
    else if (packageName === "driver-bun-sqlite") { if (bunVersion.status === 0) run("tests:driver-bun-sqlite", "bun", ["test"], join(directory, "packages/driver-bun-sqlite")); }
    else run(`tests:${packageName}`, process.execPath, ["--test", "--test-concurrency=2", "--test-reporter=tap"], join(directory, "packages", packageName));
  }
  if (built) run("documentation-links", process.execPath, ["scripts/check-doc-links.mjs"]);
  if (built) run("compatibility-matrix", process.execPath, ["scripts/emit-compatibility-matrix.mjs", "--check"]);
  if (built) run("profile-manifest", process.execPath, ["--test", "scripts/test/profile-verification.test.mjs"]);
  if (built) run("clean-consumer", process.execPath, ["scripts/verify-clean-consumer.mjs", "--output", join(directory, "clean-consumer-report.json")]);
  if (built) run("proxy-restart-replay", process.execPath, ["scripts/benchmark-proxy-restart.mjs", `--output=${join(directory, "proxy-restart-report.json")}`]);
  let live;
  if (built && liveRequested) {
    const livePath = join(directory, "postgres-runtime-verification.json");
    run("postgresql-runtime", process.execPath, ["scripts/verify-postgres-runtime.mjs", "--output", livePath]);
    if (existsSync(livePath)) live = JSON.parse(readFileSync(livePath, "utf8"));
  }
  const fixturePath = join(root, "packages/core/test/fixtures/memory-quality-v1.json");
  const qualityDatasetPath = join(root, "packages/core/test/fixtures/quality-samples-v1.json");
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  const qualityDataset = JSON.parse(readFileSync(qualityDatasetPath, "utf8"));
  const samples = Array.isArray(qualityDataset.samples) ? qualityDataset.samples : [];
  const requiredStrata = Array.isArray(qualityDataset.required_strata) ? qualityDataset.required_strata : [];
  const qualityProvenance = qualityDataset.provenance;
  const postgres = new PostgresAuthorityStore({ query: async () => { throw new Error("no configured live PostgreSQL probe"); } }, { profile: "multi_host_authority" });
  const runtime_conformance = await runAuthorityRuntimeConformance(postgres, {});
  const quality = buildReleaseReport({ samples, quality_provenance: qualityProvenance, digests: { commit: runtimeImplementationDigest(), schema: digest(JSON.stringify(coreSchema)), policy: policyDigest(), sample: qualitySampleDigest(samples), fixture: digest(readFileSync(fixturePath)) }, config: { minimumSampleCount: 30, requiredStrata, requiredGateIds: steps.map((step) => step.id) }, gates: steps.map((step) => ({ id: step.id, passed: step.passed, evidence: [step.output_digest] })) });
  const shared = live?.shared_authority ?? buildSharedAuthorityReleaseEvidence({ profile: "multi_host_authority", backend: "postgresql", authority_service: { configured: false, available: false, shared: false, count: 0 }, runtime_conformance });
  const requiredTechnicalChecks = ["dependencies", "clean-build", "typecheck", "tests:schemas", "tests:core", "tests:cli", "tests:mcp", "tests:hermes", "tests:driver-bun-sqlite", "documentation-links", "compatibility-matrix", "profile-manifest", "clean-consumer", "proxy-restart-replay"];
  const technical_passed = requiredTechnicalChecks.every((id) => steps.some((step) => step.id === id && step.passed)) && (!liveRequested || steps.some((step) => step.id === "postgresql-runtime" && step.passed));
  const runtime_verified = technical_passed && live?.runtime_conformance?.passed === true && live?.readiness?.runtime_state === "enabled" && shared.enabled === true;
  // Implementation completion covers the delivered code and verified runtime.
  // Human quality evidence is an independent release decision.
  const implementation_complete = runtime_verified;
  const blockers = [
    ...(!technical_passed ? ["One or more required technical checks failed"] : []),
    ...(!runtime_verified ? ["Complete passing live PostgreSQL runtime verification is required to establish multi-host runtime verification and release readiness"] : []),
    ...(!quality.passed ? ["Representative human annotation and baseline evidence is pending; synthetic fixture cannot establish quality"] : []),
  ];
  const profile_verification = buildProfileVerificationManifest({ checks: steps, runtimeVerified: runtime_verified, sourceDigest, postgresHostCount: shared.diagnostics?.host_count ?? 0 });
  if (!validateProfileVerificationManifest(profile_verification)) throw new Error("profile verification manifest failed validation");
  const profile_manifest_digest = digest(JSON.stringify(profile_verification));
  const specsRoot = join(root, "openspec/specs");
  const specCount = existsSync(specsRoot) ? readdirSync(specsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && existsSync(join(specsRoot, entry.name, "spec.md"))).length : 0;
  const report = { version: "taric-capability-verification/1", base_commit, source_tree_clean, source_digest: sourceDigest, build_digest: built ? buildDigest(directory) : null, schema_digest: digest(JSON.stringify(coreSchema)), policy_digest: policyDigest(), sample_digest: quality.digests.sample, fixture_digest: digest(readFileSync(fixturePath)), profile_manifest_digest, profile_verification, configuration: { runtimes: runtimeVersions, host: { platform: process.platform, arch: process.arch, cpu_model: cpus()[0]?.model ?? null, cpu_count: cpus().length, total_memory_bytes: totalmem() }, checkout: "current source exported into an empty temporary directory", fixture_path: "packages/core/test/fixtures/memory-quality-v1.json", quality_dataset_path: "packages/core/test/fixtures/quality-samples-v1.json", quality_dataset_version: qualityProvenance?.dataset_version ?? null, quality_dataset_provenance_kind: qualityProvenance?.kind ?? null, quality_dataset_sample_count: samples.length, human_annotated_sample_count: qualityProvenance?.kind === "human_annotated" ? samples.length : 0, fixture_sample_count: fixture.samples?.length ?? 0, required_strata_count: requiredStrata.length, spec_count: specCount, operation_count: operationContracts.length, schema_definition_count: Object.keys(coreSchema.$defs).length, live_postgresql: liveRequested, clean_consumer_report: "clean-consumer-report.json", proxy_restart_report: "proxy-restart-report.json" }, technical_passed, runtime_verified, implementation_complete, release_state: !technical_passed ? "failed" : implementation_complete && quality.passed ? "passed" : "blocked", checks: steps, test_counts: counts, capabilities: TARIC_COMPATIBILITY_MANIFEST.capabilities, quality, shared_authority: shared, postgres_runtime: live ?? null, blockers };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  const outputIndex = process.argv.indexOf("--output");
  const postgresOutputIndex = process.argv.indexOf("--postgres-output");
  if (live && postgresOutputIndex >= 0) {
    const path = resolve(root, process.argv[postgresOutputIndex + 1]); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(live, null, 2)}\n`);
  }
  if (outputIndex >= 0) {
    const path = resolve(root, process.argv[outputIndex + 1]); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text);
    const pinPath = join(dirname(path), "release-report.sha256");
    writeFileSync(pinPath, `${digest(text)}\n`);
    process.stdout.write(`${JSON.stringify({ report: relative(root, path), technical_passed, release_state: report.release_state, test_counts: counts, source_digest: sourceDigest })}\n`);
  } else process.stdout.write(text);
  if (!technical_passed) process.exitCode = 1;
} finally { rmSync(directory, { recursive: true, force: true }); }
