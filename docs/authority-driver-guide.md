# 实现自定义 Authority SQL 驱动

本文面向需要把 Taric Authority 存储接入新数据库或运行时的开发者。驱动负责 SQL 执行、事务、时钟和方言适配；记录状态迁移、权限、审计顺序、租约和策略仍由 Core 管理。

当前仓库版本为 Core `1.1.0`、API `1.5.0`、Authority 存储契约 `authority-storage/5`、SQL 布局 `authority-sql/5`。接口定义和 SQLite、PostgreSQL 参考实现见 `packages/core/src/sql-driver.ts`；Bun SQLite 实现见 `packages/driver-bun-sqlite`。

## 驱动接口

`@taric/core` 公共入口导出 `AuthoritySqlDriver`、`SqlRunResult`、`SqlMetrics`、`SqlMetricsSnapshot` 和 `SqlTransactionMode`。驱动需要实现以下成员：

| 成员 | 作用 |
| --- | --- |
| `backend` | 声明数据库类型：`sqlite` 或 `postgresql`，Core 据此选择少量方言分支。 |
| `filename`、`authorityId` | 提供存储位置和稳定的 Authority 身份；后者用于绑定 Authority 级运行状态。 |
| `ready` | 惰性初始化 Promise；建表、索引和初始 metadata，并在遇到不兼容的 schema 或 SQL 布局时拒绝启动。 |
| `get`、`all`、`run`、`exec` | 提供参数化查询、查询行、写入结果及多语句执行。写语句必须返回正确的影响行数。 |
| `transaction(mode, operation)` | 提供异步 `read` / `write` 事务，正确提交或回滚，并支持嵌套事务。 |
| `now()` | 返回可解析的 ISO 时间字符串，使用同一可靠时钟来源。 |
| `dataVersion()` | 返回能发现 Authority 外部写入或数据变化的水位；不可用时返回 `NaN`，让 Core 重新校验。 |
| `jsonValue(column, field, type?)` | 生成 JSON 字段表达式；支持文本、数字和布尔值读取。 |
| `dateValue(expression)` | 生成日期比较表达式，保证时间筛选在该数据库中语义正确。 |
| `metrics()`、`close()` | 返回只读 SQL 计数指标并释放驱动自有资源。 |

方法签名以 `packages/core/src/sql-driver.ts` 中的 TypeScript 类型为准。`get`、`all`、`run` 和 `exec` 都是异步接口，绑定参数使用位置占位符 `?`；新方言必须在驱动边界安全转换参数和 SQL 表达式。

## 实现时必须守住的行为

- Core 拥有全部 Authority 状态迁移。驱动不能自行实现第二套 admission、审计、租约、fencing 或记录版本逻辑。
- `transaction("write", ...)` 必须具备原子性；失败时所有相关写入均回滚。`transaction("read", ...)` 中再次请求写事务必须以 `conflict` 拒绝。
- 嵌套写事务要使用数据库支持的 savepoint 或等价机制，子事务失败只回滚子作用域；异步回调中的 SQL 操作必须留在所属事务上下文。
- 并发执行时，事务及连接使用需要正确排队或隔离，不能让另一请求的 SQL 混入当前事务。
- `ready` 必须可安全重复等待。空库可初始化为当前布局；现存数据的 `schema_version`、`storage_format` 或关键结构不匹配时，以 `unsupported_schema_version` 失败关闭，不得悄悄改写或猜测迁移。
- 数据库驱动若由宿主提供，`close()` 只释放驱动自己拥有的连接；不得关闭不归驱动所有的共享连接池。
- SQL 必须保持 Core 所依赖的比较、排序、唯一性、事务隔离和 JSON/日期读取语义。仅让方法类型检查通过不代表实现满足契约。

## 接入和验收

宿主可将实现注入 `AuthorityStore`，再创建 Core Service：

```ts
import { AuthorityStore, createCoreService } from "@taric/core";
import { MyAuthoritySqlDriver } from "./my-authority-driver.js";

const store = new AuthorityStore(new MyAuthoritySqlDriver(/* host config */));
const service = await createCoreService(store, "/srv/taric/content");
```

接入顺序如下：

1. 实现并构建 `AuthoritySqlDriver`，先通过专项测试验证初始化、参数绑定、日期与 JSON 表达式、事务和关闭行为。
2. 使用磁盘数据库和独立内容目录创建临时 `AuthorityStore`。测试 fixture 必须能关闭并重新打开同一持久化库，也必须能真实注入一次审计事件写入失败。
3. 调用 Core 导出的 `createAuthorityRuntimeScenarios(store, contentRoot, restoreFactory, fixture)`，执行所有场景：proposal、review、admission L1/L2、checkpoint、action、artifact、lease、fencing、audit/outbox、pinned read、backup/restore。
4. 将完整场景结果交给 `runAuthorityRuntimeConformance`；只有全部 12 个场景各自返回有效证据、没有缺少后端方法且 `runtimeConformancePassed(report)` 为真，才算通过运行时一致性验收。
5. 另外保留驱动专项测试和验收报告，记录驱动版本、运行时、数据库版本、配置假设和实际结果。更新驱动、Core 或 SQL 布局后重新验收。

仓库中的 Bun 驱动可作参考：其 `conformance.test.ts` 使用上述 Core 场景，`driver-specific.test.ts` 检查 savepoint、读事务写入拒绝、时钟、初始化、旧布局拒绝及重启持久性。已保存的 [Bun 驱动运行场景报告](benchmarks/bun-driver-conformance-v1.json)只记录那次报告里的 12 个场景结果，不替代新构建或新宿主的实测。

## 验收与生产启用的边界

12 个运行场景验证的是 Core 通过该存储实现后的可观察行为；它们不会穷举数据库故障，也不能取代驱动自己的事务、并发、初始化、恢复和故障注入测试。`runtimeConformancePassed` 只判断报告是否满足该场景合同，不会安装驱动、切换生产数据库或自动授予启用资格。

当前 CLI、Gateway 和 MCP 的标准启动流程按运行配置构造内置 SQLite 或 PostgreSQL 存储；通过一致性验收的自定义驱动不会因此自动出现在这些入口中。使用自定义驱动的宿主必须自行显式注入它，管理配置、健康检查、备份恢复、监控和启动失败策略。任何无法确认存储完整性或驱动状态的情况都应停止 Authority 操作，不应回退到另一份数据库继续写入。

PostgreSQL 多主机运行还要满足对应生产激活合同：为准确的 Core/schema/policy 构建生成并保存运行场景报告，校验部署中的 schema、连接和 lease fencing 健康状态，再由标准启动流程消费匹配的报告。单次测试通过、旧报告、健康探测成功或本机容器验证，均不能单独证明某个新构建和生产部署已完成激活。
