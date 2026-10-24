#!/usr/bin/env node
/**
 * 聚合既有来源生成可机读兼容矩阵，供宿主 CI 校验版本配对（宿主运行时 /
 * 宿主二进制 / Taric）。矩阵只做聚合，不引入第二事实源：core 版本取
 * packages/core/package.json，API 契约与 schema 版本取 @taric/schemas，
 * 存储契约与认证宿主集合取 @taric/core。
 *
 * 用法：
 *   node scripts/emit-compatibility-matrix.mjs           # 生成/刷新根目录 compatibility-matrix.json
 *   node scripts/emit-compatibility-matrix --check       # 校验已发布矩阵与来源一致（漂移即失败）
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { API_CONTRACT_VERSION, SCHEMA_VERSION, contractNames, operationContracts } from "../packages/schemas/dist/src/index.js";
import { AUTHORITY_STORAGE_CONTRACT_VERSION, TARIC_COMPATIBILITY_MANIFEST } from "../packages/core/dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readPackage = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const corePackage = readPackage("packages/core/package.json");
const schemasPackage = readPackage("packages/schemas/package.json");
const drivers = ["packages/driver-bun-sqlite/package.json"].map((path) => {
  const manifest = readPackage(path);
  if (!manifest.taric?.runtime) throw new Error(`${manifest.name} package.json must declare taric.runtime`);
  return {
    name: manifest.name,
    version: manifest.version,
    runtime: manifest.taric.runtime,
    exports: Object.keys(manifest.exports ?? {}),
    peer_dependencies: manifest.peerDependencies ?? {},
    runtime_dependencies: manifest.dependencies ?? {},
  };
});
const knownSchemas = new Set(contractNames);
for (const contract of operationContracts) {
  for (const field of ["request", "response"]) {
    if (!knownSchemas.has(contract[field])) throw new Error(`${contract.operation} references unknown ${field} contract ${contract[field]}`);
  }
}

const matrix = {
  schema_version: SCHEMA_VERSION,
  core_version: corePackage.version,
  api_contract_version: API_CONTRACT_VERSION,
  storage_contract_version: AUTHORITY_STORAGE_CONTRACT_VERSION,
  runtime_dependency_closure: {
    "@taric/schemas": { version: schemasPackage.version, exports: Object.keys(schemasPackage.exports ?? {}), runtime_dependencies: schemasPackage.dependencies ?? {} },
    "@taric/core": { version: corePackage.version, exports: Object.keys(corePackage.exports ?? {}), runtime_dependencies: corePackage.dependencies ?? {} },
  },
  drivers,
  operations: operationContracts.map(({ operation, roles, request, response, errors, idempotent, mutates_authority, engagement_scoped, capability }) => ({
    operation, roles, request_schema: request, response_schema: response, errors, idempotent, mutates_authority, engagement_scoped,
    ...(capability ? { capability } : {}),
  })),
  certified_hosts: Object.fromEntries(Object.entries(TARIC_COMPATIBILITY_MANIFEST.hosts).map(([id, host]) => [id, {
    state: host.state,
    package: host.package ?? null,
    version: host.version ?? null,
    commit: host.commit ?? null,
    certified_versions: host.certified_versions ?? (host.version ? [host.version] : []),
    contract: host.contract ?? null,
  }])),
};
const serialized = `${JSON.stringify(matrix, null, 2)}\n`;
const outputIndex = process.argv.indexOf("--output");
const target = outputIndex === -1 ? join(root, "compatibility-matrix.json") : resolve(process.cwd(), process.argv[outputIndex + 1] ?? "");

if (process.argv.includes("--check")) {
  const published = readFileSync(target, "utf8");
  if (published !== serialized) {
    process.stderr.write("compatibility matrix is stale; regenerate with: node scripts/emit-compatibility-matrix.mjs\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ ok: true, matrix }));
} else {
  writeFileSync(target, serialized);
  process.stdout.write(serialized);
}
