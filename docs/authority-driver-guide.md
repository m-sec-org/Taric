# 实现自定义 Authority 驱动

Taric 的权威存储以驱动契约为边界：**Core 拥有全部状态迁移、排序与策略；驱动只拥有连接、时钟与方言**。任何满足契约的驱动都可以让宿主在自己的运行时内进程内嵌入权威，而不必经过 RPC 桥。

## 契约

实现 `AuthoritySqlDriver`（`@taric/core` 导出）：

- `backend`：`"sqlite"` 或 `"postgresql"`（声明方言；Core 的 SQL 不感知驱动差异）；
- `ready`：惰性初始化——建表/建索引/写入初始 metadata（可直接复用 `AUTHORITY_SQL_TABLES` / `AUTHORITY_SQL_INDEXES` / `AUTHORITY_SQL_INITIAL_METADATA`），并在 schema/storage 格式不兼容时以 `unsupported_schema_version` fail closed；
- `get/all/run/exec`：SQL 执行面；
- `transaction(mode, operation)`：`BEGIN IMMEDIATE/DEFERRED` + savepoint 嵌套；读事务内升级写必须拒绝（`conflict`）；作用域必须跟随异步上下文（`node:async_hooks` 的 `AsyncLocalStorage` 即可，Bun 已实现）；
- `now()`：驱动时钟（ISO 字符串）；
- `dataVersion()`：提交水位（参考实现用 `PRAGMA data_version` + `total_changes()` 组合；无法提供时返回 `NaN` 表示客户端必须重校验）；
- `jsonValue/dateValue`：方言表达式；
- `metrics()/close()`：诊断计数与关闭。

SQLite 参考实现见 `packages/core/src/sql-driver.ts`（node:sqlite），Bun 参考实现见 `packages/driver-bun-sqlite`（bun:sqlite）。

## 验收路径

1. 实现 `AuthoritySqlDriver`；
2. 用 `createAuthorityRuntimeScenarios`（`@taric/core` 导出）在**隔离 fixture** 上运行 12 个权威运行时场景（proposal/review/admission_l1/admission_l2/checkpoint/action/artifact/lease/fencing/audit_outbox/pinned_read/backup_restore），fixture 需提供真实持久化重启（`restart`）与数据库故障注入（`withAuditFailure`）；
3. `runAuthorityRuntimeConformance` 产出报告且 `runtimeConformancePassed` 为真；
4. **另加驱动专项测试**（12 场景是必要条件，不是驱动认证）：嵌套事务与 savepoint 回滚、`now()` 时钟、schema 初始化与不兼容版本 fail closed、进程重启后状态一致、`dataVersion` 水位推进；
5. 归档报告（`docs/benchmarks/*.json` 惯例，脚本走 `scripts/benchmark-*.mjs`）后声明支持。

## Bun 宿主嵌入示例

```ts
import { AuthorityStore, createCoreService, createPrincipal } from "@taric/core";
import { BunSqliteAuthorityDriver } from "@taric/driver-bun-sqlite";

const store = new AuthorityStore(new BunSqliteAuthorityDriver("/path/to/authority.sqlite"));
const service = await createCoreService(store, "/path/to/content-root");
```

注意：`openRuntimeService` 的 sqlite 路径固定构造 node:sqlite 驱动；Bun 宿主（无 `node:sqlite` 内置模块）按上例直接注入驱动构造。Core 已将 `node:sqlite` 的加载延迟到构造 node 驱动时，因此整个 `@taric/core` 包可以在 Bun 下正常导入。

## 已记录的 Bun 差异

Bun 1.3.13 / bun:sqlite 与 node:sqlite 在本契约面（WAL、`busy_timeout`、savepoint、`PRAGMA data_version`、`total_changes()`）上未观察到需要驱动内补正的行为差异；验收证据见 [bun-driver-conformance-v1](benchmarks/bun-driver-conformance-v1.json)。后续发现差异时在驱动内补正并更新本节与报告版本号。
