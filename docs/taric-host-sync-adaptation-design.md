# Taric 宿主同步适配：设计与实现方案

> **版本**：v1（2026-10-22）
> **状态**：历史设计稿，主要条目已在 [host-sync contract change](../openspec/changes/archive/2026-10-25-close-host-sync-contract-gaps/release-report.md) 中实现。下文各节“现状”与实施顺序均是设计时基线，不是当前差距/待办；归档报告也绑定 pre-1.0.0 源码，不代表当前发布验证。当前合同以 [API 边界](taric-api.md)、[接入指南](agent-integration.md) 和 [代码设计](taric-design.md) 为准。
> **背景**：[Taric面向渗透测试智能体的集成方案](Taric面向渗透测试智能体的集成方案.md) §14 与 BreachWeave 宿主工作区输入文档《Taric外置记忆集成差距分析与建议方案.md》（v4，未随 Taric 仓库分发）的分析表明：BreachWeave 集成中最昂贵的宿主侧工程，其成本多数来自 Taric 的**通用性缺口**而非 BreachWeave 的特殊性。

> **当前状态（2026-10-27）**：Taric `1.0.1` runtime components 的 build/typecheck/matrix 和 PostgreSQL 配置下的 workspace 测试通过（Core 356、Schemas 10、CLI 37、MCP 12、Hermes 5、Bun driver 11，无 PostgreSQL 跳过）。PostgreSQL 当前源码 12 个 runtime scenario、独立备份恢复、两个独立 Node host 容器 lease/reclaim 和容器 spool 检查通过。Pi 1.4.0 真实 RPC host 成功加载 Taric extension，但未调用模型或工具；完整第三方宿主流程、跨物理机网络恢复仍未验证。可选 TLS TCP/HTTPS gateway 已实现并通过本机 loopback 端到端测试；生产网络部署和跨机故障恢复未认证。MCP resources/Tasks、npm registry 发布仍未支持。旧候选 release report 和下方设计时行号不得替代当前证据。
> **本方案的约束（不可违反）**：Taric 保持**独立且通用的外置记忆插件**定位——
> 1. 每项改动必须能以"任意宿主接入都需要"的语言立项，BreachWeave 只是首个消费者与验证宿主；
> 2. 宿主域概念（WSTG 字典、渗透工具、CTF/项目语义等）**禁止进入 core**；`test_category` 等保持为不透明字符串字段；
> 3. 安全不变量不动：零模型直写、`capture.observation` host-only、fail closed、五硬门由非 LLM 策略引擎重算、L1 ≠ 事实、L0/L1 默认不进普通召回、Artifact 不解析/不脱敏/不扫描。

---

## 目录

- [0. 项目总览](#0-项目总览)
- [1. 通用护栏与变更流程](#1-通用护栏与变更流程)
- [2. T-A 驱动可移植性与包发布面（RM-1 收尾）](#2-t-a-驱动可移植性与包发布面)
- [3. T-B WorkItem 资源引用与调度查询](#3-t-b-workitem-资源引用与调度查询)
- [4. T-C 覆盖闸门 dispatch 化](#4-t-c-覆盖闸门-dispatch-化)
- [5. T-D 宿主面订阅信号（RM-3 阶段 A）](#5-t-d-宿主面订阅信号)
- [6. T-E Artifact 文件直取](#6-t-e-artifact-文件直取)
- [7. T-H 派生观察证据硬门](#7-t-h-派生观察证据硬门)
- [8. T-F 多 principal 网关（可选件）](#8-t-f-多-principal-网关可选件)
- [9. T-G 独立复核参考实现](#9-t-g-独立复核参考实现)
- [10. D1 / D2 / D4 版本与契约协同](#10-d1--d2--d4-版本与契约协同)
- [11. 实施顺序与依赖](#11-实施顺序与依赖)
- [12. openspec 变更清单](#12-openspec-变更清单)
- [13. 验收与回归](#13-验收与回归)
- [14. 风险与回退](#14-风险与回退)

---

## 0. 项目总览

| # | 名称 | 一句话 | 通用性表述（第二宿主收益） | 规模 | 前置 |
|---|---|---|---|---|---|
| T-A | 驱动可移植性与包发布面 | 导出驱动契约 + 发布面 + `bun:sqlite` 参考驱动 | 任何 Bun/Deno 运行时宿主获得进程内嵌入能力 | 中 | 无 |
| T-B | WorkItem `resource_refs` | 任务-资源结构化绑定 + 调度查询 | 任何做任务调度的宿主免去自建并行元数据表 | 小 | 无 |
| T-C | 覆盖闸门 dispatch 化 | `coverage.gate` / `coverage.query` 操作 | 完成判据与覆盖看板成为标准查询面 | 小 | 无 |
| T-D | 宿主面订阅信号 | 无内容变更信号（进程内 API + RPC 通知帧） | 把"轮询发现状态变化"降为协议层自然发生 | 中 | T-A（进程内层） |
| T-E | Artifact 文件直取 | `artifact.ingest_file` 本机路径入库 | 任何同机宿主免去自写分块上传 | 小 | 无 |
| T-H | 派生观察证据硬门 | 策略可配："归纳类提案必须引用宿主来源证据" | 反幻觉主张的结构化加强（非放松） | 小 | 无 |
| T-F | 多 principal 网关 | adapter RPC 按 token 解析 principal（可选件） | 多进程/远程部署免去每 principal 一个 listener | 小 | 无 |
| T-G | 独立复核参考实现 | `taric review` 固定输入复核 harness | L2 复核从"每宿主自研"降为"配置模型池" | 中 | 无 |
| D1 | Pi 宿主版本升级 | SUPPORTED_PI_HOST 1.1.0 → 1.4.0 | 与上游活跃线同步 | 小 | 无 |
| D2 | 宿主契约开放（RM-2） | 版本门从严格相等改为认证版本集合 + 未认证显式降级（宿主 ID 开放**已在现仓落地**，见 §10） | 自研/新版本宿主可注册且能力边界可预期 | 中 | 无 |
| D4 | 跨仓版本矩阵 | 发布可机读版本/兼容清单供宿主 CI 消费 | 任意宿主可自动校验版本配对 | 小 | D1/D2 |

与 BreachWeave 方案的对应关系：T-A↔C1（桥进程消失）、T-B↔C9/C14、T-C↔C10、T-D↔C5、T-E↔C8、T-H↔C3、T-G↔C4、T-F↔C1 回退路径。

---

## 1. 通用护栏与变更流程

1. **立项语言检查**：每个 openspec proposal 的 Why 段必须包含一句不含 BreachWeave/渗透域名词的通用动机；评审时若删掉该句则不通过。
2. **变更流程**：沿用仓库惯例 `openspec/changes/YYYY-MM-DD-<name>/`（archive 下现有 9 个已归档变更同构），每个变更含 `proposal.md`、`design.md`、`specs/`（spec delta）、`tasks.md`、`release-report.md`；测试落在对应 `packages/*/test` 并随 tasks 验收；`packages/schemas/src/registry.ts` 的 `operationContracts` / `unsupportedContracts` / `permanentNonGoals` 与实现同步演进。
3. **版本策略**：新增操作只扩 `API_CONTRACT_VERSION` minor；schema 破坏性变更（如 WorkItem 加字段为可选，非破坏）按仓库"无向后兼容"原则直接演进并升 `SCHEMA_VERSION`；`ADMISSION_POLICY_VERSION` 仅在 T-H 默认行为改变时升版（T-H 默认关闭，首轮不升版）。
4. **新增操作的固定配方**（T-B/T-C/T-E/T-F 共用）：
   - `packages/schemas/src/registry.ts` → `operationContracts` 增条目（operation、roles、request/response 契约名、errors、idempotent、mutates_authority、engagement_scoped、capability）；
   - `packages/schemas/src/types.ts` → 请求/响应 schema 定义并注册进 `$defs` 契约名清单（`packages/schemas/src/index.ts`）；
   - `packages/core/src/service.ts` → `aliases` 映射（service.ts:1171 附近）+ `api` 方法实现；`artifact.*` 操作自动获得 AJV 请求校验（service.ts:1159-1168），**非 `artifact.*` 新操作（`work.query`、`coverage.*`）的请求参数校验需在 api 方法内手写**（沿用现有 query 类操作写法）；
   - `authorize()`（service.ts:1195 起）自动执行角色/Engagement 归属校验，但 **capability 映射来自 `capabilityForOperation` 的硬编码链**（service.ts:1295 起）：`artifact.ingest_file` 因前缀自动获得 "content" 能力；`work.query` 需并入既有 work 组、`coverage.query` 需并入 read 组，漏加则该操作无能力门（过宽）；
   - store 层支撑按需新增：如 `work.query` 的活跃 WorkRun 聚合（现仅有单查 `getWorkRun`，store.ts:2868，无列表查询），应在 `maintenanceRead` 快照内实现，并同步进 `AUTHORITY_BACKEND_METHODS`（storage-contract.ts:38）与 conformance 套件。

---

## 2. T-A 驱动可移植性与包发布面

### 2.1 设计时现状（源码核验，历史基线）

| 事实 | 位置 |
|---|---|
| 驱动接口 `AuthoritySqlDriver` 已定义且完备（backend/get/all/run/exec/transaction/now/dataVersion/jsonValue/dateValue/metrics/close） | `packages/core/src/sql-driver.ts:23-39` |
| `AuthorityStore` 构造器接受驱动注入（`filename \| AuthoritySqlDriver`） | `packages/core/src/store.ts:324-326` |
| 一致性套件与 12 场景工厂**已导出**（RM-1 的套件公开化部分已完成） | `index.ts:27`（`runAuthorityRuntimeConformance` 等）、`index.ts:31`（`createAuthorityRuntimeScenarios`） |
| **驱动类型未从 index.ts 导出**（只导出了 `AuthorityStore`，line 6） | `packages/core/src/index.ts:6` |
| `@taric/core` 为 `private: true`、仅 `main`/`types` 无 `exports` map——**跨仓消费不可行** | `packages/core/package.json` |
| Postgres 驱动同样在 sql-driver.ts 内（`PostgresAuthorityDriver`，接受注入 queryable，line 194 起），驱动类未从 index 导出；注意 `PostgresQueryable` **类型已经** postgres.ts:9 → index.ts:25 导出 | `packages/core/src/sql-driver.ts:167-326` |

结论：T-A 不是重写存储，而是**发布面收尾 + 一个新驱动**。

### 2.2 设计

**(a) 导出驱动契约**：`index.ts` 增补导出 `AuthoritySqlDriver`、`SqliteAuthorityDriver`、`PostgresAuthorityDriver`、`SqlRunResult`、`SqlMetrics`、`SqlMetricsSnapshot`、`SqlTransactionMode`（`PostgresQueryable` 已由 index.ts:25 导出，无需重复）。

**(b) 包发布面**：设计时建议为 Core 增加 `exports` map 并确定分发渠道。该设计稿当时记录 `@taric/schemas@0.1.0`；当前 runtime components 为 `1.0.1`。Core/Schemas/Bun driver 的 exports 已实现，包清单仍为 private，因此 registry 发布尚未发生；本地构建和测试验证不等于 registry 可安装。

**(c) Bun 参考驱动**：新包 `packages/driver-bun-sqlite/`（命名 `@taric/driver-bun-sqlite`；**目录必须平铺在 `packages/` 下**——根 workspaces 是 `["packages/*"]` 单层 glob，`packages/drivers/bun-sqlite` 两层路径不会被识别），实现 `BunSqliteAuthorityDriver implements AuthoritySqlDriver`：

- 基于 `bun:sqlite` 的 `Database`（同步 API，与 `node:sqlite` `DatabaseSync` 同构：`prepare/get/all/run/exec` 直接映射）；
- 复用 `AUTHORITY_SQL_TABLES / AUTHORITY_SQL_INDEXES / AUTHORITY_SQL_INITIAL_METADATA`（`sql-schema.ts`）与现有 `SqliteAuthorityDriver` 的 WAL/`busy_timeout=5000`/savepoint 事务模型（sql-driver.ts:91,128-153）——实现上以复制 `SqliteAuthorityDriver` 骨架、仅替换 DatabaseSync 构造与类型适配为宜（约 300 行）；
- `dataVersion()` 使用同一 `PRAGMA data_version` + `total_changes()` 组合；
- AsyncLocalStorage 事务作用域：Bun 实现了 `node:async_hooks`，直接复用；
- `backend` 声明为 `"sqlite"`（方言一致，Core 的 SQL 不感知驱动差异）；
- 备注：若目标 Bun 版本已提供可用且完整的 `node:sqlite` 兼容层并能通过本节全部验收套件，则可直接复用 `SqliteAuthorityDriver`，`bun:sqlite` 驱动仍按本方案交付作为不依赖兼容层的保底路径（与集成方案 §14.8 #1"不要 polyfill"不冲突：这里走的是 Taric 自己的驱动契约，不是伪造 `node:sqlite`）。

**(d) 驱动验收路径文档化**：`docs/` 新增"实现自定义 authority 驱动"指南：实现接口 → 跑 `createAuthorityRuntimeScenarios` 12 场景 → `runAuthorityRuntimeConformance` 报告全过 → 声明支持。

### 2.3 实现步骤

1. `packages/core/src/index.ts` 增补导出（无行为变化）。
2. `packages/core/package.json` exports map + 发布策略；`@taric/schemas` 发布策略同步；`packages/driver-bun-sqlite/` 新包 + `bun:test` 测试。根 `package.json` 的 `build`/`typecheck` 脚本为显式枚举（schemas/core/cli/mcp），需追加新包；`scripts/verify-release.mjs` 的包清单（现为 schemas/core/cli/mcp/hermes）同步。
3. 测试：Bun 1.3.x 下运行 12 场景（`proposal/review/admission_l1/admission_l2/checkpoint/action/artifact/lease/fencing/audit_outbox/pinned_read/backup_restore`，定义于 `storage-contract.ts:57-60`），**另加驱动层专项测试**（见 §2.4 第 2 条）。
4. 文档：驱动指南 + `agent-integration.md` 增补"Bun 宿主进程内嵌入"一节（复用 `openRuntimeService`，见 `runtime-service.ts`）。

### 2.4 验收

- Bun 驱动过全部 12 场景；`runtimeConformancePassed` 为真。
- **驱动层专项测试**（能力提升提案对 RM-1 的既有裁决："driver 层还需事务、savepoint、时钟、初始化和重启测试，不能把 12 个后端场景等同于驱动认证"，见 `docs/taric-capability-improvement-proposal.md` RM-1 行）：嵌套事务与 savepoint 回滚、`now()` 时钟、schema 初始化与版本不兼容 fail closed、进程重启后状态一致、`dataVersion()` 水位推进。12 场景是必要条件，不是充分条件。
- `deployment-guard` 对本地文件 Bun 嵌入不误伤（`shared_sqlite_path` 检查的是"路径对多主机可见"，`nfs_lock` 检查的是"非本地锁实现/NFS"，两者均不针对单进程本地文件，`deployment-guard.ts:34-37`）。
- BreachWeave 侧冒烟：Bun 宿主进程 `openRuntimeService` + 基本 A/B 路径操作成功。

### 2.5 风险与回退

- `bun:sqlite` 与 `node:sqlite` 的边缘差异（`busy_timeout` 语义、`PRAGMA data_version` 刷新时机）：以场景测试暴露；不足处驱动内补正并记录。
- 回退：BreachWeave 回到 v3 的 Node 桥拓扑（`listenAdapterRpc`，`adapter-rpc.ts:22`），该路径保持受支持。

---

## 3. T-B WorkItem 资源引用与调度查询

### 3.1 设计时现状（历史基线）

原设计快照中的 `WorkItem` 尚无资源引用字段。当前 schema 支持经引用完整性校验的 `resource_refs`，`work.query` 提供有界查询与 model-safe projection；这些引用是调度提示，不是目标资源锁，互斥、限速和 worker 调度仍属宿主职责。下方 T-B 设计细节保留该能力的历史实现方案。

### 3.2 设计

1. **schema**：`WorkItem` 增可选字段 `resource_refs?: Uuid[]`（允许 `resource/resource_revision/service/endpoint` 四类）。类别集的语义先例是 `tested_resource_refs`（`["resource","endpoint","service","note"]`，validation.ts:94）等目标资源类引用——**不是** `subject_ref`（validation.ts:110，其为 13 类主题引用集，不含 service/endpoint）。可选字段、无默认值，对现有提案零影响。
2. **引用完整性**：`validation.ts` 引用类别表新增 `resource_refs` 条目；`proposal.submit(work_item)` 时按现有机制校验存在性/同 Engagement/版本，失败 fail closed。
3. **查询面**：新增 dispatch 操作 `work.query`（roles: `model/host/operator`；读；engagement_scoped）：请求 `{engagement_id, resource_refs?: string[], status?: string[], include_active_runs?: boolean}`；响应返回匹配 WorkItem 列表及（可选）其活跃 WorkRun 的 owner/generation/lease 到期。store 层需新增"按 Engagement 列出活跃 WorkRun"的查询（现仅有按 id 单查 `getWorkRun`，store.ts:2868），在 `maintenanceRead` 快照内实现并纳入 `AUTHORITY_BACKEND_METHODS`。宿主据此实现两个谓词：**资源集不相交分派**与**同资源至多一个活跃执行者**（后者配合 `work.claim` 唯一租约——store 已保证"WorkItem 已有活跃租约则拒绝再认领"，store.ts:2453；见 storage-contract 的 lease/fencing 不变量）。
4. **语义边界（写进 spec）**：`resource_refs` 是调度提示元数据；Taric **不因此引入目标资源锁**，不改变集成方案 §7.3"任务唯一租约 ≠ 目标资源锁"的承诺。

### 3.3 验收

- 无 `resource_refs` 的旧式提案照常通过（schema 向后兼容由可选性保证）。
- 跨 Engagement/悬空引用被拒；`work.query` 按资源过滤正确、分页（keyset）正常。
- 12 场景回归全绿。

---

## 4. T-C 覆盖闸门 dispatch 化

### 4.1 现状

`evaluateCoverageGate`（纯函数，coverage.ts:167-186）与 `coverageCloseGate`（store 感知版：单一 `maintenanceRead` 快照内合并 cells + `coverageVisibility` 的 pending_impact/revalidation/conflicted，coverage.ts:187-200）均只作为库函数从 `index.ts:8` 导出；集成方案 §14.8 #12 已记录"bridge 只能本地计算"的不便。

### 4.2 设计

新增两个 dispatch 操作（按 §1 配方）：

| 操作 | roles | 语义 |
|---|---|---|
| `coverage.gate` | `host/operator` | 包装 `coverageCloseGate(store, engagement_id)`：返回 `can_close/gaps[]/visibility 摘要`（含 recalled 历史的 operator 视图，故限高权限角色） |
| `coverage.query` | `model/host/operator` | cells 分页查询：维度过滤（resource_ref/test_category/status），字段白名单投影；model 角色用于规划读缺口 |

请求/响应契约（`coverageGateResult`/`coverageQueryRequest`）加入 `types.ts` 与 `$defs`。响应中 gap 的 `kind` 枚举直接复用 `CoverageGateResult`（coverage.ts:51-54）。capability 映射（§1 配方第 4 条）：`coverage.query` 并入 `capabilityForOperation` 的 read 组；`coverage.gate` 角色门（host/operator）已足够收紧，挂 read 能力即可（两种角色默认能力集均含 read）。

### 4.3 验收

- 库函数与 dispatch 结果一致性测试（同一快照输入逐字段相等）。
- model 角色调 `coverage.gate` 被拒（authorization_error）；`coverage.query` 不泄漏 L0/L1 候选（沿用 `includeCandidates` 白名单规则）。

---

## 5. T-D 宿主面订阅信号

### 5.1 现状

- Adapter RPC 为纯请求-响应（`adapter-rpc.ts`，服务端从不主动写行）；`grep notification` 为 0。
- 增量原语已就绪：`resumeContextDelta`（context.ts:473-506，`from_read_seq` 起的 added/updated/removed/events）已从 `index.ts:7` 导出；`host.state` 轮询已交付。
- 差距分析 §5 已完成机制论证（无内容通知、合并节流、投递时重鉴权、至少一次+可退化为轮询、不进审计正文）。

### 5.2 设计（分三层交付）

> 决策依据：能力提升提案对 RM-3 的裁决是"P2 先完成有界状态读取与轮询基线，再用实际轮询成本、发现延迟决定是否启用订阅"。`host.state` 轮询基线已交付，BreachWeave v4 差距分析（§5）提供了轮询成本与发现延迟的需求证据，据此进入本项；轮询作为永久退化路径保留（本节漏信号语义）。

**L0 进程内订阅 API**（随 T-A 即可用，嵌入宿主首选）：

```ts
// CoreService 新增
subscribe(principal: Principal, options: {
  engagement_id: string;
  since_read_seq?: number;
  topics?: readonly SubscriptionTopic[];   // 见下
  debounce_ms?: number;                    // 默认 1000，上限 10000
}, onSignal: (signal: SubscriptionSignal) => void): { unsubscribe(): void }

// 信号无内容
interface SubscriptionSignal { topic: string; engagement_id: string; read_seq: number; emitted_at: string }
```

- 首期主题：`delta`（read_seq 推进）、`l1_backlog`（候选积压越阈值）、`impact_pending`（影响传播未完成）、`lease_expiry`（租约临近过期/被 reclaim）、`artifact_integrity`（完整性失败）。
- **触发机制选型**（二选一，推荐 b）：
  a) 提交路径内联钩子（低延迟，侵入 store）；
  b) 内部定时器轮询 `driver.dataVersion()` + 水位比较（零侵入，延迟=轮询间隔；`dataVersion()` 已是驱动接口成员，sql-driver.ts:34）。
- **投递时重鉴权**：每次触发信号前重跑 `authorize(principal, "context.query", engagement_id)` 逻辑（复用 service.ts:1195 的 authorize）；权限失效即静默退订。
- 漏信号语义：客户端凭最后已知 `read_seq` 调 `resumeContextDelta` 补齐——订阅是优化，权威状态才是事实。

**L1 RPC 通知帧**（服务独立进程/远程宿主）：adapter-rpc 增加新 JSON-RPC 方法 `taric.subscribe`——连接显式进入订阅模式后，服务端可写 unsolicited 行 `{jsonrpc:"2.0", method:"taric.notification", params: SubscriptionSignal}`；未订阅连接行为完全不变（协议向后兼容）；行限复用 `RPC_LINE_MAX_BYTES`。token/principal 鉴权沿用连接级，信号内容无敏感面。

**L2 MCP resources**（后续独立变更，不在本方案范围）：`resources/subscribe` + `notifications/resources/updated`，URI 挂 delta/coverage/candidates。

### 5.3 硬约束（写进 spec，违反即设计错误）

通知不携带实体内容（只 topic+read_seq）；模型永不直接订阅（宿主面能力）；事件不进审计链正文（仅投递元数据可审计）；合并节流保证 N 秒至多一信号且 delta 覆盖全部变更（零信息损失）。

### 5.4 验收

- 1000 次快速提交下，订阅者 1s 窗口内至多收 1 个 `delta` 信号，`read_seq` 为最新已提交值。
- 投递前撤销 capability → 信号停止且退订被记录。
- kill 掉订阅连接后重连，`resumeContextDelta(since=最后信号 read_seq)` 补齐无遗漏。

---

## 6. T-E Artifact 文件直取

### 6.1 现状

- 元数据级 external 登记已支持（`storage_mode:"external"` + `host_ref` + `expected_bytes/expected_hash`，`artifact-content-store.ts:64,248-251`）。
- 字节入库必须宿主自切块走 `artifact.store.begin/append/commit`；RPC 面单行 1 MiB、读 512 KiB 上限（`adapter-rpc.ts:11-14`）；二进制流式 append 已有**内部** API `artifactStoreAppendBinaryStream`（`adapter-rpc.ts:155` 消费，socket 流→分块）。
- **已有先例**：CLI 子命令 `artifact.store.append-file <metadata-json> <path>`（`packages/cli/src/cli.ts:69-95`）已经实现"本地文件 → `createReadStream`（64 KiB highWaterMark）→ `artifactStoreAppendBinaryStream`"，单文件上限 64 MiB（`ARTIFACT_CHUNK_BYTES`）。它证明"文件版 BinaryStream"路径可行，但它是 CLI 专用路径、要求宿主先 `begin` 再逐块 append、且不覆盖 commit。

### 6.2 设计

`artifact.ingest_file` 是可选宿主扩展（roles: `host/operator`；mutates_authority: true；engagement_scoped: true；idempotent: true）。请求必须包含 `authorize_spool_access: true`，表达本次对已绑定任务会话 spool 的明确授权；授权与每次调用绑定，`delete_source` 另行表示本次删除授权。

- Core 在绑定根内打开一个不跟随末端符号链接的文件描述符，核对 descriptor、目录项和真实路径身份；同一个 descriptor 只读取一次，在实际分块时累计完整内容 hash，并将相同字节送入既有 staging、校验、publication 和幂等路径。
- `path` 不得包含 `..`，且必须位于已绑定根目录内。支持的最大字节数由 `TARIC_INGEST_MAX_BYTES` 设置，默认 2 GiB；无效配置在读取前失败。外部 Artifact 仍是默认零拷贝方案，不会打开其内容。
- 读取过程中若路径身份、descriptor 元数据或实际长度变化，Core 在 publication 前拒绝；stage 数据不会出现在 Artifact catalog。Node/Bun 当前文件 API 无法原子地比较文件对象并 unlink，因此即使请求设置 `delete_source: true`，Core 也保留源文件并返回 `source_deleted: false` 与原因。若以后某运行时提供原子身份条件删除，只有绑定目录项仍匹配已读对象时才可启用；检测到替换或无法核对时必须保留路径项。
- Taric 不解析、扫描、分类或脱敏这些字节；凭据、内容脱敏、保留期限及一般删除策略仍由宿主/operator 负责。

### 6.3 验收

- 大文件经 `ingest_file` 入库后 `artifact.content.read` 校验哈希一致；同一源和 `idempotency_key` 重试幂等。
- 未显式授权、路径逃逸、符号链接、并发替换和中断读取均失败关闭且不发布；失败保留源文件，`delete_source` 只在成功提交后尝试。
- 12 场景（含 artifact）回归。

---

## 7. T-H 派生观察证据硬门

### 7.1 现状

`HARD_GATES = ["schema","scope","evidence","freshness","independence"]`（`policy.ts:16-22`）；evidence 门校验引用存在性/同域/钉版本，**不校验被引证据的来源角色**。`AdmissionPolicy`（policy.ts:30-37）支持版本化；`policyDigest`（policy.ts:144-146）**只 canonical 化 `{policy_id, version, hard_gates, risk_profiles}` 四个字段**。记录侧的来源判定字段已存在：`provenance.source_kind`（`"model" | "worker" | "host" | "tool" | "import"`，types.ts:206-214）。

### 7.2 设计

`AdmissionPolicy` 增可选字段：

```ts
/** 归纳类 subject 的证据来源角色白名单；缺省不启用（行为不变）。 */
derived_subject_evidence_roles?: Partial<Record<AdmissionSubject, ReadonlyArray<"host" | "operator">>>;
```

- 执行点：`evaluateAdmission` 的 **evidence 门**内——当提案 `subject_type` 命中策略且 `evidence_refs` 非空时，逐条解析被引记录的**提交来源角色**（字段取 `provenance.source_kind`，types.ts:206-214；注意 `evaluateAdmission` 的输入是 `PinnedEvidence[]`（仅 id/version/observed_at/status），来源角色需由调用方（store 的 admitProposal 路径）解析记录 provenance 后随 AdmissionInput 传入——这是本项的管道改动点），任一不属于允许集 → 该门 fail closed，理由码 `evidence_origin_untrusted`。
- **policyDigest 必须同步修改**：现有 digest 只哈希四个字段（policy.ts:144-146），新增可选字段**不会**自然改变 digest——原设计"policyDigest 变化自然进审计"的假设不成立。正确做法：`policyDigest` 的 canonical 输入在字段**缺省时保持与现基线逐字节一致**（仅显式配置时纳入该键），启用后 digest 变化进审计（现有机制）。
- 默认关闭（字段缺省 = 现行为 = digest 不变），策略启用后行为与 digest 同时变化。
- 典型配置（BreachWeave 用例，写进文档而非代码）：`negative_observation/claim → ["host","operator"]`——LLM 的归纳提案必须引用宿主捕获的证据，"模型总结工具字节"与"工具字节本身"的信任分层被结构化执行。这**加强**而非放松 Taric 的反幻觉主张。

### 7.3 验收

- 启用策略后：引用 model 来源证据的 `negative_observation` 提案在 evidence 门被拒；引用 host capture 的通过；未启用时行为与基线逐字节一致。
- digest 断言：未启用时 `policyDigest(DEFAULT_ADMISSION_POLICY)` 与基线完全相同；仅启用时变化。`policyDigest` 差异进审计事件；回归：`trusted-node-governance.test.mjs`、`policy.test.mjs` 全绿。

---

## 8. T-F 多 principal 网关（可选件）

### 8.1 现状

`listenAdapterRpc` 每 listener 绑定单一 host principal（`adapter-rpc.ts:24` 硬校验 host 角色）；`taric proxy` 固定 host 身份（`packages/cli/src/proxy.ts:18-21` 的 `createPrincipal("host", …)`）。T-A 落地后嵌入宿主不再需要它，价值集中在**多进程/远程部署**形态。

### 8.2 设计（最小侵入）

- `AdapterRpcOptions` 增可选 `resolvePrincipal?: (declared: { role: PrincipalRole; principal_id: string; engagement_id?: string }, token: string) => Principal | Promise<Principal>`；提供时连接首帧携带声明身份，经 resolver 构造并 `registerTransportPrincipal`（沿用 `service.ts:40`）；resolver 必须自行校验 token↔身份映射（配置文件或回调）。
- 未提供 resolver 时行为与现在完全一致（单 principal）。
- CLI：`taric gateway --config <gateway.json> --runtime-config <runtime.json>`：listener/token 文件与 authority runtime 文件分离；显式 runtime 配置严格失败，运行时 authority 在进程生命周期内固定。
- 审计不变量：请求体永不能自选身份，身份只来自 resolver 查表。

### 8.3 验收

- 同一 listener 上 host 与 reviewer 身份并存，`review.submit` 仅 reviewer token 成功；伪造声明（token 与身份不匹配）全部 `authorization_error`。

---

## 9. T-G 独立复核参考实现

### 9.1 设计

Taric 只提供确定性的审阅输入与治理接口，不运行或调用模型，不挑选/调度 reviewer，也不生成 verdict。`review.pack` 从 admission 事务保存的输入读取提案、全部 claim/evidence/scope 记录、snapshot hash 和 policy digest；它不使用普通查询游标，也不从当前 records 表替换证据。`review.submit` 对已 admission 的 Finding 校验提案 hash、证据 snapshot hash 和 policy digest，绑定变化时在写入 review/event 前返回 `stale_version`。

`taric review --proposal <id> --export` 或 `--input-hash <sha256> --export` 是可选的格式化命令；`--submit-result <path>` 仅转交宿主/operator 在 Taric 外准备的 verdict 和固定绑定。Reviewer 身份与 attestation 由可信宿主配置 `TARIC_REVIEWER_ID` 和 `TARIC_REVIEWER_ATTESTATION` 提供，结果文件不能自选身份或声明 attestation。`--model`、provider、`--auto` 和交互 verdict 参数均不受支持。模型调用、人审、reviewer 池和 verdict 生命周期由宿主/operator 管理。

### 9.2 验收

- 超过 1,000 个合并引用仍完整导出，重复生成 pack hash 稳定；当前证据替换不改变已保存审阅包。
- 提案、证据 snapshot 或 policy 绑定错误在 mutation 前以 `stale_version` 拒绝；模型/provider 参数返回 unsupported，且无 provider 请求或 Taric 状态写入。

---

## 10. D1 / D2 / D4 版本与契约协同

### D1：Pi 宿主版本升级（1.1.0 → 1.4.0）

- 改 `SUPPORTED_PI_HOST`（`pi-adapter.ts:8-16`）：`version: "1.4.0"`、`host_commit` 取 `earendil-works/pi` v1.4.0 tag commit、certification ref 更新。
- 重跑 `packages/core/test/host-adapters.test.mjs`；同步 `compatibility.ts` 的 `TARIC_COMPATIBILITY_MANIFEST`（唯一源原则，差距分析 §2.3）。
- 注意 v1.2.0 起的破坏项（`before_agent_start` 扩展触发、MCP resource listing）是否影响现有 hooks 断言。

### D2：宿主契约开放（RM-2 落地）

- **宿主 ID 开放已完成，不再是工作项**：`AdapterHostId` 已是开放 `string`（`adapter.ts:14`，注释明确"extension points, rather than an allow-list"），`isValidAdapterId`（adapter.ts:199）与 `createCustomAdapterDescriptor`（adapter.ts:171）已实现并从 index.ts:10 导出。
- 设计时剩余的是版本认证门；当前源码已有 Pi 认证版本清单和未认证显式降级，compatibility manifest 对认证上限、`not_certified` 安全子集与 `unsupported` 诊断集作区分。未认证版本不因降级进入 `supported`。
- 与能力提升提案对 RM-2 的既有裁决对齐（`docs/taric-capability-improvement-proposal.md`）："未测试版本不自动 supported；每个 package/fork/version/commit 单独取证；兼容区间必须有区间边界测试支持"。据此：降级 ≠ supported（未认证版本永不进入 `supported` 列表，capability 证据必须显式标 `not_certified`）；若声明版本区间，区间两端必须有边界测试。
- 以新 dated openspec 变更承接（既有 `integrate-native-host-adapters` 已归档完结，`registry.ts:177` 的 followUpChanges 仅作历史索引，不重复打开）。

### D4：跨仓版本矩阵

- Taric CI 发布可机读清单：`{ core_version, api_contract_version, schema_version, supported_pi_hosts[], storage_contract_version }`（多数字段已存在于 registry/compatibility，聚合即可）。
- BreachWeave CI 消费该清单 + 自身 Pi 版本，做三方配对断言（宿主 / 容器二进制 / Taric）。Taric 侧不依赖任何具体宿主。

---

## 11. 实施顺序与依赖

```text
立即（并行）:  D1（版本升级）→ D2（契约开放）→ D4（清单发布）
第一批:        T-A（驱动+发布面）            ← 解锁 BreachWeave 进程内嵌入（对应其 R2 ①）
第二批（并行）: T-B / T-C / T-E              ← 小改，各自独立 openspec 变更
随 T-A:        T-D L0（进程内订阅）
第三批:        T-D L1（RPC 通知帧）、T-H（策略门）
Track3③ 前:    T-G（review harness）
可选件:        T-F（多 principal 网关，远程/多进程形态需要时）
```

依赖关系：T-D L1 依赖 T-D L0 的信号基础设施；T-G 依赖 D1（若复核 LLM 经 Pi 接入则需新版本认证，纯 CLI HTTP provider 则无依赖）；其余互相独立。

---

## 12. openspec 变更清单

| 变更名（建议） | 范围 |
|---|---|
| `2026-10-22-add-portable-authority-drivers` | T-A：驱动导出、exports map、bun-sqlite 驱动包、驱动指南 |
| `2026-10-22-add-workitem-resource-refs` | T-B：schema + 引用校验 + `work.query` |
| `2026-10-22-expose-coverage-dispatch` | T-C：`coverage.gate` / `coverage.query` |
| `2026-10-22-add-host-subscription-signals` | T-D：L0 API + L1 通知帧 |
| `2026-10-22-add-artifact-file-ingestion` | T-E：`artifact.ingest_file` |
| `2026-10-22-add-derived-evidence-origin-gate` | T-H：策略字段 + evidence 门扩展 |
| `2026-10-22-add-multi-principal-gateway` | T-F：resolvePrincipal + `taric gateway` |
| `2026-10-22-add-review-harness` | T-G：`taric review` |
| `2026-10-22-bump-pi-host-1-4-0` | D1 |
| `2026-10-22-open-host-contract-versions` | D2：版本门认证集合 + 未认证降级（宿主 ID 开放已落地，无需变更） |

---

## 13. 验收与回归

1. 每项变更：`npm test`（schema/Core/CLI/MCP/adapter/projection/artifact-scale）全绿 + `audit.doctor` 无漂移。
2. T-A：Bun 侧 12 场景 conformance 报告 + 驱动层专项测试结果存档（沿用 `scripts/benchmark-*.mjs` 惯例新增脚本，如 `scripts/benchmark-bun-driver.mjs`）。
3. T-D：节流/重鉴权/补齐三性质各有专项测试（§5.4）。
4. T-H：启用/未启用双态回归 + `policyDigest` 审计断言。
5. 联合验收（BreachWeave 作为首个消费者，按其方案 §8 的验收表执行；Taric 侧不引入 BreachWeave 依赖）。

---

## 14. 风险与回退

| 风险 | 缓解 | 回退 |
|---|---|---|
| `bun:sqlite` 与 node:sqlite 行为差异 | 12 场景 + 专项差异测试；驱动内补正 | BreachWeave 回退 Node 桥（v3 拓扑 B 保持受支持） |
| 包发布面扩大带来的支持负担 | exports map 最小化；驱动套件作为公开验收契约，第三方驱动"过套件即声明" | 收缩回 private + 桥接模式 |
| T-D 信号层演变为消息总线 | 硬约束写进 spec（无内容、可退化轮询、不进审计正文）；不做持久队列 | 移除 L1 帧，仅保留 L0 API |
| T-B 引入"资源锁"误读 | spec 显式声明"提示性元数据，不构成目标资源锁"（§7.3 承诺不变） | — |
| T-H 默认行为漂移 | 默认关闭；启用才改行为且 policyDigest 进审计 | 字段移除即回基线 |
| D2 版本门放宽引入未认证风险 | 降级≠清零：未认证版本仅获安全子集 + 显式 `not_certified` 标记，审计可见 | 恢复严格相等 |

---

**与 BreachWeave 的边界重申**：本方案全部条目不含任何 BreachWeave 专有概念；BreachWeave 侧的改造（场景迁移、上下文组装、容器身份、UI 数据源等）见其仓库 `docs/Taric外置记忆集成差距分析与建议方案.md`（v4），两仓仅通过本文件的公开契约与 D4 版本清单耦合。
