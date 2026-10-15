# Taric 代码设计文档

## 目录

1. [概述](#1-概述)
2. [技术栈](#2-技术栈)
3. [仓库与代码结构](#3-仓库与代码结构)
4. [核心设计决策](#4-核心设计决策)
5. [Artifact 原文存储（任务会话 spool）](#5-artifact-原文存储任务会话-spool)
6. [数据模型](#6-数据模型)
7. [API 表面](#7-api-表面)
8. [配置与环境变量](#8-配置与环境变量)
9. [外部依赖](#9-外部依赖)
10. [业务规则与约束](#10-业务规则与约束代码强制的不变量)
11. [非功能特性](#11-非功能特性)
12. [测试策略与发布门槛](#12-测试策略与发布门槛)
13. [已知差距与假设](#13-已知差距与假设)
14. [附录](#14-附录)

## 1. 概述

### 1.1 定位

Taric 是一个面向多智能体渗透测试的**长期记忆与协作扩展**。它为多个独立上下文的 agent 提供共享的、版本化的 Engagement 权威记忆：攻击面状态、证据关联、覆盖率、提案治理、任务租约、checkpoint、审计恢复、Context Pack、可重建投影，以及（在宿主显式授权时）渗透测试 Artifact 原始字节的 opaque 任务会话存储。CLI、MCP server 与宿主 adapter（Pi、Hermes、DeepSeek Harness）共享同一套由 `@taric/schemas` 派生的 API 合同。

Taric 自身不运行模型、不启动 agent、不执行目标系统操作、不发放高风险动作授权、不管理凭据生命周期。这些始终属于上层宿主应用。Taric 的价值在于把渗透测试长周期协作中最容易丢失和被污染的部分——事实、证据、状态、恢复点与原始数据——放入一个确定性的、可审计的、零模型直写的权威层，同时让模型上下文永远只看到最小投影。

传统智能体所面临的“由记忆丢失/状态错乱/模型直写”导致的幻觉/误报/漏报/任务执行偏差等风险，Taric作为面向多智能体渗透测试的长期记忆与协作机制系统性消除或转化为“可观测、可拦截、可恢复”的状态问题。

### 1.2 关键能力

从用户（宿主应用 / operator / agent）视角，系统能做：

- 创建并维护版本化的 Engagement 记忆，跨 agent、跨 session 共享；PTES 阶段是分类/索引维度而非强制线性流程。
- 以 Proposal → Review → Admission 的治理流水线写入权威记忆，模型只能提交提案；硬门与独立性要求由非 LLM 策略引擎重算。
- 按 L0（待审提案）/ L1（机审候选）/ L2（独立验证）分级信任组织记忆，L0/L1 默认不进入普通事实召回。
- 记录 Evidence 引用与覆盖状态：覆盖按资源版本 × 测试类别 × 身份 × 操作 × 条件独立成格，阴性结果有界、可审计，边缘拦截不关闭源站覆盖。
- 维护资源修订、类型化关系、有界 PatchSet 合并、依赖影响传播与防护控制适用性——历史观察永不改写，当前理解持续演进。
- 管理 WorkRun / Attempt / Checkpoint / ActionIntent：租约、generation fencing、心跳、中断恢复、迟到结果隔离、外部动作对账。
- 按预算生成字段白名单化的 Context Pack：钉住 read_seq、HMAC cursor、resume delta、草稿封存与 rebase。
- 在显式授权的任务会话 spool 中保存 opaque 的 Artifact 原始字节（HTTP 交换、截图、日志、抓包、扫描器输出、上传/下载文件等，可含凭据/Token/Cookie 物料），分块可恢复上传、按引用有界读取。
- 导出/导入 JSON/JSONL 快照，运行 doctor/reconcile 诊断并修复派生层。
- 生成带 manifest 哈希的 Markdown 投影与本地 Git checkpoint；默认本地、远端需显式防护。
- MCP 暴露 6 个受限模型工具；统一注册表登记 50 个 operation，CLI 清单有 45 个标准命令并可转发注册表中的受权操作。

### 1.3 架构风格

**分层单仓 monorepo + 单写者权威存储 + 有启用门的多主机后端**。领域 schema 与操作注册表是契约源；Core 在 SQLite WAL 或 PostgreSQL authority 上执行同一套异步治理逻辑。PostgreSQL 和共享 Core 场景已实现；对应 `storage.postgresql` capability 为 available/verified，但默认运行态 disabled，只有显式 multi-host profile 配合当前构建 digest 匹配的 conformance report 及健康 lease 才可启用。CLI/MCP/adapter 通过同一 Core service；Markdown、Git、Context Pack、快照与 Artifact 目录是可校验的派生数据。

```text
schemas (契约唯一源: JSON Schema + 操作注册表)
   │
core  (AuthorityStore + CoreService + 治理/上下文/覆盖/Artifact spool/投影/适配器)
   │
┌──┴──────┬─────────┬────────────────┬───────────────┐
cli       mcp       pi-adapter       hermes-plugin   deepseek-adapter
(JSON IO) (stdio,   (生命周期 hooks)  (Python, 认证   (session 事件)
           6 工具)                    Core RPC)
```

## 2. 技术栈

| 层 | 技术 | 版本/约束 |
|---|---|---|
| 语言 | TypeScript（ESM, strict） | target ES2022, TS 5.9 |
| 运行时 | Node.js | ≥22（`node:sqlite` 实验性警告已知） |
| 存储 | SQLite（WAL，`node:sqlite` DatabaseSync） | 单机权威 profile |
| Shared authority | PostgreSQL（14–18，版本化 `authority-sql/2` schema） | Async Core store、transaction-scoped governance 与 server lease；有 digest-bound activation gate |
| Schema | JSON Schema draft 2020-12（Ajv 8 + ajv-formats） | v1，严格模式（缺失/额外/非法枚举一律拒绝） |
| 测试 | `node:test` + `node:assert/strict`；Hermes 用 `unittest` | npm workspaces 逐包执行 |
| 构建 | `tsc`（无 bundler） | npm 11 workspaces |
| 部署 | 本地插件/进程（CLI、MCP stdio、宿主插件） | 无服务端部署依赖 |

单机 Core 校验依赖 `ajv`、`ajv-formats`，其余使用 Node 内置模块。显式 PostgreSQL profile 通过 workspace 的 `pg` 驱动连接；默认 single-host SQLite 不连接 PostgreSQL。`reference/`（kb、link、PTES、pentest-skills，按 commit/digest 冻结）是设计输入，不是运行时依赖。

## 3. 仓库与代码结构

```text
packages/
  schemas/            契约唯一源
    schemas/v1/core.schema.json   26 类领域合同 + Artifact/上传/会话合同 + API envelope
    src/registry.ts               50 个 operation + 4 个 deferred + 8 个永久非目标
    src/types.ts                  schema 的手工等价 TS 投影（测试断言一致性）
  core/               权威存储与全部领域逻辑
    store.ts                      AuthorityStore：事务、CAS、审计链、租约、outbox、
                                  快照、Artifact 目录/分块/上传/发布标记/执行目录表
    service.ts                    CoreService：dispatch、principal 授权、操作校验、
                                  checkpoint 敏感推理字段剥离
    validation.ts                 Ajv 编译缓存 + 引用完整性校验
    policy.ts                     非 LLM admission 策略与五个硬门
    context.ts                    Context Pack（白名单、预算、HMAC cursor、resume）
    coverage.ts                   防护控制 / 访问决策观察
    artifact-content-store.ts     任务会话 Artifact spool（§5）
    projection.ts                 Markdown 投影 + Git checkpoint + 远端回调门
    sql-driver.ts / sql-schema.ts SQLite/PostgreSQL SQL driver、迁移与事务
    postgres.ts                   PostgreSQL manifest、readiness、runtime gate
    compatibility.ts              能力/非目标/安全不变量清单（代码常量）
    adapter.ts / pi-adapter.ts / deepseek-adapter.ts / adapter-rpc.ts
    deployment-guard.ts / shared-authority-*.ts / quality.ts / release-report.ts
  cli/                `taric` 二进制：JSON in/out、配置发现、adapter 管理、
                     Artifact 命令 + --include-content
  mcp/                `taric-mcp` stdio JSON-RPC server，仅 6 个模型工具，
                     tools/list 不含任何 Artifact 原文操作
  hermes-plugin/      Python 插件：认证 Core RPC，不替换 MemoryProvider
docs/                设计与 API 文档（本文档所在）
scripts/             schema 检查、dist 清理
```

## 4. 核心设计决策

### 4.1 权威层：单写者事务、钉住快照与部署防护

`AuthorityStore` 是唯一的 canonical 写入点。所有写入发生在 `BEGIN IMMEDIATE`（或嵌套 SAVEPOINT）短事务内，同一事务原子提交：记录版本、`record_versions` 历史、哈希链审计事件、幂等结果、outbox 和 operation marker。失败事务不暴露部分成功。核心机制：

- **CAS（乐观并发）**：Proposal 更新通过独立 `target_id`/`subject_ref` 与 `expected_version` 指定目标；两个 writer 竞争同一版本时至多一个提交，另一个得到结构化版本冲突，不会覆盖。新建 canonical ID 由 Core 在提交事务内分配 UUIDv7。
- **幂等键**：按 principal + engagement + operation + 规范化 payload hash 去重；不同 payload 同键返回 `idempotency_conflict`；已确认的幂等操作在宿主 retry/reload 时不会重复确认。
- **哈希链审计**：`events` 表每条事件带 `prev_hash`/`hash` 与归属元数据（actor/host/worker/dispatch、WorkRun/Attempt、proposal/review、policy digest、input/evidence hash、changed fields、before/after hash）；`verifyAudit` 整链校验；事件永不包含 Artifact 内容或凭据物料；Taric 不托管审计签名密钥。
- **outbox + operation markers**：每个写操作留下 pending/applied/indexed/failed/recovered 标记，与权威提交原子建立；`doctor()` 检查未完成操作、账本连续性、record/counter/idempotency/outbox 水位与 store 权限；权威漂移**阻塞写入**并给出修复建议，不静默覆盖；`reconcileDerived()` 幂等修复 projection/outbox，保留权威历史。
- **display ID**：安装级单调别名（`display_sequence`），跨 Engagement、跨实体类型唯一且不回退；只在创建逻辑实体时分配，更新保持原 alias；调用者不可指定或重用。
- **钉住快照与 read-your-writes**：`snapshot()` 在只读事务内固定 authority sequence，返回内容严格对应所报 `read_seq`；continuation cursor 绑定 principal/Engagement/filter/read_seq，不得跨 Engagement、换过滤条件或换序列复用；写入后查询要么返回权威一致结果，要么给出明确 pending 与派生层低水位。
- **部署防护**：`deployment-guard.ts` 检测并拒绝伪多主机部署（共享 SQLite 文件、NFS 锁、共享 Git clone、独立副本冒充同一 authority）；多主机必须显式 PostgreSQL profile，服务不可用时返回稳定 `unavailable_host`，不静默降级；Git/Markdown 投影永远是派生视图，不提供 authority 锁或事件排序。

`sql-driver.ts` owns SQLite/PostgreSQL connection queues, transaction scopes and dialect expressions; `AuthorityStore` keeps proposal/review/L1/L2/checkpoint/action/Artifact and audit governance shared across both. `storage-contract.ts` defines the async backend and twelve executable Core scenarios; `shared-runtime.ts` plus `runtime-service.ts` refuse missing methods, stale/mismatched evidence, schema gaps, or unhealthy fencing before construction and before dispatch. There is no SQLite fallback.

### 4.2 分级信任与提案治理

模型写入被设计为**只有提案**。三层信任有明确语义边界：L0 `proposal`（只在审核/提交者可见的隔离区）、L1 `machine_approved`（仅显式 candidate 查询中作为带 provenance/证据状态/limitations 的待验证线索）、L2 `independently_verified`（可按 Finding/覆盖规则进入普通召回）。

```text
L0 Proposal (pending) ──admission.evaluate──▶ L1 机审候选 (admitted) ──admission.promote_l2──▶ L2 独立验证记录
        │                              │
        └── rejected / needs_evidence  └── 普通 query/context/projection 均不返回
```

`admission.evaluate` 只执行结构、引用、归属、provenance 和版本检查，返回 `trust_phase=machine_approved`、策略版本和剩余 L2 条件；没有运行 evidence、freshness 或 independence 硬门。独立的 `admission.promote_l2` 仅供 writer/operator 调用，固定 proposal hash、evidence snapshot hash、canonical 版本和 review refs，再由 `policy.ts` 重算 **schema、scope、evidence、freshness、independence** 五个 L2 硬门。模型裁决、payload 中的 `accept: true`、自报的 `trust_level`/`verified` 字段或 host action mode 均无法改变结果。风险分层决定独立复核要求：

| 风险级 | 最少独立复核 | 强独立性 | 证据最大年龄 |
|---|---|---|---|
| informational / low / medium | 1 | 否 | 无 / 180d / 90d |
| high / critical | 2 | 是 | 30d / 14d |

独立性约束包括：reviewer 身份来自 transport 验证的 principal 而非请求体；与 proposal 作者或验证 worker 排除；评审固定 proposal/evidence input hash、reviewer 模型/提示/规则栈版本与 policy digest；reviewer 上下文包含 claim、证据、反证、limitations 与评分标准，但**不得读取先前 reviewer 的结论正文**；高风险要求异构 reviewer（不同模型/提示/规则栈或人工）——同模型同提示的一致意见不算独立，也不能当 L2 事实。证据快照按 id+version 钉住；缺失、跨 Engagement 或已召回的证据使 admission 结构化 fail closed，并保留可审计原因。

### 4.3 身份与授权模型

`Principal`（role: `model | host | reviewer | writer | operator`）只能由 transport 通过 `createPrincipal`/`registerTransportPrincipal` 创建——内部 `WeakSet` 标记，请求 body 自带 `transport_verified: true` 无法伪造。每次 `dispatch` 执行四步：principal 校验 → 操作在注册表且角色允许 → 所需 capability（read/propose/review/admit/work/checkpoint/action/audit/operator/content/content_read）已授予 → Engagement 归属一致。

模型角色默认只有 `read` + `propose`；host 专属操作（work.claim/renew/reclaim、checkpoint.commit、action.host-decision/host-result/reconcile、error.report）与全部 Artifact 原文操作不能由模型调用；Artifact 原文读取还需单独的 `content_read` capability（host 默认持有，operator 仅显式授予）。拒绝时不披露受保护记录、文件或路径的存在性。

### 4.4 Context Pack：最小投影、cursor 与草稿封存

`context.ts` 用两层显式白名单（`modelFields` + 引用字段补充）过滤模型可见字段——新增权威字段默认不可见。信息优先级强制为：Scope/ROE → WorkItem（目标/验收/风险预算）→ 最近 checkpoint → 相关增量 → 冲突/过期/覆盖缺口 → 直接实体与证据位置 → 背景摘要。预算单位是序列化字符数（非模型 token），最低 256；强制信息放不下时返回结构化 `minimum_budget_required` 或 continuation 并标出未检视范围，不静默丢弃。

- **cursor**：authority/content root 下的版本化 0600 key，绑定 principal、Engagement、filters、ordering、read_seq、read_time 与预算。加密 payload 仅含固定快照/过滤、偏移与 delivered IDs，不含完整 records；续页从固定历史版本重取，跨进程/重启可验证。缺失、权限错误或轮换使旧 cursor 返回 `invalid_cursor`。首屏与续页的重取/排序成本分别测量。
- **resume delta**：从 checkpoint 的 read_seq 到当前，返回 added/updated/removed、scope/依赖变化、pending actions、上下文 manifest；前提失效时返回 blocked / replan_required。
- **草稿封存与显式 rebase**：未提交草稿、迟到结果和旧 Attempt 提案保留原始 Attempt/generation 归属并被封存；新 Attempt 必须显式 rebase 或新建提案才能引用；过期租约、旧 generation、跨 Engagement 草稿不得修改当前权威。

### 4.5 协作状态：WorkRun / Attempt / Checkpoint / ActionIntent

宿主拥有执行（创建、调度、取消 worker 均在宿主），Taric 保存可恢复的协作状态：

- **WorkRun/Attempt**：`queued → claimed/running → checkpointed → completed/failed/cancelled/blocked/lost`；带 owner（host+agent）、generation、租约、心跳、read_seq、task session 引用。claim 原子分配 owner、推进 fencing generation、创建 Attempt、绑定会话；reclaim 标记旧 Attempt `lost` 并封存其未决 sidecar；renew 更新心跳不改 generation。
- **Checkpoint**：模型只能 `checkpoint.propose`（L0 候选，不更新有效 checkpoint、不续租、不改 WorkRun 状态）；host 必须重新读取候选、校验当前租约/引用/工具结果后 `checkpoint.commit`——模型的完成声明不能替代 host attestation。checkpoint 契约含 scope/task 目标版本、read_seq、context manifest hash、完成/待办步骤、观察/证据引用、有界阴性结果、未决假设、宿主决定引用、外部动作状态、预算、草稿/handoff 引用、Artifact 内容/执行引用；**空列表必须显式**；不接受隐藏模型推理（`checkpointReasoningFields`：reasoning/hidden_reasoning/chain_of_thought/thoughts/internal_reasoning/private_reasoning 一律剥离）。
- **ActionIntent**：三种宿主选择模式（`llm_recommend` / `authorized_autonomous` / `host_hitl`）下记录建议、宿主决定与结果。`recommend → authorized|denied`；`authorized → executed|failed|unknown`；`denied` 不能进入执行状态；`unknown` 只能经宿主 reconcile + 结果引用进入 resolved，不能自动重放；稳定动作幂等键防止重复转移。所有决策/结果写入与审计事件原子提交；Taric 不从 LLM 建议推断授权，不设置全局默认模式。

### 4.6 记忆演化：修订、关系、影响与防护控制

- **双表示**：逻辑 `Resource` 保持稳定 UUIDv7 身份；method/path/parameter/content-type/principal/tenant 变体、内容哈希、来源观察、有效期与替代关系用不可变 `ResourceRevision` 表示。类型化 `Relation`（calls/reads/writes/protects/authenticates…）、`TestHypothesis`、`AttackPath` 带版本、来源观察、适用时间与依赖关键度。历史 Observation、Checkpoint、宿主决定永不改写。
- **有界 PatchSet**：绑定 base generation、逐对象 base version、read_set、write_set；非重叠字段与关系添加确定性合并；删除、scope/状态、互斥关系与事实字段变更必须显式 CAS 或进入冲突队列——冲突记录保留双候选值、来源证据、base/diff、合并状态，绝不 last-write-wins。
- **有界影响传播**：沿显式 depends_on/derived_from 与字段/关键度依赖传播 `ImpactEvent`，按批次、continuation 和 pending watermark 有界执行；可将 claim/hypothesis/WorkItem/coverage/checkpoint 适用性/Context/Finding/AttackPath 标记 stale 或待重验，历史观察不变；返回重验 WorkItem 建议，不调度宿主。
- **防护控制语义**：`ControlObservation` 与 `AccessDecisionObservation` 分离，绑定控制修订（或 unknown）、策略快照、资源修订、认证/会话修订、操作、网络条件、证据与限制。**未知层不得归因到具体控制或源站**；`origin_reached=true` 必须有证据；边缘拦截 + 源站未达只关闭 `blocked_by_control` 格，**不关闭 origin 覆盖**。控制变更追加 applicability event，不重写历史观察。
- **召回守卫**：`review_after`/`expires_at`/`supersede`/`retract`/`archive`/依赖 stale 状态驱动生命周期；当前普通召回排除 retracted/superseded/archived/过期项并展示适用性、来源与限制；授权 as-of 查询仍可读历史版本与事件；未完成 impact/重验、冲突证据与外部结果在 report/context 中可见。

### 4.7 派生投影与恢复

Markdown 投影（Brief/Index）由 `projection.ts` 从固定 authority 快照生成不可变 generation：manifest 记录每个文件哈希、schema/policy digest、实体清单与 authority 序列，自身再被哈希；发布原子切换 current 指针并保留读者固定的旧 generation——切换期间读者看到完整旧代或新代，绝不半成品。字段白名单排除原始 Artifact、SecretRef、token、私有路径、未审提案、敏感草稿、L0 与未显式请求的 L1。**本地 Git checkpoint 默认启用**，绑定 manifest 与 authority 序列；失败标记 pending/failed 可重试，不回滚 authority。远端 push 需每 Engagement 显式配置私有仓库、访问控制、保留策略**和真实的 secrets-scan callback**（记录扫描器版本与结果哈希）——任何布尔自报声明不替代扫描结果；缺任一配置即 blocked，不 push。快照导出携带 schema/core 版本、Engagement、source sequence、文件哈希；导入在临时目标完成验证后原子切换，失败不部分修改目标。

## 5. Artifact 原文存储（任务会话 spool）

> 实现位于 `artifact-content-store.ts` + `store.ts` 目录表 + `service.ts` 授权分发。这是对"Taric 从不存储 Artifact 正文"旧合同的**显式破坏性替换**：宿主可继续外置管理，也可显式授权 Taric 在已绑定的任务会话 spool 中保存 opaque 原始字节。

### 5.1 设计动机与总体边界

渗透测试中的 Artifact 是工具/worker 产出的原始证据：完整 HTTP 请求/响应、页面/源码/JSON 响应、截图、日志、抓包、扫描器输出、上传/下载文件、归档，以及**可能包含凭据、Token、Cookie、会话物料或密钥的原始记录**。没有持久原文，Taric 无法可靠重建任务会话、无法对照源字节验证 Finding、无法恢复长任务、也无法让宿主从一个引用产出完整输出。

设计立场（代码与规格一致强制）：

- **两种模式并存**：宿主可只提交 opaque `host_ref` + 元数据（`content_status=external`，Taric 不创建、不抓取、不推断本地 payload）；也可显式授权后按字节保存原文（`storage_mode=taric_stored`）。
- **opaque 不可信数据**：Taric 不解析、不执行、不注入、不解密、不脱敏、不分类、不把敏感值复制进 authority/审计/摘要/模型字段。脱敏版、解码版、缩略图或规范化表示是**新派生 Artifact**（新哈希 + `derived_from` 链）。
- **非凭据保管库**：会话根目录的 ACL/加密卷、凭据生命周期、保留/过期、删除策略全部由宿主/operator 负责；Taric 只提供作用域 capability、完整性、审计元数据与密钥管理之外的边界。
- **双层格式**：Markdown 用于人类可读元数据与执行 sidecar；JSON/NDJSON 用于机器 manifest 与 catalog 段；**payload chunk 保留原生字节**——不转 Markdown、不以 base64 形态存储原文（base64 仅是传输编码），不换行规范化，不解压。截图/抓包/上传下载强制进 Markdown 会改变原文表示、增加约 1/3 传输存储开销并破坏有界字节区间读取，因此被明确否决。
- **模型默认不可见**：MCP `tools/list` 不含任何 Artifact 原文操作；Context/query/projection/snapshot 默认只暴露 opaque 引用、payload 种类/媒体类型、字节长度、精确哈希、采集/存储时间、来源/关联元数据、完整性状态与宿主批准的安全摘要字段；宿主摘要、位置、URL、查询串、header、cookie、token、源工具自由文本一律视为不可信且仅宿主可见。

### 5.2 会话绑定与物理布局

`artifact.session.bind` 用 Engagement + `session_id` + 根目录注册任务会话。绑定规则（`bind()` 实现）：

- 根目录必须在配置内容根（`TARIC_CONTENT_ROOT`）之内：先 `resolve` 前缀检查、创建（0700）后再 `realpathSync` 规范化复核，防止符号链接逃逸。
- 不同会话的根目录**不得互相包含或重叠**；同一 `(engagement, session)` 不得改绑到另一个根（conflict）。
- 后续调用只携带会话标识与 Artifact 引用，全部子路径由服务器派生；进程工作目录、每请求路径或 Artifact 引用内嵌路径都不是合法的根来源。

每个会话的确定性布局（UTC 日期 + 服务器派生 ID 前缀分片）：

```text
<session-root>/
  manifest.json                         # 会话头 + 段水位（保持有界）
  manifest/segments/<NNNNNNNN>.ndjson    # 不可变有界 manifest 段
  artifacts/<yyyy>/<mm>/<dd>/<id-prefix>/<artifact-id>/v<NNNNNN>/
    content.manifest.json               # 机器可读：全量+分块哈希/偏移/长度
    payload-<NNNNNN>.part               # 原生字节 chunk（≤64 MiB）
    metadata.md                         # 人类可读元数据 sidecar
  execution/<yyyy>/<mm>/<dd>/<run-prefix>/<work-run-id>/<attempt-id>/
    checkpoint-<sequence>.md
    result-<result-id>.md
    late-<result-id>.md
    segment-<sequence>.md
  .staging/<upload-id>/                 # 私有上传中 chunk（0700，对外不可见）
```

物理单位是**一个 Artifact 版本**而非类别聚合：`category`/`media_type`/源工具只是 catalog 元数据字段，绝不产生共享追加文件——否则热点类别会形成写锁、巨型文件和过大的损坏半径。日期分片保证运行超过一周的会话不会堆积单个巨大目录；单个 Artifact 通过分块可独立超过 64 MiB。`stored_at`（UTC）控制物理分区，调用者的 `captured_at` 只是可查询元数据，不控制路径。

### 5.3 三段式可恢复上传协议

`artifact.store.begin / append / commit` 在一个 upload ID 下按有界字节 chunk 传输，Core/CLI/adapter 内存中至多持有一个 chunk 加有界哈希开销，绝不要求在内存中物化完整 body：

1. **begin**：声明 `payload_kind`（text|binary|manifest）、`media_type`、可选 charset/content_encoding/transfer_encoding、预期字节数与哈希、类别、会话/WorkRun/Attempt/generation 作用域、幂等键。三种派生关系在此声明：
   - `base_content_ref` → 同一 `artifact_id` 的下一版本（不可变版本链）；
   - `derived_from`/`parent_ref` → 派生 Artifact，环引用被拒绝；
   - `child_refs` → 复合捕获（如请求/响应对、多文件扫描输出、分段抓包的 manifest Artifact），子引用必须同会话、唯一、不含父自身、不成环，且**不拼接子字节**——每个子项保持独立可寻址。
   宿主摘要经敏感模式检查（URL/token/secret/cookie/authorization/bearer 直接拒绝），且哈希有界。external 模式必须有 `host_ref`，直接登记 catalog 行，不建本地 payload。
2. **append**：每次一个有序有界 chunk（≤64 MiB 解码后；base64 传输信封上限 `ceil(64MiB/3)*4` 字符且必须是规范 base64——解码再编码须还原），携带 `ordinal` 与 `chunk_hash`；服务器边写 staging 边哈希，校验后才接受。ordinal 必须连续（`0..chunks.length`）；同 ordinal 重试仅当字节长度与哈希都匹配才幂等，否则 `idempotency_conflict`。
3. **commit**：核对 total_bytes、全量 SHA-256 与分块哈希，然后进入发布序列（见 §5.5）。canonical 哈希与存储字节是**上传的字节**，不是解码文本、解压 body、规范化行尾或传输信封。

未完成的 staging chunk 是私有文件：对 metadata 列表、读取、Evidence 与 session output 全部不可见。

### 5.4 SQLite 目录与索引（独立于原始内容）

authority 新增 catalog 表（见 §6.1）：`artifact_catalog`（opaque content_ref、Engagement/会话、Artifact/版本、payload 种类、类别、媒体类型、charset/编码、宿主摘要引用或有界摘要、存储时间、采集时间、authority 序列、WorkRun/Attempt/generation、敏感性/状态标志、总字节、chunk 数、全量哈希、manifest 段与相对目录）、`artifact_chunks`（ordinal、相对路径、字节偏移、字节数、哈希）、`execution_catalog`（会话、WorkRun、Attempt、generation、序列/时间、sidecar 路径与哈希）。

- 覆盖索引至少支持：会话+存储时间/序列、会话+类别/时间、会话+Artifact/版本、会话+WorkRun/Attempt/序列；`EXPLAIN QUERY PLAN` 测试断言命中索引且列表/摘要查询**不扫描原始 payload 或 sidecar 文件**。
- 直接引用读取所需的 catalog 行与 authority 关联**原子同时可见**；派生索引允许滞后，暴露 `catalog_watermark`/`index_watermark`/`index_status` 供增量重建与 doctor/reconcile。索引重建期间已知引用直读仍可用，**绝不回退为原始数据全量扫描**；摘要过滤只用有界类型化元数据或宿主摘要引用，Taric 不解析任意摘要、不做原文全文索引。
- 会话根 `manifest.json` 只含会话身份、schema 版本、段名与高水位；manifest 条目滚动进不可变 NDJSON 段，不为每个 Artifact 重写根文件。

### 5.5 原子发布、崩溃恢复与完整性

文件是**持久 sidecar 而非第二权威**。commit 的发布序列（`commit()` + authority 协作）：

1. 写发布标记（`.operation.json`，phase=publishing）并登记 `artifact_publications` 标记（含 row/chunks/发布路径）；
2. 临时目录内复制 chunk → 写机器 manifest → 写 `metadata.md` → 追加 manifest NDJSON 段；
3. `renameSync` 原子发布版本目录；
4. 在既有 SQLite 事务中提交 catalog/chunk 行、幂等结果与审计事件（标记 phase=published）；
5. 清理 staging 与操作标记。

成功写入同时暴露已验证 payload 与已提交元数据；中断保留 publication marker。`recoverPublications()` 只有在最终目录已发布，manifest/hash、全部 chunk 长度/哈希及整包哈希一致后才恢复 ready/published marker；不完整或篡改内容保持 pending/quarantine。operator doctor/verify/reconcile/export 报告 pinned sequence 与 watermarks；doctor/preview 不改历史。需要显式 replay/reconcile 才记录恢复审计。

读取时完整性检查（`read()`）：catalog/manifest 一致性 → manifest 哈希 → **目标 chunk** 的哈希、ordinal 与字节长度——不重扫全部 chunk 重算全量哈希；响应区分 `chunk_verified` 与 commit 时验证的全量哈希，显式 doctor/verify 任务才做有界全量 rehash。缺失/被篡改/不可读文件返回结构化 `unavailable_host` 或 `integrity_failed`（行状态同步更新），**不作为可用 Evidence**，不静默重建或删除——保留策略与删除是显式宿主/operator 动作。

### 5.6 有界读取、游标与关联输出

- **`artifact.metadata` / `artifact.content.list`**：list 使用 keyset cursor，绑定 principal、会话、过滤条件、钉住读取序列、catalog watermark 与页大小（硬上限 1000 行），返回有界页 + `next_cursor`；支持类别/媒体类型/WorkRun 过滤，默认仅元数据。
- **`artifact.content.read`**：始终是显式原文操作（需 `content_read` capability）；接受有界字节区间或 chunk cursor，每次响应至多一个有界 chunk（≤64 MiB），携带媒体元数据、全量/分块哈希、`chunk_verified`、`integrity_status`、`max_response_bytes` 与 `next_cursor`（`ordinal:offset` 格式）。审计事件只写引用、区间、哈希与完整性元数据——**绝不写 payload 字节**。
- **`artifact.session.output`**：按确定性关联顺序返回执行记录与匹配的 Artifact 元数据，关联 WorkItem/WorkRun/Attempt/checkpoint/工具结果；默认仅元数据/执行记录，只有授权调用者显式 `include_content=true`（CLI `--include-content`）才返回同样有界可续传的 opaque 字节信封；缺失/损坏内容标记 unavailable 而非中断整个输出。
- **规模契约**：100 GiB 会话聚合是一个索引元数据页序列 + 直接 chunk 读取，而非单次 JSON/Markdown 拼装；没有任何操作接受任意路径或组装无界响应。发布门槛含 100 GiB 合成 fixture、跨七天以上 UTC 分区、O(1) 目标 chunk 读取、keyset 分页、索引查询计划与有界内存断言。
- **拒绝面**：模型客户端、未授权 principal、跨 Engagement 调用者或任意路径请求一律拒绝，且不披露受保护正文、路径或存在性。

### 5.7 执行 sidecar 与协作状态联动

checkpoint、宿主决定/结果、对账与错误持久化会写日期/ID 分片的执行 sidecar，携带 WorkItem、WorkRun、Attempt、generation、checkpoint/result 身份、来源 read_seq 与 manifest 哈希；写入复用既有活跃租约与 generation 检查（`assertFence`：run 作用域写入必须同时提供 WorkRun + Attempt + generation，并在 authority 事务中验证）。reclaim 封存旧 Attempt 的未决 sidecar；迟到数据按原始归属隔离（`late-*.md` + `late_result_quarantine`）。resume 返回会话 manifest 与 Artifact 元数据引用，默认不含原始正文。执行 sidecar 不得复制凭据、token、cookie、原始 HTTP body、抓包字节、隐藏推理或完整工具转录——这些始终是按 ID 引用的 Artifact payload。

### 5.8 边界重申（永久非目标）

无自动脱敏、内容分类、secret 扫描、解密、加密密钥管理、保留/过期策略；无凭据/Token 生命周期管理或注入；无任意文件系统浏览、跨 Engagement 共享、面向模型的原文工具或新 worker 调度器；Markdown 文件自身不构成权威；原始 body 不进普通 authority 快照、Brief、Index、Context Pack 或 MCP 响应。

## 6. 数据模型

### 6.1 SQLite 权威表（store.ts）

| 表 | 用途 |
|---|---|
| `metadata` | schema 版本、序列等安装元数据 |
| `records` / `record_versions` | canonical 记录当前态 + 全版本历史 |
| `proposals` / `reviews` | L0 提案与绑定评审（reviewer 身份、verdict、input_hash） |
| `events` | 哈希链审计事件（commit_seq 单调，归属元数据齐全） |
| `idempotency` | 按 principal/operation/payload-hash 的幂等结果 |
| `outbox` / `operation_markers` | 派生层投递与操作恢复标记 |
| `object_refs` | 引用目标登记（引用完整性校验） |
| `work_runs` / `attempts` / `checkpoints` / `action_intents` | 协作执行状态 |
| `artifact_sessions` | Engagement+session → 内容根绑定（禁重叠/改绑） |
| `artifact_catalog` / `artifact_chunks` | 工件目录与分块（含覆盖索引与水位线） |
| `artifact_uploads` / `artifact_idempotency` / `artifact_publications` | 上传中状态、工件幂等、发布阶段标记 |
| `artifact_catalog_watermarks` | catalog/index 水位线与索引状态 |
| `execution_catalog` | checkpoint/action/result/error 执行条目索引 |

### 6.2 领域合同（v1 schema）

26 类记录合同共享 `RecordBase`（id UUIDv7、engagement_id、schema_version、created_at 等）与 `CoreManagedFields`（trust_level、version、status、provenance 等）。主要分组：

- **Engagement 域**：`Engagement`、`Scope`。
- **攻击面**：`Resource`、`ResourceRevision`、`Relation`（类型化边）。
- **证据与推理**：`Observation`、`Evidence`（`ArtifactReference` 引用而非内嵌正文）、`Claim`、`TestHypothesis`、`AttackPath`、`Finding`、`NegativeObservation`。
- **治理**：`Proposal`、`Review`、`Conflict`、`ImpactEvent`、`PatchSet`。
- **覆盖与防护**：`CoverageCell`、`ProtectiveControl(+Revision)`、`ControlObservation`、`AccessDecisionObservation`、`ControlApplicabilityEvent`。
- **执行协作**：`WorkItem`、`WorkRun`、`Attempt`、`Checkpoint`、`ActionIntent`。
- **Artifact 内容**：`ArtifactReference`（扩展 content/session 元数据：storage_mode、content_status、integrity_status、payload_kind、location、byte_length、chunk_count、derived_from、child_refs 等）、`ArtifactSessionBinding`、`ArtifactStoreBegin/Append/Commit`、`ArtifactContentRead/List`、`ArtifactSessionOutput`。
- **系统**：`AuditEvent`、`ApiSuccess`/`ApiError` envelope。

`Evidence`/WorkRun/Attempt/Checkpoint 合同经 Artifact 变更扩展：引用内容/会话元数据但**不内嵌原始 body**；既有仅元数据记录继续通过校验；快照 fixture 断言无 body 字节。TS 类型是 schema 的手工等价投影，测试断言两边必填字段与枚举一致。

### 6.3 关键状态机

- `RecallStatus`：active/draft/verified/proposed → stale/retracted/superseded/archived/expired；`isRecalled` 同时检查 `recall_excluded`、`expires_at`、`review_after`；授权 as-of 查询仍可读历史。
- `ProposalStatus`：pending → rejected / admitted / needs_evidence。
- `WorkStatus` / `AttemptStatus`：queued/claimed/running/in_progress/checkpointed/blocked/completed/failed/cancelled/lost；终态或活跃租约不得经非法转移被 reclaim。
- `ActionStatus`：recommended → authorized/denied → executed/failed/unknown → late_result_quarantine；denied 无执行态；unknown 仅宿主 reconcile 解决。
- `CoverageStatus`：not_tested → queued/in_progress → tested_no_observation/positive/inconclusive/blocked/blocked_by_control/not_applicable。
- `ArtifactContentStatus`：external / pending(staged) / available / unavailable / integrity_failed / quarantined（+ deleted 状态值）；`IntegrityStatus`：unverified/verified/mismatch/missing。

## 7. API 表面

### 7.1 操作注册表（契约唯一源）

`operationContracts` 登记 50 个 operation，包括 `admission.promote_l2`。每项声明角色、request/response、错误码、幂等、是否写权威、Engagement 作用域及 capability。Core 从注册表授权；CLI 的 45 个标准命令与 MCP 的 6 个模型工具清单单独维护并通过契约测试核对。deferred 与永久非目标分别返回显式状态；归档变更不推导 runtime enabled。

| 分组 | 操作（角色） |
|---|---|
| Engagement | `engagement.init`(operator)、`engagement.status` |
| 能力诊断 | `capability.status`、`adapter.status/install/remove/config` |
| 上下文 | `context.build/query`、`query`、`resource.query`、`evidence.query` |
| 治理 | `proposal.submit/list`、`capture.observation`、`review.submit`(reviewer)、`admission.evaluate/commit`(L1)、`admission.promote_l2`(writer/operator) |
| 防护控制 | `control.observe`、`access.observe`、`control.list` |
| 执行协作 | `work.claim/renew/reclaim/resume`(host)、`checkpoint.propose`、`checkpoint.commit`(host)、`action.recommend`、`action.host-decision/host-result/reconcile`(host)、`error.report`(host) |
| Artifact | `artifact.session.bind`、`artifact.store.begin/append/commit`、`artifact.metadata`、`artifact.content.read`(需 content_read)、`artifact.content.list`、`artifact.session.output` |
| 审计恢复 | `audit.verify/doctor/reconcile`(operator)、`snapshot.export/import`(operator) |
| 记忆演化 | `resource.revise/patch/relation/impact`(host/writer/operator) |

### 7.2 统一响应与错误码

操作返回 `ApiSuccess{ok:true,data}` 或 `ApiErrorEnvelope{ok:false,error{code,message,follow_up?}}`。声明的 Core 错误包括 validation/authorization/schema/capability/idempotency/version/conflict/unavailable，以及 `invalid_cursor` 和 `minimum_budget_required`。transport 保留 code；未知异常统一返回 `internal_error` 与通用 message，不按 free-form exception text 推断。状态变更可带 request-bound 幂等键。

### 7.3 MCP server

stdio JSON-RPC（协议 2024-11-05），只暴露 6 个模型工具：`context.query`、`resource.query`、`evidence.query`、`proposal.submit`、`checkpoint.propose`、`action.recommend`。`tools/list` **不含任何 Artifact 原文、任务会话 sidecar、任意路径或宿主/operator Artifact 操作**；MCP 返回的 Artifact 数据限于 opaque 引用与安全类型化元数据。工具参数严格白名单（缺参/多余参数拒绝）；principal 默认 `mcp-model`；协议响应只写 stdout、诊断写 stderr。

### 7.4 CLI

`taric <operation> [json] [--include-content]`：请求必须是 JSON 对象，成功 stdout、失败 stderr。配置发现 `TARIC_DB` → `~/.taric/authority.sqlite`，启动前运行 authority/deployment 诊断。Artifact 命令（session-bind、store begin/append/commit、metadata、content-read、content-list、session-output）要求授权 host/operator 上下文，接受引用或类型化摘要过滤而非任意路径，大结果必须带页/cursor 或有界区间参数，默认仅元数据、仅显式 `--include-content` 才返回原文且保持有界可续传，出错非零退出。别名与分组子命令覆盖 init/status/propose/query/review/capture 等；adapter 配置存 `~/.taric/adapters.json`（0600），install/remove 只管理 Taric 适配器配置，不改 authority 或 Hermes provider。

### 7.5 宿主适配器

- **Pi 1.1.0**（TypeScript）：经锁定契约测试的 session/context/proposal/checkpoint/action/result/error hooks 可用；缺失的实际宿主 hook 显式报告 unavailable，未测试版本 unsupported。
- **Hermes 0.19.0**（Python general plugin）：`TARIC_CORE_SOCKET`（Unix socket）/`TARIC_CORE_URL` 认证 JSON-RPC（`taric.dispatch`），要求 ≥32 字符 `TARIC_ADAPTER_TOKEN`；**不替换 Hermes MemoryProvider**，不直接打开 authority 数据库；7 个生命周期 hook，Core 不可用显式失败。
- **DeepSeek Harness/Cordis**：仅注册已测试 API 的 session 事件（`session/created`、`session/event`、`session/flush`、`session/disposed`），只报告会话生命周期。
- 共同约束：版本化 adapter contract 绑定宿主版本/commit、Taric 合同版本、实际暴露能力、回退操作、稳定错误与测试证据；未知宿主版本 → `unsupported_capability` + 仅列实际 MCP/CLI 回退；适配器不得暴露 authority store 或数据库句柄；retry/reload/cancellation 不丢失已提交状态。

## 8. 配置与环境变量

| 变量/键 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `TARIC_DB` | 否 | `~/.taric/authority.sqlite`（CLI）；`:memory:`（MCP/库） | SQLite authority 路径 |
| `TARIC_CONTENT_ROOT` | 否 | DB 同目录 `content/`（`:memory:` 时临时目录） | Artifact 内容根；会话根必须位于其内 |
| `TARIC_ENGAGEMENT_ID` | 否 | 无 | principal 绑定的 Engagement |
| `TARIC_PRINCIPAL_ROLE` / `TARIC_PRINCIPAL_ID` | 否 | `operator` / `operator-local`（CLI）、`mcp-model`（MCP） | transport 身份 |
| `TARIC_CONTENT_READ_ENABLED` | 否 | false | CLI 是否授予 `content_read` |
| `TARIC_ADAPTER_CONFIG` | 否 | `~/.taric/adapters.json` | adapter 配置路径 |
| `TARIC_CORE_SOCKET` / `TARIC_CORE_URL` | Hermes 二选一 | 无 | Core RPC 通道 |
| `TARIC_ADAPTER_TOKEN` | Hermes 是 | 无 | ≥32 字符认证 token |
| authority `profile` | 否 | `single_host_sqlite` | 或 `multi_host_authority`（须含 postgresql.connection_string + host_id） |

多主机 profile 混入 SQLite 参数、缺少连接串/host_id，或检测到共享 SQLite/NFS/Git 伪共享部署，均在启动时以 `configuration_invalid`/稳定部署错误拒绝。

## 9. 外部依赖

| 依赖 | 用途 | 失败影响 |
|---|---|---|
| SQLite（node:sqlite） | 权威存储 + Artifact/执行目录 | 进程内同步 API；损坏时 doctor 报告、写入阻塞拒绝 |
| PostgreSQL（可选） | 多主机 authority | 未显式配置不加载；不可用时 `unavailable_host`，不降级伪共享 |
| Ajv | schema 校验 | 构建时打包，无运行时外部调用 |
| 会话文件系统 | Artifact spool / 执行 sidecar | 只在显式绑定会话内使用；丢失/篡改 → 结构化 unavailable/integrity_failed |
| 宿主应用 | agent 调度、工具执行、授权、HITL | Taric 不因此降级为执行器；只记录状态 |
| 宿主回调（投影） | secret scan、远端 push | 缺失/失败 → blocked/pending，不伪造成功 |

无网络服务、无云依赖、无模型 API 调用。

## 10. 业务规则与约束（代码强制的不变量）

1. 模型输入不能提升 trust level、不能获得 writer/content capability；模型工具集与 MCP `tools/list` 是硬编码白名单。
2. 所有 canonical 写入经过 Core service → principal 校验 → schema/状态机/版本检查 → 审计事件，同一事务原子提交。
3. 记录与引用不能跨 Engagement；Artifact 引用、评审证据、task session 同样强制隔离。
4. 幂等键绑定 principal/operation/规范化 payload hash；重试返回原结果，不同 payload 报冲突；宿主 reload 不重复确认。
5. 租约与 generation fencing：过期或被 reclaim 的 attempt 提交按 `stale_version` 拒绝，迟到结果保留原始归属隔离，不覆盖新状态。
6. 投影/上下文字段白名单固定，不能由请求或内容字段扩展；能力/非目标/安全不变量清单只能来自代码常量。
7. Context Pack 只含 Engagement 范围内数据、白名单字段与宿主批准的 Artifact 引用，永不含引用正文或路径。
8. Artifact 存储位置服务器派生、版本不可变、哈希校验；路径逃逸、改绑、会话根重叠、完整性失败一律拒绝；文件是 sidecar 不是第二权威，成功写同时暴露 payload+元数据，失败写两者都不暴露。
9. 覆盖语义有界：阴性观察只在匹配 cell 生效；未知层不归因；边缘拦截不关闭 origin 覆盖；阴性/未测/blocked 在白名单投影与报告中可见。
10. 记忆治理不抹历史：修订、撤回、冲突、影响传播追加审计事件；物化投影可从权威状态重建。
11. 动作授权属于宿主：三种模式不使 Taric 获得目标执行权；denied 无执行态；unknown 仅宿主 reconcile。
12. Taric 不保存凭据/Token、不扫描或脱敏宿主数据、不发目标请求、不授权高风险动作、不管理保留期限（永久非目标，无 follow-up）。

## 11. 非功能特性

### 11.1 性能与规模

- 同步 SQLite API：单进程内无跨进程序列化开销，但长操作阻塞调用进程（已知限制）。
- 钉住快照读 + 稳定排序 + 绑定 cursor；patch→查询可见性 P95 预算 2s（发布门槛）。
- Context 预算按序列化字符估算；cursor 分页避免一次性大包。
- Artifact 大对象：64 MiB 分块上传/读取、内存中至多一个 chunk、覆盖索引 + keyset 分页、O(1) 已知引用直读、100 GiB 会话聚合按页/游标增量消费、跨周 UTC 分片。

### 11.2 安全

- 身份：transport-verified principal（WeakSet），请求不可自证；授权 = 角色 × capability × Engagement（× 会话/引用作用域）。
- 内容最小化：Context/投影/snapshot 白名单 + 敏感字段过滤（token/secret/credential/password/cookie/authorization/bearer/body/packet/hidden_reasoning/private_key 等模式）。
- Artifact：0600/0700 权限、staging 私有、原子发布、realpath 前缀双重校验、manifest+chunk 哈希、HMAC cursor、读取审计不含字节。
- 凭据：Taric 不存不传；远端 push 与 secret scan 只经宿主回调且需真实结果证据。
- 拒绝信息最小：未授权读取不披露受保护正文、路径或存在性。

### 11.3 错误处理

统一 envelope + 9 个稳定错误码；`ContractValidationError` 结构化映射；证据缺失 fail closed；模型审核不可用时保持 proposal-only，不 fail open；Core 不可用对 adapter 是显式异常；doctor/reconcile 输出权威层与派生层差异及修复动作。

## 12. 测试策略与发布门槛

| 类型 | 框架 | 覆盖模式 |
|---|---|---|
| 单元/契约 | node:test | schema↔类型一致性、操作注册表、错误码、principal 伪造拒绝 |
| 集成 | node:test | Core API 边界、governance、CAS/审计、上下文/覆盖、演化、恢复、投影、Artifact、多主机配置 |
| 并发/故障注入 | node:test | atomic-failures、stale、doctor-replay、poison-fixtures、runtime-gaps、artifact-scale |
| Transport | node:test | CLI bin/命令（含 Artifact 命令）、MCP server/stdio、adapter RPC |
| 宿主插件 | Python unittest | Hermes 生命周期与 RPC 失败路径 |

Core 包 38+ 测试文件。Artifact 专项覆盖：二进制往返、external 引用、传输哈希、重复 ordinal、幂等冲突、stale fencing、重启 catalog 重载、符号链接逃逸、篡改、缺失文件、执行元数据、CLI/adapter 授权、投影/快照投毒、索引分页、有界规模输出。Phase 1 发布门槛（release-report 固化）：单 Engagement 100 worker 并发写入无重复/回退 display ID；每个成功 commit 唯一审计事件；未授权 L1→L2 升级为 0；高危 Finding 缺证据或独立 reviewer 不得进 L2；所有可恢复 WorkRun 有 checkpoint/租约/owner/context manifest/action state；未测与 blocked coverage 在白名单投影可见；Pi/MCP/CLI contract 测试通过；proposal/CAS→查询 p95 ≤2s；模型审核不可用保持 proposal-only。

## 13. 已知差距与假设

- PostgreSQL 原语 available、完整 runtime disabled；运行时 conformance 和 live health/fencing 通过前不启用。质量统计函数 available，但人工 baseline 的独立标注 provenance 与足够分层样本 pending。
- manifest 段物理滚动有意收敛于当前根 manifest 合同（实现报告注明）；未来变更可增加物理段滚动而不改 opaque 引用 API。
- 100 GiB 验证使用合成元数据 fixture，不在单进程响应中物化 100 GiB。
- Pi 原生 proposal/checkpoint/action/result hooks 未完成，经注册工具走受限操作；DeepSeek/Hermes 能力以 compatibility manifest 声明为准。
- Context 预算是字符估算而非模型 token 计数；同步 SQLite API 阻塞长操作；无后台 worker。
- 注册表 deferred 能力（migration、backup.restore、remote.push、full_quality_evaluation）部分已有底层实现，公开契约未放开。
- 跨适配器测试验证共享 Core 行为，不等价于真实宿主端到端兼容认证；生产接入需受认证 writer service。

## 14. 附录

### A. 模块依赖图

```text
@taric/schemas ◀── @taric/core ◀── @taric/cli
                      ▲      ▲
                      │      └── @taric/mcp
                      └── (JSON-RPC) hermes-plugin (Python, 独立包)

core 内部:
  store ── policy / validation / context / coverage
        └─ artifact-content-store (经 ArtifactCatalogAuthority 协作)
        └─ projection
    ▲
  service ── compatibility / deployment-guard / shared-authority-config
    ▲
  adapter / pi-adapter / deepseek-adapter / adapter-rpc
```

### B. 环境搭建

```bash
npm ci            # Node ≥22, npm 11
npm run typecheck
npm run build
npm test
cd packages/hermes-plugin && python3 -m unittest discover -s tests   # 可选
```

快速体验（`:memory:`）：

```ts
import { createCoreServiceForPath, createPrincipal, uuidv7 } from "@taric/core";
const engagementId = uuidv7();
const service = createCoreServiceForPath(":memory:");
service.init({ id: engagementId, name: "example engagement" });
```

模型客户端不应直接调用 `AuthorityStore.commit`；生产接入使用 `createCoreService` + 受认证 transport principal，或 CLI/MCP/adapter 契约。

### C. 专有名词注释

#### C.1 领域与记忆模型

| 术语 | 注释 |
|---|---|
| Engagement | 一次有明确范围、规则与交付边界的授权渗透测试；Taric 记忆、权限与数据隔离的基本单位。 |
| Scope / ROE | 测试范围与交战规则（Rules of Engagement）：允许/禁止目标、测试窗口、方法限制与授权引用。 |
| Resource | 攻击面中的逻辑资源（主机、域名、服务、应用、端点、路由等），持有稳定 UUIDv7 身份。 |
| ResourceRevision | 资源的不可变修订：记录同一逻辑资源在某时刻的内容哈希、变体（方法/路径/参数/主体/租户）与来源观察。 |
| Observation | 由工具或 worker 在指定时间、身份与条件下记录的观察；历史观察永不改写。 |
| NegativeObservation | 有界阴性观察：在指定方法、基线/控制、条件、身份、时间与限制下未复现某 claim，不声称普遍不存在。 |
| Relation | 实体间的类型化关系边（calls/reads/writes/protects/authenticates 等），带版本、来源观察与依赖关键度。 |
| Evidence | 支撑观察或 Finding 的证据记录；通过 ArtifactReference 引用原始数据，不内嵌正文。 |
| Artifact | 工具/worker 产出的原始数据对象（HTTP 交换、截图、日志、抓包、扫描器输出、文件等），可能含凭据/Token/Cookie 物料。 |
| ArtifactReference / content_ref / host_ref | Artifact 的引用元数据；`content_ref` 是 Taric 任务会话内的 opaque 引用（`<artifact-id>@v<n>`），`host_ref` 是宿主外置存储的 opaque 引用。 |
| Claim | 可由证据支持或反驳的陈述。 |
| TestHypothesis | 待检验的测试假设，关联资源、条件与验收标准。 |
| AttackPath | 由观察/关系/假设组成的多步攻击路径记录。 |
| Finding | 经独立证据审核确认的安全问题（L2）。 |
| CoverageCell | 覆盖矩阵格：资源版本 × 测试类别 × 身份/角色/租户 × 操作/路径/参数 × 条件的独立覆盖状态。 |
| PTES | Penetration Testing Execution Standard，渗透测试执行标准；Taric 用其阶段（情报收集、威胁建模、漏洞分析、利用等）作分类与索引维度，不强制线性流程。 |

#### C.2 治理与信任

| 术语 | 注释 |
|---|---|
| Proposal（L0） | agent 提交的候选变更，不直接改变权威记忆；只在审核/提交者可见的隔离区。 |
| Review / Reviewer | 对提案的评审记录/评审者；reviewer 身份来自 transport 验证，排除作者与验证 worker。 |
| Admission / 硬门 | 非 LLM 的确定性准入；L1 做结构/引用/归属/版本检查，L2 promotion 才重算 schema、scope、evidence、freshness、independence 五个硬门。 |
| L1（machine_approved） | 通过确定性结构准入的机审候选；没有完成独立证据验证，只在显式 candidate 查询中作为带标记的待验证线索。 |
| L2（independently_verified） | 独立验证记录：经固定证据快照、独立 reviewer 与全部硬门后升级，可进入普通召回。 |
| provenance | 数据来源与归属链（谁、以何身份、在何上下文产生），随记录保存并在投影中传播。 |
| 召回（recall） | 普通查询/上下文对记忆的默认可见集合；retracted/superseded/archived/过期/依赖 stale 项被排除。 |
| fail closed | 校验或证据不可用时拒绝并保留可审计原因，而不是放宽放行。 |
| proposal-only | 模型审核不可用或模型提交内容时，系统只接受提案、不发生权威写入的安全回退状态。 |
| 投毒（poisoning） | 通过恶意 proposal、Markdown、工具响应或摘要试图改变策略、信任级、权限或白名单的输入；对应测试套件验证其必然失败。 |

#### C.3 身份与权限

| 术语 | 注释 |
|---|---|
| Principal | 经 transport 创建并验证的调用身份（id + role + engagement 绑定 + capabilities）；请求体无法自证。 |
| Role | 五种角色：model（模型）、host（宿主）、reviewer（评审者）、writer（非 LLM 写入者）、operator（运维/操作者）。 |
| Capability | 角色之上的细粒度授权：read/propose/review/admit/work/checkpoint/action/audit/operator/content/content_read。 |
| transport | 承载调用的入口通道（CLI、MCP stdio、adapter RPC、Python 插件）；principal 只能由它创建。 |
| HITL | Human-in-the-Loop，人在环节中审批；Taric 只记录宿主回传的授权结果，不实现用户身份或审批交互。 |

#### C.4 执行协作

| 术语 | 注释 |
|---|---|
| WorkItem / WorkRun / Attempt | 任务项（做什么）/ 工作运行（宿主启动的一次执行，含租约与 checkpoint）/ 执行尝试（一次具体认领，带 generation）。 |
| lease（租约） | WorkRun 的限时执行权；到期可被其他 host reclaim。 |
| heartbeat | 当前 owner 周期性续租的心跳时间戳；renew 更新心跳不改 generation。 |
| reclaim | 租约过期后重新认领；推进 fencing generation 并将旧 Attempt 标记 lost、封存其未决数据。 |
| generation / fencing | 每次认领/重认领递增的护栏代数；旧代数的写入被拒绝（stale_version），防止过期 owner 覆盖新状态。 |
| Checkpoint | 已提交的安全恢复边界：固定 read_seq、上下文 manifest、完成/待办步骤、观察/证据引用、外部动作状态等。 |
| ActionIntent | 动作意图记录：目标、方法、理由、模式、宿主决定与结果；Taric 只记录，不执行。 |
| 动作三模式 | `llm_recommend`（Taric 给建议，宿主决定）、`authorized_autonomous`（宿主声明已授权并负责执行与复查）、`host_hitl`（宿主向用户请求授权并回传结果）。 |
| late result / quarantine | 旧 Attempt 迟到的结果：保留原始归属后隔离（late_result_quarantine），新 Attempt 须显式 rebase 才能引用。 |
| resume / resume delta | 从 checkpoint 恢复的续跑包 / 两次读取序列之间的增量（新增、更新、删除、scope/依赖变化、待定动作）。 |
| host attestation | 宿主对进度/结果的正式确认；模型的完成声明不能替代，checkpoint.commit 仅接受 host 提交。 |

#### C.5 存储与一致性

| 术语 | 注释 |
|---|---|
| authority（权威层） | 唯一可信状态源；当前为单写者 SQLite WAL（可选 PostgreSQL），所有 canonical 写入必须经它。 |
| canonical record / canonical 写入 | 权威记录 / 进入权威层的正式写入；区别于提案、投影、快照等派生数据。 |
| WAL | Write-Ahead Logging，SQLite 的预写日志模式，支持读写并发与崩溃恢复。 |
| CAS | Compare-And-Swap，乐观并发控制：写入携带期望版本，冲突时至多一方成功。 |
| 幂等键（idempotency key） | 调用方为可重试操作提供的键；同键同 payload 重试返回原结果，不同 payload 返回冲突。 |
| 审计事件 / 哈希链 | 每次状态迁移追加的事件记录；相邻事件用 hash 串联成链，可整链验证完整性。 |
| outbox | 与权威提交同事务建立的待投递工作清单，供派生层（投影等）可靠消费。 |
| operation marker | 每个写操作的 pending/applied/indexed/failed/recovered 状态标记，用于崩溃后诊断与恢复。 |
| doctor / reconcile | 一致性诊断（报告权威层与派生层差异）/ 显式修复（幂等重放或重建派生工作，不改权威历史）。 |
| read_seq / snapshot / as-of | 权威提交序列号 / 固定序列下的一致性读快照 / 按历史序列查询历史版本。 |
| read-your-writes | 写入方随后读取能看到自己已提交变化的保证；派生层滞后时返回明确 pending 与水位线。 |
| display ID | 安装级单调递增的友好别名（如 `R-000042`），跨 Engagement 唯一，创建时分配、更新不变。 |
| UUIDv7 | 时间有序 UUID，作为领域记录主键，兼顾唯一性与大致时间排序。 |
| watermark（水位线） | 已处理进度的标记（catalog/index/projected 等）；用于增量重建与滞后可见性。 |

#### C.6 上下文与投影

| 术语 | 注释 |
|---|---|
| Context Pack | 按固定读取序号与字符预算生成的模型上下文包，只含白名单字段与强制优先级信息。 |
| 字段白名单（allowlist） | 显式列出允许出现在某视图中的字段集合；新字段默认不可见，防止意外泄漏。 |
| cursor / keyset cursor | 分页续读令牌（绑定 principal、Engagement、过滤、序列、水位线与页大小）/ 以排序键定位下一页的分页方式，避免深分页扫描。 |
| HMAC | Hash-based Message Authentication Code，带密钥的签名；用于 cursor 防篡改。 |
| projection / Brief / Index | 权威状态的派生人类可读视图（Markdown）/ 简报 / 索引；永远非权威，可重建。 |
| 投影 generation | 一次投影发布的不可变代目录；发布原子切换指针，读者固定旧代不受影响。 |
| manifest / manifest hash | 机器可读的文件清单（含每文件哈希与 authority 序列）/ 清单自身的摘要，用于完整性校验。 |
| derived view | 从权威状态派生的任何视图（投影、快照、目录、索引）；损坏可重建，不是事实源。 |

#### C.7 Artifact 原文存储

| 术语 | 注释 |
|---|---|
| spool / task session | 缓存式原文存储区 / 任务会话：宿主显式绑定的目录作用域，一个 Engagement+session 对应一个根目录。 |
| opaque（不透明） | Taric 不理解内容语义、不解析不转换；字节按原样存储、按哈希校验。 |
| payload_kind / media_type | 载荷种类（text / binary / manifest）/ 媒体类型（如 `application/octet-stream`），均为元数据。 |
| chunk / ordinal / chunk_hash / content_hash | ≤64 MiB 的原生字节分块 / 分块序号 / 单块 SHA-256 / 全内容 SHA-256。 |
| staging | 上传中的私有暂存目录（`.staging/`）；未提交前对列表、读取、Evidence 与输出不可见。 |
| sidecar（执行侧车） | 与权威元数据并存的人类可读伴生文件（`metadata.md`、checkpoint/result/segment 等），不是第二权威。 |
| storage_mode | `external`（宿主外置，仅有 host_ref）或 `taric_stored`（显式授权后存入任务会话）。 |
| content_status / integrity_status | 内容可用性（external/staged/available/unavailable/integrity_failed/quarantined/deleted）/ 完整性校验结果（unverified/verified/mismatch/missing）。 |
| derived_from / child_refs | 派生 Artifact 的来源链（脱敏版、解码版、缩略图等是新对象新哈希）/ 复合 Artifact 的子引用列表（不成环、不拼接字节）。 |
| base64 传输编码 | 仅用于 JSON/RPC/CLI 通道承载二进制；存储与哈希针对解码后的原始字节。 |
| include_content / `--include-content` | 显式请求原文的开关；默认所有列表/输出仅元数据，且需 `content_read` capability。 |
| chunk_verified | 读取时只校验了目标分块（哈希/序号/长度）的标记；与提交时验证的全量哈希相区分。 |

#### C.8 接口与外部系统

| 术语 | 注释 |
|---|---|
| MCP | Model Context Protocol；Taric 经 stdio JSON-RPC 暴露 6 个受限模型工具的标准协议。 |
| stdio / JSON-RPC | 以标准输入输出为通道 / 以 JSON 编码的远程过程调用格式（MCP 与 adapter RPC 的底层）。 |
| adapter（适配器） | 连接具体宿主框架与 Taric Core 的薄转换层（Pi、Hermes、DeepSeek Harness），不实现第二份存储或策略。 |
| Pi | Pi Coding Agent（`@earendil-works/pi-coding-agent` 1.1.0），当前原生支持的生命周期宿主。 |
| Hermes | Hermes Agent 0.19.0；Taric 以通用 Python 插件经认证 Core RPC 接入，不替换其 MemoryProvider。 |
| MemoryProvider | Hermes 的记忆提供者接口；Taric 刻意不替换它，二者共存。 |
| DeepSeek Harness | DeepSeek Harness/Cordis 宿主；当前仅接入其已测试的 session 生命周期事件。 |
| CLI | `taric` JSON 命令行程序；标准清单 45 项，最终授权来自 50 项 operation 注册表。 |
| API envelope | 统一响应包装：`{ok:true,data}` 或 `{ok:false,error{code,message,follow_up}}`。 |
| p95 | 95 分位延迟；发布门槛要求 proposal/CAS 写入到查询可见 p95 ≤ 2 秒。 |
