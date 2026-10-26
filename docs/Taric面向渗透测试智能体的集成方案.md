# Taric 面向渗透测试智能体的集成方案

## 目录

1. [方案概述](#1-方案概述)
2. [总体架构](#2-总体架构)
3. [Taric 结构性风险防护（核心亮点）](#3-taric-结构性风险防护核心亮点)
4. [身份与接入设计](#4-身份与接入设计)
5. [采用闭环、成本与保证边界](#5-采用闭环成本与保证边界)
6. [核心工作流](#6-核心工作流)
7. [并发执行与冲突控制](#7-并发执行与冲突控制)
8. [Artifact 原文存储集成](#8-artifact-原文存储集成)
9. [上下文供给策略](#9-上下文供给策略)
10. [长周期大量资产任务能力评估（推演）](#10-长周期大量资产任务能力评估推演)
11. [宿主采用与多主机验收路线（五阶段）](#11-宿主采用与多主机验收路线五阶段)
12. [边界与注意事项](#12-边界与注意事项)
13. [端到端示例（浓缩时序）](#13-端到端示例浓缩时序)
14. [BreachWeave 集成案例（真实宿主映射）](#14-breachweave-集成案例真实宿主映射)

> **当前状态（2026-10-26）**：本方案描述 Taric 能力和宿主验收边界；其中 §10 的推演、§11 的五阶段路线和 §14 的 BreachWeave 文件/版本映射，不是当前 Taric 的未完成实现清单。当前 `1.0.0` build、typecheck、compatibility matrix、PostgreSQL 配置下的 `npm test` 与 5 个 tarball clean consumer 通过：Core 351、Schemas 10、CLI 32、MCP 12、Hermes 5、Bun driver 11 均无失败。PostgreSQL 17.11 当前源码 12 个 runtime scenario 和独立逻辑备份/恢复通过；两个 host 容器同机 lease/reclaim、两个容器间 spool mount 写入与读回也通过。报告位于验证机 `/tmp`。Pi 1.4.0 真实 RPC host 已加载 Taric extension（无模型/工具调用）；真实 BreachWeave 和完整第三方宿主工作流、跨物理机网络恢复仍未验收。可选 TLS TCP 与 HTTPS gateway 已实现，并有本机 loopback 端到端测试；生产网络部署、凭据轮换/撤销运维和跨机故障恢复尚未验收。质量统计能力仍因缺少人工标注样本/人类基线而 unsupported/pending。当前合同参见[接入指南](agent-integration.md)、[API 合同](taric-api.md)和[代码设计](taric-design.md)。

## 1. 方案概述

### 1.1 背景与目标

智能渗透测试系统作为 Taric 的宿主应用，采用**规划者 + 执行者 + 观察者**的多智能体协作模式：

- **规划者智能体（Planner）**：仅负责规划，不执行具体任务——产出任务分解、目标资源、验收标准与风险预算。
- **执行者智能体（Executor，可多实例并发）**：根据自身角色与能力认领规划产出的任务，执行并反馈结果；并发数量由宿主的并发资源池决定，只调度相互无冲突的任务。
- **观察者智能体（Observer）**：持续观察规划者与执行者的异常行为，并对异常进行纠偏。

本方案的目标是把 **Taric 用作三类智能体共享的状态黑板**：任务归属、执行状态、观察结果、证据引用、结论沉淀、异常记录与恢复点全部经 Taric 同步与持久化；同时利用 Taric 的任务会话 spool **存储渗透测试过程中的 Artifact 原始数据**（HTTP 交换、截图、日志、抓包、扫描器输出等），支撑大量资产的长周期持续渗透测试。

部署 PostgreSQL 并显式启用多主机模式后，这套黑板可由**分布在不同机器上的多个智能渗透测试宿主应用**共同使用。例如，宿主 A 组织资产发现，宿主 B 组织验证，宿主 C 组织独立复核；它们在同一 Engagement 内共享授权范围、资源版本、覆盖状态、任务和恢复记录。宿主可以使用不同模型与工具，但必须接入同一套 Taric 契约与治理路径。跨机协作通过重新查询、提案治理和任务租约完成，不要求模型之间共享完整会话历史。

### 1.2 部署形态与边界

- **单机模式（默认）**：`single_host_sqlite` profile 使用持久 SQLite WAL authority 与本地 Artifact spool，无 PostgreSQL 依赖，适合一台机器上的宿主与多个 worker。
- **多主机模式（显式启用）**：`multi_host_authority` profile 使用同一个 PostgreSQL authority；各机器运行 Taric Core，并接入各自宿主的模型、工具与本地 spool。共享范围由 Engagement 与 principal 权限共同约束，不自动跨 Engagement 分享。
- **Taric 只做状态与记忆**：不运行模型、不启动/调度 agent、不执行目标系统操作、不发放高风险动作授权、不管理凭据生命周期。agent 调度、工具调用、动作授权、HITL 交互全部由宿主系统负责。
- **零模型直写**：三类智能体（都是 LLM agent）对权威记忆只有"提案权"；权威写入、任务认领、工具执行、Artifact 落盘由宿主运行时以 host/operator 身份完成。观察者的纠偏同样是"提案 + 建议"，由宿主强制执行。

多主机模式已接入与 SQLite 共用的异步 Core 治理实现。仓库保存的[PostgreSQL v2 验证报告](benchmarks/postgres-runtime-v2.json)仍是 pre-1.0.0 历史证据，不能激活当前 `1.0.0` profile。2026-10-26 的独立 current-source live report 在本机 `/tmp/taric-postgres-runtime-20261026.json`，12 个 runtime scenario 和独立逻辑备份/恢复均通过；当前实现、schema、policy 摘要匹配的证据与部署 schema/租约健康检查仍是启用条件，默认 PostgreSQL runtime 保持关闭。两个独立 Node 容器在同一工作站通过 lease 竞争、owner 容器终止、reclaim 与旧 generation fencing 检查；真实跨物理机协作、网络中断恢复与容量仍需按 §11 验收。

## 2. 总体架构

### 2.1 单机模式

```text
┌────────────────────────── 智能渗透测试系统（宿主应用）──────────────────────────┐
│                                                                                │
│  ┌──────────┐   ┌──────────┐ ┌──────────┐ ┌──────────┐      ┌──────────────┐  │
│  │ 规划者    │   │ 执行者 1  │ │ 执行者 2  │ │ 执行者 N  │      │   观察者      │  │
│  │ (Planner)│   │(Executor)│ │(Executor)│ │(Executor)│      │  (Observer)  │  │
│  └────┬─────┘   └────┬─────┘ └────┬─────┘ └────┬─────┘      └──────┬───────┘  │
│       │ MCP 模型工具  │ MCP 模型工具 │            │ MCP 模型工具      │ MCP/Reviewer│
│  ─────┴─────────────┴────┬────────┴─────────────┴──────────────────┴─────     │
│                     宿主运行时（非 LLM，权威执行层）                              │
│       · agent 调度器（并发资源池、无冲突任务分派）                                │
│       · 渗透工具执行器（nmap/nuclei/浏览器/curl…，Taric 外部）                    │
│       · 动作授权与 HITL 策略（含 high-risk 审批）                                 │
│       · 以 host/operator principal 调用 Core 全量操作                            │
└───────────────────────────────────┬────────────────────────────────────────────┘
                                    │ 内嵌 CoreService / CLI / adapter RPC
                            ┌───────▼────────────────────────────┐
                            │        Taric Core（单机）           │
                            │  SQLite WAL authority（权威状态）    │
                            │  Context Pack / 治理 / 覆盖 / 审计  │
                            │  Artifact 任务会话 spool（原文字节） │
                            │  Markdown 投影 + 本地 Git checkpoint│
                            └────────────────────────────────────┘
```

要点：

1. **三类智能体都不直接接触 authority**：经 MCP stdio 只能使用 6 个模型工具（`context.query`、`resource.query`、`evidence.query`、`proposal.submit`、`checkpoint.propose`、`action.recommend`）；观察者额外经宿主适配通道持有 reviewer 身份调用 `review.submit`。
2. **受信任的非 LLM 运行时调用 Core 写入路径**：任务认领、观察捕获、Artifact 上传、checkpoint 提交和动作结果由相应 host 能力完成；L1 admission 与 L2 promotion 使用各自授权的 operator/writer 能力。普通 host 和 reviewer 不能直接晋升 L2。
3. **黑板同步靠 Taric 的钉住快照读**：每个 Context Pack 固定在一个 `read_seq` 上，避免读到半更新状态；不同智能体独立查询时序列可以不同。需要共同基线的工作流必须显式固定受支持的读取序列/快照，最新提交则通过新查询或 resume delta 获取。

### 2.2 PostgreSQL 多主机模式

```mermaid
flowchart TB
    A["机器 A：宿主 A / 资产发现智能体"] --> CA["Taric Core A / 本地 MCP、宿主接口"]
    B["机器 B：宿主 B / 验证智能体"] --> CB["Taric Core B / 本地 MCP、宿主接口"]
    C["机器 C：宿主 C / 规划、观察与独立复核"] --> CC["Taric Core C / 本地 MCP、宿主接口"]
    CA --> PG[("同一个 PostgreSQL authority")]
    CB --> PG
    CC --> PG
    CA --> SA["A 的任务会话 spool"]
    CB --> SB["B 的任务会话 spool"]
    CC --> SC["C 的任务会话 spool"]
```

每台机器的受信任 Core 连接同一个 PostgreSQL authority（同一目标数据库/schema）；模型仅通过受限工具访问。MCP stdio 和 adapter Unix socket 是本机接入通道；可选 TLS TCP/HTTPS gateway 也可将宿主 API 请求转发给 gateway 所在主机的 Core。无论选择何种传输，跨主机正确性仍由各 Core 连接的 PostgreSQL authority 提供；gateway 不参与协调。

| 共享对象 | 多主机效果 | 宿主需要完成的工作 |
|---|---|---|
| Scope、资源/修订、观察、覆盖与结论 | 同一 Engagement 下按权限读取共同状态，减少重复调查 | 刷新 Context Pack、消费增量；遵循 L0/L1/L2 可见性 |
| WorkItem、WorkRun、Attempt | 多宿主竞争同一任务时至多一个有效租约；代次隔离旧执行者写入 | 选择待办、认领/续租、启动 worker、过期后接管 |
| Checkpoint、ActionIntent、恢复记录 | 新宿主可在接管后检查历史进度、未决动作与当前前提 | 校验并重建当前 Attempt 的恢复边界，处理外部动作对账 |
| Proposal、Review、L1/L2 状态 | 可将提交、独立复核和授权晋升分布到不同宿主 | 配置独立身份、固定证据输入和 writer 权限 |
| 版本、审计、幂等、outbox 与水位 | 提交顺序、冲突和派生状态可统一追溯 | 处理冲突/重试、监控滞后、执行备份恢复 |
| Artifact 目录、哈希、证据引用 | 共享证据元数据与归属 | 原文字节的远程访问、文件路由和备份另行落实（§8.4） |

PostgreSQL 统一权威状态和提交顺序，各宿主可并行运行模型与目标工具。当前实现对 authority schema 的写事务使用统一事务锁，并不意味着数据库写入能力随宿主数量线性增长。Taric 也不提供自动 worker 调度、通用宿主消息总线或目标工具执行；这些职责仍属于宿主系统。

## 3. Taric 结构性风险防护（核心亮点）

长周期多智能体渗透测试有四类典型失效：**上下文溢出导致幻觉与偏差、漏报、误报、任务异常终止**。其中一部分来自**记忆丢失、状态错乱、模型直写**。Taric 通过持久权威状态、事务、权限、版本和恢复契约约束这些失效，使冲突与不满足恢复前提的情况可诊断、可阻塞。具体保证以相应接口和部署条件为限；它不保证消除模型误判、存储故障或所有中断损失。

### 3.1 防"记忆丢失"：状态在权威层，不在任何 agent 的会话里

| 机制 | 结构性保证 |
|---|---|
| SQLite / PostgreSQL 权威层 | 持久保存已提交的任务、观察、证据引用、覆盖与结论；PostgreSQL 模式供多个机器共享。故障后以事务、存储健康与恢复校验结果为准，备份和文件耐久性仍需部署保障 |
| 覆盖矩阵（CoverageCell） | "测过什么/没测什么"是**可查询的持久状态**而非模型回忆；`not_tested`/`blocked` 在白名单投影与报告中强制可见（发布门槛） |
| 阴性结果有界保存 | "未复现/被拦截"同样入库并带条件与限制，不会被后续上下文挤出而丢失，也不会被夸大为普遍不存在 |
| Checkpoint + resume delta | 执行者恢复时只取 checkpoint 之后的增量；上下文规模与任务时长**解耦** |
| Artifact 任务会话 spool | 原始证据字节持久保存并全程哈希校验；任何结论随时可对照原始字节复核 |

效果：漏报与偏差中"模型忘了 / 历史装不下"这一根因被消除——记忆问题转化为对权威层的查询问题。

### 3.2 防"状态错乱"：并发与故障下的确定性

| 机制 | 结构性保证 |
|---|---|
| 钉住 read_seq 快照读 | 所有智能体读到的都是某一完整提交序列的状态，绝不混入并发写入的半更新数据 |
| 单写者短事务 + CAS + PatchSet 冲突队列 | 并发写同一实体时至多一方成功；事实字段冲突保留双候选进 Conflict 队列，绝不 last-write-wins 静默覆盖 |
| 租约 + 心跳 + generation fencing | 对绑定 WorkRun 的受保护写入验证当前 owner/租约/代次；旧代写入被拒绝或按接口隔离，保留原始归属。该保证不撤销宿主已执行的外部动作 |
| 前提失效检测 | resume 发现 scope/依赖/授权引用变化时返回 `blocked/replan_required`，拒绝在错误前提上续跑 |
| 哈希链审计 + operation marker + doctor/reconcile | 每次状态迁移可验证；派生层漂移可诊断、可幂等修复；权威漂移**阻塞写入**而非带病运行 |
| authority 原子事务 + 发布标记 + 幂等键 | authority 状态与审计等同事务提交；Artifact 文件与目录发布以标记和校验恢复，不暴露未验证内容；相应状态 API 的合法重试不产生重复转移 |

效果："多执行者互相踩踏"与"崩溃后状态不一致"这一根因被消除——异常终止变成可恢复事件，错乱变成被拦截的冲突或可见的 Conflict 记录。

### 3.3 防"模型直写"：幻觉进不了事实层

| 机制 | 结构性保证 |
|---|---|
| 零模型直写 | planner/executor/observer 全部只有提案权（L0）；admission、权威写入、任务认领、工具执行、Artifact 落盘全部由宿主（非 LLM）完成 |
| 观察走宿主 | `capture.observation` 为 host-only；执行者模型对"观察到了什么"无写入权，幻觉无法变成 Observation |
| 分离 L1 准入与 L2 晋升 | `admission.evaluate` 只做结构、引用、归属、来源和版本检查；`admission.promote_l2` 在固定提案/证据输入上重算 evidence/freshness/independence/risk 等硬门，缺少晋升条件则拒绝 |
| 证据钉版本 | 评审时按 id+version 钉住证据快照；已召回、跨 Engagement、丢失的证据拒收 |
| L1 隔离 + L2 独立复核 | 机审候选默认不进普通召回；高危 Finding 需独立（可异构）reviewer；`accept=true`、自审、同模型同提示一致全部无效（投毒回归测试固化） |
| 字段白名单 + 敏感剥离 | 模型上下文只含白名单字段；checkpoint proposal/commit 递归拒绝 reasoning/chain_of_thought 等隐藏推理字段 |

效果：幻觉型误报的传播半径被封死在 L0/L1 隔离区。幻觉型 Finding 有三条确定性"死法"：无证据引用 → evidence 硬门拒；伪造引用 → 引用完整性校验拒；证据过期 → freshness 硬门拒。

### 3.4 风险转变总览

| 状态层根因 | 传统多智能体的表现 | Taric 结构性对策 | 失效模式的转变 |
|---|---|---|---|
| 记忆丢失 | 长任务后忘测过什么 → 漏报；历史塞进上下文 → 溢出 | 权威层 + 覆盖矩阵 + checkpoint/resume delta + Artifact spool | "忘了" → 可查询的状态；溢出 → fail closed + 增量供给 |
| 状态错乱 | 并发互踩覆盖、崩溃后状态不一致、错误前提续跑 | 快照读 + CAS/fencing + 前提检测 + doctor/reconcile | 错乱 → 被拦截的冲突/可见漂移；终止 → 可恢复事件 |
| 模型直写 | 幻觉写入共享记忆 → 误报扩散、结论污染 | 提案制 + 宿主代写 + 五硬门 + L1 隔离 + 独立复核 | 污染 → 止步 L0/L1 的隔离候选 |

**一句话**：Taric 把四类风险从"不可见、不可控的模型失效"转变为"**可观测、可拦截、可恢复的状态问题**"。残余风险（模型单次推理的注意力遗漏、同源误读、复核吞吐等）属于运营层，其推演与宿主前提见 §10。

## 4. 身份与接入设计

### 4.1 Principal 分配表

| Principal ID | Role | 绑定 | Capabilities | 接入通道 | 说明 |
|---|---|---|---|---|---|
| `planner` | model | engagement | read, propose | MCP stdio | 只规划：读上下文、提交 WorkItem/假设/纠偏提案 |
| `executor-1..N` | model | engagement | read, propose | MCP stdio（每实例一个进程） | 读任务上下文、提交观察提案/进度建议/动作建议 |
| `observer` | model + reviewer（双通道） | engagement | read, propose / read, review | MCP stdio + 宿主 reviewer RPC | 读全局状态、检测异常、评审提案、提交纠偏提案与建议 |
| `pentest-host` | host | engagement | read, propose, work, checkpoint, action, content；原文另授 content_read | 宿主内嵌 CoreService | 任务认领/续租/重认领、观察捕获、Artifact 存取、checkpoint 提交、动作决定/结果 |
| `operator` | operator | engagement | read, propose, admit, writer, audit, operator, content；原文另授 content_read | CLI / 宿主运维面 | Engagement 初始化、admission、审计诊断、会话绑定、原文读取 |
| `canonical-writer` | writer（或具备 writer 能力的 operator） | engagement | writer | 受信任宿主治理通道 | 显式调用 `admission.promote_l2`；与普通 host、reviewer 身份分离 |

约束：

- 每个智能体使用**独立的 `TARIC_PRINCIPAL_ID`**，保证审计事件、幂等键、Context cursor 与提案 provenance 可归属到具体 agent。
- 观察者需要两个身份：`model` 身份走 MCP 做日常巡查；`reviewer` 身份仅用于 `review.submit`（reviewer_id 必须等于已验证 principal id，防止伪造）。两个身份能力不同，不要混用。
- 智能体**不得**持有 host/operator/writer 凭据。多主机可以存在多个受信任 Core 写入实例，由共同 authority 的事务、版本和权限检查协调；不存在模型绕过 Core 直写数据库的通道。
- 多主机使用全局可区分的身份，例如 `host-a`、`host-b` 与 `host-a/executor-1`、`host-b/executor-1`。`TARIC_HOST_ID` 是部署标识，任务 owner 取自经过验证的 host principal；仅修改请求中的 `host_id` 不会转移归属。部署时应将本机 host principal 与部署标识一致配置。

### 4.2 单机部署配置

| 项 | 值 | 说明 |
|---|---|---|
| authority profile | `single_host_sqlite`（默认） | 显式省略 PostgreSQL 配置即生效 |
| `TARIC_DB` | `./data/taric.sqlite` | 三类 agent 的 MCP 进程与宿主内嵌 Core 指向同一文件 |
| `TARIC_CONTENT_ROOT` | `./data/content` | Artifact spool 根；任务会话根必须位于其内 |
| `TARIC_ENGAGEMENT_ID` | 本次 Engagement UUIDv7 | 所有 principal 统一绑定，防跨 Engagement 读写 |
| MCP 启动 | 每个智能体一个 `taric-mcp` stdio 子进程 | 分别设置 `TARIC_PRINCIPAL_ID=planner\|executor-N\|observer` |
| 原文读取 | 宿主/observer 经 `content_read` capability | 智能体模型侧默认永远只见元数据 |

单机入口须统一解析到同一持久 SQLite authority，避免各自创建独立副本；受信任宿主可统一提供本机 Core 接入通道。当前 Core 和持久化接口均为异步，构造、调用与关闭需要 `await`；底层 SQLite 仍是单写者，同步文件/数据库工作和大导出可能占用调用进程，应通过有界查询与独立维护进程控制（见 §10.4 前提 8）。

### 4.3 PostgreSQL 多主机配置与启用

所有机器使用兼容的 Core 构建、schema 与 policy，连接同一 PostgreSQL authority。下表中的主机身份、principal 和本地目录需要逐机配置；同一协作项目使用同一个 Engagement UUIDv7。

| 配置项 | 配置要求 |
|---|---|
| `TARIC_AUTHORITY_PROFILE` | `multi_host_authority`，显式选择 PostgreSQL |
| `TARIC_DATABASE_URL` | 指向共同的 PostgreSQL 服务与目标数据库，由受信任运行时持有 |
| `TARIC_HOST_ID` | 逐机唯一，例如 `host-a` / `host-b` |
| `TARIC_LEASE_MODE` | `server_side`，使用数据库时间判断租约到期 |
| `TARIC_RUNTIME_CONFORMANCE` | 指向与当前执行构建、schema、policy 摘要匹配的通过报告 |
| `TARIC_CONTENT_ROOT` | 当前机器独立、持久的内容根；不因为数据库共享而共用可写 spool |
| `TARIC_ENGAGEMENT_ID` | 协作宿主绑定同一项目，权限由已验证 principal 约束 |
| `TARIC_PRINCIPAL_ID` / `TARIC_PRINCIPAL_ROLE` | 按实际进程身份设置；模型 MCP 进程保持 model 身份，host 能力经宿主受信任通道提供 |

启用顺序：先部署 PostgreSQL 并由 operator 初始化受支持的 schema；在隔离测试数据库/schema 上完成 live conformance 和恢复验证，生成当前构建的启用报告；再配置各机器并检查真实 authority 的 schema、序列与 lease/fencing 健康，最后接入宿主流量。CLI/MCP 使用 `openRuntimeService` 的共同启用路径；内嵌宿主应复用该入口，而不是绕过启用门直接创建生产 store。

```ts
import { openRuntimeService } from "@taric/core";

// 在受信任宿主进程中读取上述环境/配置；principal 由接入通道验证并绑定。
const service = await openRuntimeService();
try {
  const result = await service.dispatch(operation, verifiedPrincipal, request);
  // 按结构化结果处理成功、版本冲突、授权拒绝或不可用。
} finally {
  await service.close();
}
```

这是调用结构示意，`operation`、`verifiedPrincipal` 和 `request` 由宿主集成提供。连接凭据不能交给模型。服务不可用、报告缺失/不匹配或健康检查失败时保持阻塞，不创建 SQLite 降级副本；恢复 PostgreSQL 后重新检查健康并重试。部署步骤见[本地部署与启用](postgres-local-deployment.md)和[多主机运行手册](multi-host-authority-runbook.md)。仓库 Compose 示例仅绑定本机回环地址，不能原样作为跨机部署；跨机部署需配置受控网络、身份凭据、最小权限和连接保护。

### 4.4 异构宿主的协作接入

自主开发的渗透测试宿主可直接内嵌 Core，或在本机经受认证通道对接；模型仍用受限 MCP 工具。当前认证的 Pi 1.4.0 合同覆盖 session/context/proposal/checkpoint/action/result/error 生命周期；DeepSeek Harness 原生桥主要覆盖已验证的 session 事件；Hermes 覆盖上下文和 session/tool 观察钩子，不替换 MemoryProvider。使用后两者时，未覆盖的认领、续租、检查点、动作结果与恢复流程需由可信宿主经 CLI/host RPC 或内嵌 Core 补齐；模型 MCP 六工具不能替代这些 host-only 操作，不能把“可访问共同数据库”视为“完整协作闭环已完成”。版本与边界以[接入指南](agent-integration.md)和[能力清单](../packages/core/src/compatibility.ts)为准。一个未参与 Taric 设计的真实 Bun 宿主的完整映射与改造清单见 §14。

## 5. 采用闭环、成本与保证边界

下面五条路径是依赖闭合的采用选择。每条路径都列出初始化、真实宿主职责、认证角色、操作和信任结果；完成一次调用不代表后续路径已经启用。模型始终只能使用现有六个 MCP 工具，host/operator/reviewer/writer 凭据必须由宿主的受信任入口持有。

| 路径 | 初始化与依赖 | 角色与 operation | 结果、信任边界与宿主职责 |
|---|---|---|---|
| **A：只读已有状态** | operator 建立 Engagement 与 Scope；宿主把 principal 绑定到 Engagement；Core/authority 健康。 | `model`/`host`：`context.query`、`resource.query`、`evidence.query`。 | 返回固定、范围受限的 Context/元数据。宿主负责模型调用、范围选择、翻页和处理 omitted/blocked；Taric 不创建事实，也不跨 Engagement 分享。 |
| **B：受治理候选** | A，加 host capture 通道和版本化 admission policy。 | `model`：`proposal.submit`；`host`/`operator`：capture 与候选查询；`writer`/`operator`：`admission.evaluate`，host 须额外授予 `admit`。 | 得到 pending proposal 或 L1 candidate。宿主必须依据真实工具输出捕获并挂接证据；L1 不进入普通已验证召回，proposal 不是 Finding。 |
| **C：已验证 Finding** | B，加固定 proposal/evidence/scope 版本和独立 reviewer 绑定。 | `reviewer`：`review.submit`；授权 `writer`/`operator`：`admission.promote_l2`。 | 只有独立审核和晋升硬门全部通过才产生 L2。宿主负责审核者分离、输入/策略 hash 和人工审批；Taric 不证明观察绝对真实，也不签发攻击授权。 |
| **D：运行恢复** | A，加 WorkItem、WorkRun/Attempt、有效 lease、当前 generation。 | `host`：`work.claim`、`work.renew`、`work.reclaim`、`checkpoint.commit`、`work.resume`；模型只能提议 checkpoint。 | 提供有归属的 checkpoint 和租约恢复边界。宿主调度 worker、执行工具、对账 unknown 外部动作，并在 reclaim 后重新检查前提；Taric 不调度 agent、不锁目标系统。 |
| **E：原文内容** | host/operator 在 `TARIC_CONTENT_ROOT` 下显式绑定 session；配置持久存储和 ACL。host-session 捕获不依赖 WorkRun；run-bound 捕获依赖 D。 | `host`/`operator`：`artifact.session.bind`、`artifact.store.begin/append/commit`；另授 `content_read` 后才可 `artifact.content.read`。 | Taric 保存哈希、manifest 和不透明字节（或 `host_ref`），只向模型给 bounded reference/metadata。宿主负责捕获、扫描、脱敏、保留、spool 备份和原文交付；模型工具永远不拿原文。 |

可运行的 [隔离 Node 治理测试](../packages/core/test/trusted-node-governance.test.mjs)覆盖 operator 初始化、host 工具结果捕获、proposal/L1、独立 reviewer transport attestation 和 writer L2 晋升，并断言 `pending` → `machine_approved` L1 → `independently_verified` L2 及 MCP 六工具边界。测试中的审核 attestation 与 host 工具结果是 fixture，不代表真实人工审核或外部宿主认证；旧 input/evidence hash 会被拒绝。

### 显式会话绑定与运行 fencing

`artifact.session.bind` 必须显式选择 `host-session` 或 `run-bound`，仅 host/operator 可建立持久绑定。`host-session` 拒绝运行字段，仅承诺认证的 Engagement/session 隔离与内容完整性，不提供 WorkRun owner/lease 保证。`run-bound` 必须绑定当前 `work_run_id + attempt_id + generation + owner_host`，校验 transport owner、有效租约及当前 Attempt；请求省略或替换字段不能将该绑定降级。

Artifact begin/append/commit 和重启 publication 恢复从持久绑定复验 fence；失效内容不能变为 available。proposal/capture/checkpoint/action 附件同时核查可信 transport session，缺失、部分或错 owner 的运行关联在状态变更前失败；迟到提案仍保留原 Attempt/session 归属并进入隔离。`taric proxy` 用 `TARIC_SESSION_ID` 固定 host principal 的会话，RPC body 无权替换；未配置会话的 proxy 可处理独立 host 操作，但不能附着到已有 task session 的运行。

宿主仍负责真实任务与 proxy/worker 的路由映射。详见[API 会话合同](taric-api.md#task-session-artifact-content)及[transport fencing 测试](../packages/core/test/transport-session-fencing.test.mjs)。

### 两类宿主成本记录模板

以下是记录表，不是预估值。按宿主版本、Core 构建、fixture、机器和 transport 填写；未知值写 `未测量`，不得转换为人周、ROI、认证或等效安全比例。

| 字段 | 已有确定性 bridge 的宿主 | 只有模型工具入口的宿主 |
|---|---|---|
| 集成边界 | 既有 bridge/client 与 Core transport | 新建受认证的非模型 service/Node proxy，加模型 MCP |
| 宿主职责 | 字段映射；principal/Engagement 绑定；捕获真实工具结果；回传结构化状态 | 包含左列全部职责，加 proxy 启停/重连、socket/key/container、证据捕获，以及 reviewer/writer/operator 分离 |
| 实际记录 | 工时、失败调试轮次、Core 调用数、审核等待、CPU/RSS/延迟、重试 | 左列全部，加 proxy hop、进程重启、序列化、队列和跨进程等待 |
| 证据 | 命令、版本/commit、请求/结果样本、日志、hash、失败案例 | 左列全部，加宿主/proxy 版本、socket 权限、凭据轮换和真实工具输出来源 |
| 结论 | 只描述实际跑过的路径和拓扑 | 只描述实际跑过的路径、proxy 合同和固定宿主版本；模拟或 callback-only 仍是未验证 |

### 适用场景与事实保证边界

Taric 适合需要跨会话的持久、范围隔离记忆，独立审核 Finding，租约感知恢复或不透明证据引用的宿主。不适合不需要治理记忆的短期一次性扫描、无法维护独立审核链的团队，或没有当前匹配 conformance 报告和健康 fencing 的共享 PostgreSQL 部署。agent 数量本身不能证明适用。

Taric 的事实保证限于所述且实际测量的合同：principal/Engagement 认证、schema/reference/version/idempotency 校验；使用相应门槛时的 L0/L1/L2 隔离；显式 run-bound 操作的 CAS/lease/generation 拒绝；以及声明 profile 内的 Artifact hash/publication 校验。Taric 不保证宿主观察真实、资产发现完备、外部动作恰好一次或已获授权、凭据安全、原文已脱敏、数据库报告仍匹配新部署，也不建立质量统计、ROI、人周、认证或等效安全百分比。推演、历史报告、模拟、callback 和 synthetic benchmark 只证明对应练习，不能升级为真实宿主认证。

### I-01～I-08 来源索引

| 来源 | 本入口中的采用决定与证据锚点 |
|---|---|
| **I-01** | 本节 A～E 依赖闭环、角色/operation/宿主职责；提案 §6。 |
| **I-02** | Node proxy 与非 Node 宿主边界；`packages/core/src/adapter-rpc.ts`、`openRuntimeService`、提案 §7。 |
| **I-03** | 显式持久会话模式、transport session 与运行元组；`packages/core/src/artifact-content-store.ts` 的 `assertFence`、`packages/core/src/store.ts` 的 `validateArtifactFence`、提案 §8。 |
| **I-04** | 实例能力与证据合成；`packages/core/src/compatibility.ts`、`packages/core/src/adapter.ts`、提案 §9。 |
| **I-05** | 有界 Context/cursor 和读取成本；`packages/core/src/context.ts`、authority paging/cursor、提案 §10。 |
| **I-06** | Artifact transport/profile 与维护测量；`packages/core/src/artifact-content-store.ts`、`packages/core/test/artifact-scale.test.mjs`、提案 §11。 |
| **I-07** | 先有界 host 状态轮询、后按实测预算决定可选通知；提案 §12。通知永远不是正确性依赖。 |
| **I-08** | 公开导入边界；`packages/schemas/src/registry.ts`、service dispatch、提案 §13。公开 `snapshot.import` 返回 `unsupported_capability` 且不改状态；内部 restore 仅 operator 使用。 |

README、Pi descriptor/registration、`adapter.status`、`capability.status` 和公开导入声明的矛盾清单与修正规则见[接入指南 Support Consistency Rules](agent-integration.md#support-consistency-rules)。该表以实现位置、测试证据范围和任务编号为锚点：静态 compatibility manifest 只表示已测上限；实例能力须完成注册，Core 无法观察的外部注册/健康字段保持 `not_observed`；公开 `snapshot.import` 仍在 dispatch 前拒绝。这里的合同测试不替代真实宿主进程、当前 PostgreSQL readiness 或发布认证。

### 已交付的代理与状态读取

非 Node 宿主可使用本机 `taric proxy`，无需在 Bun 内加载 `node:sqlite`。真实 Node 22.21.1/Bun 1.3.13 的[重启实测](benchmarks/proxy-restart-v5.json)覆盖 26 次调用、两次 proxy/Core 重启、幂等、CAS 与迟到提案隔离；不构成 BreachWeave/CyberStrike 真实宿主认证。proxy 固定 host 身份，operator/reviewer/writer 必须走独立认证通道；socket、token、authority 和 spool 挂载由可信宿主管理。

`host.state` 仅供 host/operator，返回 Engagement 范围内 L1、Conflict、Impact、unknown action、到期 lease/freshness 的有界聚合与完整性标记；即使没有新提交，也按本次 `read_time` 反映到期。宿主用退避轮询发现状态变化；[轮询实测](benchmarks/host-state-poll-v1.json)满足该 fixture 的 1000ms 预算，resources subscription 保持 disabled。示例及返回边界见[API](taric-api.md#host-state-polling)。

### 5.1 黑板状态设计

#### 5.1.1 黑板分区与 Taric 实体映射

| 黑板分区 | Taric 实体 | 写入方（经谁） | 读取方 |
|---|---|---|---|
| 任务规划区 | `WorkItem`（含 goal/acceptance/risk_budget/目标资源） | planner 提案 → 宿主 admission | 全部 |
| 任务执行区 | `WorkRun` / `Attempt`（owner、lease、generation、状态、task_session_ref） | 宿主 `work.claim/renew/reclaim` | 全部（观察者重点） |
| 观察结果区 | `Observation` / `NegativeObservation` / `ControlObservation` / `AccessDecisionObservation` | 宿主 `capture.observation` / `control.observe` / `access.observe`（依据执行者回传与工具输出） | 全部 |
| 原始证据区 | Artifact（任务会话 spool）+ `Evidence`（引用 content_ref） | 宿主 `artifact.store.begin/append/commit`；Evidence 随观察/提案关联 | 宿主/operator/observer（原文需 content_read）；模型只读元数据 |
| 结论事实区 | `Claim` / `Finding` / `AttackPath` / `Relation` | 执行者或 planner 提案 → admission（L1）；Finding 经独立复核后，由授权 writer 显式 promotion（L2） | 全部（按信任级过滤） |
| 覆盖状态区 | `CoverageCell` | 随观察/阴性结果更新（宿主捕获路径） | planner（补规划）、observer（查缺口） |
| 异常纠偏区 | `Proposal`（拒绝态）/ `Review` / `Conflict` / `ImpactEvent` / `ActionIntent` | observer 评审+纠偏提案、宿主执行 impact/reclaim/动作 | 全部 |
| 恢复区 | `Checkpoint` | 执行者 `checkpoint.propose` → 宿主 `checkpoint.commit` | 执行者（resume）、observer |
| 演进区 | `ResourceRevision` / `PatchSet` | 宿主 `resource.revise/patch/relation/impact`（依据提案） | 全部 |

#### 5.1.2 读写权限矩阵（R=读 W=提案写 H=宿主代写 ✕=不可见）

| 分区 | Planner | Executor | Observer | 宿主运行时 | Operator |
|---|---|---|---|---|---|
| 任务规划区 | R/W | R | R/W | R/H(admission) | R/H |
| 任务执行区 | R | R(自身 Run) | R | R/H(claim/renew/reclaim) | R |
| 观察结果区 | R | R/W | R | R/H(capture) | R/H |
| 原始证据区-元数据 | R | R | R | R/H(store) | R/H |
| 原始证据区-原文 | ✕ | ✕ | R(需 content_read) | H(read) | H(read) |
| 结论事实区-L0/L1 | R(显式 candidate) | R(显式 candidate) | R | R/H | R/H |
| 结论事实区-L2 | R | R | R | R；升级需独立 writer 通道 | R/H（需 writer 能力） |
| 覆盖状态区 | R | R | R | R/H | R |
| 异常纠偏区 | R/W | R/W | R/W+Review | R/H(强制执行) | R/H |
| 恢复区 | R | R/W(propose) | R | R/H(commit/resume) | R |

## 6. 核心工作流

### 6.1 Engagement 初始化与任务会话绑定（operator/宿主，一次性）

```text
1. operator: engagement.init        → 创建 Engagement + Scope（ROE、允许/禁止目标、窗口）
2. operator: artifact.session.bind  → { engagement_id, session_id: "pentest-<engagement短id>",
                                        root: "<TARIC_CONTENT_ROOT>/sessions/pentest-<短id>",
                                        mode: "host-session" }   ← mode 必填
3. operator: audit.doctor           → 确认 authority/sidecar 健康
4. 宿主: 启动 N 个执行者 MCP 子进程 + planner/observer MCP 子进程（统一 TARIC_ENGAGEMENT_ID）
```

单机单 Engagement 可绑定一个任务会话根，靠 `work_run_id/attempt_id/generation` 区分执行者归属。多主机则由每台宿主创建独立 `session_id`（如 `pentest-<短id>-host-a`）及本地根，避免相同 session 被不同机器绑定到互不可见的文件路径（见 §8.4）。

### 6.2 规划流程（Planner，纯提案）

```text
① planner: context.query（省略 work_run_id，预算约 12000 字符）
   └─ Context Pack 固定 read_seq：Scope/ROE → 覆盖缺口 → L2 资源/关系 → 冲突/过期项 → 待办 WorkItem
② planner: proposal.submit（每任务一个，subject_type: "work_item"）
   content = { schema_version, kind: "work_item", title, status: "queued",
               goal, acceptance_criteria[], risk_budget, scope_ref?, depends_on?, resource_refs?,
               engagement_id }
   （严格按 WorkItem schema 提交：支持经验证的 resource_refs 作为调度提示；
      不接受 target_resource_refs / worker_role / constraints 等自由字段。
      resource_refs 不构成目标资源锁，互斥与调度仍由宿主实现。不传 content.id，
      canonical UUIDv7 由 Core 分配）
③ 宿主（非 LLM）: admission.evaluate
   ├─ Core 校验结构、引用、归属、来源与版本；宿主另行检查验收、任务语义重复和调度约束
   ├─ 通过 → WorkItem 进入权威任务池（L1）
   └─ 拒绝 → 状态 rejected，planner 可经 proposal.list 查看原因后重新规划
④ planner 持续: resource.query / evidence.query / context.query（新 read_seq）→ 发现覆盖缺口 → 补充提案
```

规划者**不认领任务、不执行工具、不写观察**；它的产出只有 WorkItem/假设/关系提案与规划建议。

### 6.3 任务执行流程（宿主调度 + Executor 认知 + 工具在外部执行）

以执行者 `executor-2` 认领 WorkItem `W-42`（目标资源 `R-api`，无冲突）为例：

```text
调度（宿主，非 LLM）:
  a. 从任务池选择 status=queued 且与在跑任务资源集不相交的 WorkItem
     （并发资源池：N 个执行者 → N 个并发 WorkRun；冲突判定见 §7）
  b. work.claim { engagement_id, work_item_id: W-42, host_id: "pentest-host",
                  agent_id: "executor-2", ttl_ms: 300000 }
     → 返回 run_id、attempt_ref、generation、lease_expires_at、read_seq
     （task_session_ref 不来自请求体：它取自受认证 transport 注册的会话，
       body 中携带会被拒绝；同一 WorkItem 的活跃租约唯一，重复 claim 被拒绝）

执行循环（executor-2 经 MCP）:
  c. context.query { work_item_id: W-42 }
     → Pack 含 WorkItem 目标/验收/风险预算、R-api 当前版本、相关 L2 观察、
       最近 checkpoint、限制条件；不含未显式请求的 L0/L1 项
     （MCP 工具 schema 虽接受 work_run_id，但 Core builder 不消费它，不会据此绑定运行；
       任务定位请用 work_item_id，运行归属由宿主在 checkpoint/action 调用中携带）
  d. action.recommend { target: "https://target/api", method: "GET+FUZZ",
                        rationale: "...", uncertainty: "...",
                        evidence_refs: [...], work_run_id, generation }
     （action.recommend 不接受 mode 字段；mode 由宿主在下一步的决定中给出）
  e. 宿主策略: action.host-decision { ..., mode: "llm_recommend" 等 }
     ├─ 低风险预授权池 → status=authorized（authorized_autonomous），宿主执行工具
     ├─ 高风险 → host_hitl：宿主向审批人请求 → 回传 authorized/denied
     └─ 拒绝 → denied，执行者换路或标记 blocked
  f. 宿主执行工具（Taric 外部），拿到原始输出（HTTP 请求/响应对）

落盘（宿主，host principal）:
  g. artifact.store.begin { payload_kind: "manifest", media_type: "application/json",
          work_run_id, attempt_id, generation,          ← 三者必须齐备的 run 作用域 fence
          child_refs: [<req-artifact>, <resp-artifact>] }   ← 复合捕获：请求/响应各自独立
     （单个大输出：begin{payload_kind:"binary"} → append×N（≤64MiB/块）→ commit）
  h. capture.observation { observation: { schema_version: "1.0.0", engagement_id,
          kind: "observation", resource_ref: R-api, observed_at,
          statement: "...", artifact_refs: [{ content_ref, content_status: "available",
                            integrity_status: "verified", byte_length, content_hash }],
          limitations: [...] },                    ← 领域 schema 的必填/可选字段
          work_run_id, generation }
     → Observation 进入权威层（宿主写入，可信来源）
     （普通 observation schema 不接受 conditions/evidence_refs；conditions 属于
      negative/control/access observation 类型，需按对应 subject_type 单独提交）

进度与恢复:
  i. executor-2: checkpoint.propose { completed_steps, next_steps,
          observation_refs, negative_results, budget 消耗 }（L0 候选）
  j. 宿主复核租约/引用/工具结果后: checkpoint.commit → 形成可恢复安全边界
  k. 宿主周期性 work.renew（心跳）；任务完成 → 结果状态 completed，回填 WorkItem

结论沉淀:
  l. executor-2: proposal.submit（claim/finding，引用 g/h 的 evidence）
  m. 宿主: admission.evaluate → L1 机审候选（默认不进普通召回）
  n. observer 或独立 reviewer: review.submit（pass，固定 proposal/evidence 输入）
  o. 授权 writer/operator: admission.promote_l2 → 重算硬门 → L2 Finding 或结构化拒绝
```

要点：

- **观察写入走宿主**：`capture.observation` 是 host-only 操作。执行者智能体对"我观察到了什么"只有提案权；宿主依据工具输出执行捕获，避免 LLM 幻觉直写事实层。
- **Artifact 上传由持久会话模式决定 fence**：run-bound 上传必须带齐 `work_run_id + attempt_id + generation`，Taric 在 authority 事务中验证租约；被 reclaim 的旧代数上传被拒绝，迟到输出进隔离。host-session 上传可以不带运行字段，但不获得 WorkRun owner/lease 保证，详见 §5。
- **阴性结果同等重要**：未复现、被 WAF 拦截（`access.observe` + `origin_outcome: "not_reached"`）都经宿主写入，为覆盖闭环与"噪音/静默任务互斥"提供依据。

### 6.4 观察与纠偏流程（Observer）

观察者持续巡查黑板，检测三类异常并驱动纠偏：

| 异常类别 | 典型信号（Taric 检测锚点） | 纠偏动作（observer 发起） | 宿主强制执行 |
|---|---|---|---|
| 规划异常 | WorkItem 出 Scope / 与在跑任务资源重叠 / 验收不可判 / 重复规划已覆盖目标 | 对 pending 提案 `review.submit(reject/needs_evidence)`；向 planner 提交纠偏提案（收缩目标、拆分任务） | admission 拒绝；通知 planner 重新规划 |
| 执行异常 | 连续动作 denied、长时间无心跳、checkpoint 停滞、动作 unknown 未对账、同资源并发写冲突（Conflict 记录）、噪音任务干扰静默任务（access_decision 频繁 observed） | `action.recommend`（暂停/限速/换窗口/切换低噪音方法）；对可疑 Finding `review.submit(needs_evidence)`；提交"标记前提失效"提案 | 宿主停派/中止工具；过期后才可 `work.reclaim`；按 owner/generation 对账 unknown；`resource.impact` 传播失效 |
| 协作/记忆异常 | L1 候选证据过期（freshness 失败）、依赖的前提被撤回、覆盖格回退、迟到结果 | 纠偏提案：supersede/retract 旧 claim、排重验 WorkItem | `resource.impact` 有界传播 → 受影响 Finding 暂出高信任召回、重验任务入池 |

闭环示例（执行者 1 的高静默验证被执行者 2 的目录爆破干扰）：

```text
① observer: context.query（workerRole=observer）→ 发现 R-api 上 access_decision 频繁 "challenge"，
   且 W-静默验证 与 W-目录爆破 的资源集交叠
② observer: action.recommend { target: "W-目录爆破", method: "pause+reschedule",
      rationale: "高频 403/429 已触发防护，干扰静默验证前提" }
   （mode 不是 action.recommend 字段；宿主在执行决定时才选择 host_hitl）
③ 宿主: 审批后停止/暂停目录爆破工具并停止派发；需要转移 owner 时，等待租约过期后
   才可 work.reclaim → 旧 attempt lost、pending sidecar 封存（reclaim 不是即时取消接口）
④ observer: proposal.submit（将"R-api 未启用 WAF"旧 claim 标记 stale，附 access 证据）
⑤ 宿主: admission → resource.impact → 依赖该 claim 的 Finding 暂出 L2 召回、重验 WorkItem 入池
⑥ planner: 下轮 context.query 看到 Conflict/ImpactEvent/覆盖缺口 → 重排计划
```

观察者纠偏的三条纪律：**不直接改权威**（只有评审/提案/建议权）；**不代替宿主执行**（reclaim/impact/授权都是宿主动作）；**纠偏本身留痕**（Review、Proposal、ActionIntent 全部入审计链）。

### 6.5 中断恢复流程

```text
原 owner 重启且租约仍有效:
  ① work.resume → 最近 checkpoint、当前水位、未决动作与 premise_checks
  ② 全部前提通过才按已验证边界继续；失败则 blocked/replan_required

租约已过期 / 需要跨机接管（A → B）:
  ① B 的调度器确认租约过期，通过 work.reclaim 取得新 owner、Attempt、generation
  ② B 以当前 host principal 调用 work.resume，读取历史 checkpoint 与当前前提
  ③ 旧 checkpoint 的 Attempt/generation 不属于新代，不能直接视为可执行恢复点；
     宿主核对已完成步骤、目标/Scope 版本、证据可用性与未决动作，必要时重规划，
     显式重建当前 Attempt 的 checkpoint 后再次检查恢复条件
  ④ 结果未知的外部动作先核对真实执行结果；遵守 action.reconcile 的 owner/generation
     约束，不能把旧代动作改标为新代，也不自动重放；无法核实则保持阻塞并交 operator
  ⑤ 旧 attempt 的迟到草稿/结果隔离；复用需显式 rebase；恢复后周期续租并刷新上下文
```

跨机接续恢复的是共享任务状态、可验证进度和证据引用，不会迁移模型进程、内存、浏览器登录态或本地文件。新宿主必须先具备相应工具、网络位置、授权和证据访问条件；缺少旧宿主原文时按 §8.4 获取或重采，不能假定文件已经同步。`work.resume` 限定当前 owner，B 不能在接管前冒用 A 身份读取 owner 专属恢复包。接管后应重新发起上下文查询：cursor 还绑定 principal、authority 与本地内容根下的验证密钥，不承诺跨机器或跨 principal 直接复用旧 cursor。

operator 使用 `audit.doctor` 诊断 authority 与当前宿主 spool；`audit.reconcile` 仅对可修复的派生状态和本机发布标记执行恢复。它不替代文件迁移或外部动作对账。

## 7. 并发执行与冲突控制

### 7.1 并发资源池映射

- 宿主的"并发资源池 N"直接映射为 **N 个并发 WorkRun**；每个执行者同一时刻至多持有一个活跃租约。
- 任务分派的**无冲突判定在宿主调度器**完成：WorkItem 可带经引用校验的 `resource_refs`，但它是查询/调度提示，不是目标资源锁。宿主应结合该映射与依赖闭包（`depends_on` / Relation 的 depends_on）执行互斥、限速和动作授权，才允许任务并行。
- Taric 提供的并发原语在分派器失效时兜底：

| 原语 | 保证 | 兜底场景 |
|---|---|---|
| WorkRun 活跃租约唯一 | 同一 WorkItem 不会被两个执行者同时认领 | 调度器并发窗口漏判 |
| generation fencing | reclaim 后旧代运行受保护写入按合同拒绝；迟到提案保留原 Attempt 隔离，host-session 不获得运行 fencing | 执行者僵死后复活 |
| CAS（expected_version） | 同一实体版本竞争至多一方成功 | 两个执行者改同一 Resource/Claim |
| PatchSet 冲突队列 | 事实字段/互斥关系冲突保留双候选，不 last-write-wins | 并发修订同一资源 |
| 幂等键 | 工具重试/进程重启用同键返回原结果，不重复转移 | 宿主重试语义 |

这里的幂等保证适用于相应 Taric 状态操作，不代表外部工具动作恰好执行一次；同键还需匹配 principal、operation、Engagement 与规范化 payload。跨宿主换 principal 后，不能假定沿用旧键就会复用旧结果。

### 7.2 共享实体的并发写策略

- 观察类记录天然无冲突（append-only，各执行者各写各的 Observation/Evidence）。
- 修订类操作（ResourceRevision、Relation、Claim 修订）统一走 PatchSet：声明 read_set/write_set 与 expected_version/base generation；非重叠变更自动合并，重叠变更进 Conflict 队列由 planner 在下一轮规划中消解。
- 观察者把**长时间存留的 Conflict** 视为协作异常信号，推动 planner 拆分任务边界或串行化。

### 7.3 跨宿主调度与全局资源约束

多主机可共用一个外部调度器，也可各自选择待办后竞争 `work.claim`。共同 PostgreSQL 对同一 WorkItem 的有效租约、owner、版本和 generation 提供最终裁决，各宿主依据数据库时间续租与接管，不以各自本机时钟决定归属。

但**任务唯一租约不等于目标资源锁**：两个不同 WorkItem 即使影响同一目标，也可能分别被成功认领。需要全局限制的目标并发、速率、噪音、身份与时间窗，应由共同调度器或宿主已有的全局配额/互斥机制管理；各宿主只做“查询当前在跑任务→本地判断→认领”会存在竞争窗口，不能宣称 Taric 已原子锁住全部目标资源。

每个宿主的协作循环应包括：分页查询待办与必要的 L1 candidate → 检查全局资源约束 → `work.claim` → 构建任务 Context Pack → 工具执行与 checkpoint → 周期 `work.renew` → 提交结果/释放宿主侧配额。遇到 claim/CAS 冲突时重新查询，不能覆盖其他 owner。普通查询不会自动把 L1 任务当事实召回；调度器使用授权的候选查询路径。

宿主与 PostgreSQL 断连或续租失败时，应停止派发新的目标动作，尝试停止可中止的在途工具，并保留未知动作待对账；数据库侧会拒绝失效代次的受保护写入，但不能撤销已经发往目标系统的请求。单个 PostgreSQL 部署也不会自动获得数据库高可用、离线协作或断网后独立写入再合并的能力。

## 8. Artifact 原文存储集成

### 8.1 绑定与目录策略

- 单机可在一个 Engagement 内绑定一个任务会话根；多主机按宿主/会话分配独立 session 与根（位于各自 `TARIC_CONTENT_ROOT` 内）。执行者的原文按 Taric 服务器派生路径落盘：`artifacts/<UTC日期>/<id前缀>/<artifact-id>/v<版本>/`，自动按天分片，长任务不产生巨型目录。
- run-bound 写入声明当前 `work_run_id + attempt_id + generation`（运行作用域三要素）；Taric 在 authority 事务中验证租约与代数，跨 run/过期写入被拒绝。host-session 捕获按显式 session/Engagement 隔离，不宣称 lease fencing。

### 8.2 典型工具输出 → Artifact 映射

| 工具输出 | 上传方式 | 说明 |
|---|---|---|
| 单个 HTTP 响应/页面源码 | `begin(text) → append(1块) → commit` | `charset`/`content_encoding` 作元数据 |
| HTTP 请求+响应对 | 两个子 Artifact + `begin(manifest, child_refs)` | 复合捕获，子项独立可读，不拼接 |
| 截图/二进制 | `begin(binary) → append×N → commit` | ≤64MiB/块，原生字节，不 base64 落盘 |
| nmap/nuclei 输出 | `begin(text/manifest)` | 大输出分块；摘要走宿主 `summary_ref` |
| 抓包（pcap 分段） | 每段一个子 Artifact + manifest | 独立寻址，支持分段校验 |
| 脱敏后的报告引用 | 新 `begin(derived_from: 原content_ref)` | 派生物 = 新哈希新版本，不覆盖原文 |

base64 仅是 CLI/RPC 传输编码；canonical 哈希与存储字节是解码后的原始字节。上传中断时 staging 私有，列表/读取/Evidence 全不可见；重试同 ordinal 仅在字节与哈希一致时幂等。

### 8.3 读取与可见性

- **模型侧（planner/executor）永远拿不到原文**：MCP `tools/list` 无 Artifact 操作；context/evidence 只含 opaque 引用 + 媒体类型 + 字节长度 + 哈希 + 完整性状态。
- **observer 审计原文**：经宿主通道持 `content_read`，`artifact.content.read` 按块有界读取（带 chunk cursor），核对工具输出与 Observation 陈述是否一致——这是"执行者是否虚报结果"异常检测的原始依据。
- **operator 取证导出**：`artifact.session.output`（默认元数据/执行记录，显式 `include_content` 才带字节）按 keyset cursor 分页导出整个任务会话，用于交付与复盘。
- 完整性：读取校验目标 chunk 哈希；篡改/缺失 → `integrity_failed/unavailable`，该 Evidence 不再被视为可用，observer 收到信号后触发重测提案。

### 8.4 多主机原文访问、接管与备份

PostgreSQL 保存 task-session binding、上传状态、目录/chunk 元数据、发布标记与证据关联；**原始 payload bytes 仍在绑定宿主的文件 spool，或由宿主以外部 `host_ref` 管理**。A 提交的目录行在共同 authority 中可见，不代表 B 的本地文件系统存在该内容，Taric 也不会自动抓取外部引用或向远端 spool 路由。

本方案按宿主绑定独立 session；读取/导出通过持有该 spool 的原宿主受认证内容通道完成，跨机访问与调用路由由宿主系统提供。若需要共同对象存储或文件迁移，必须另行实现并验证适配、授权、绑定与完整性，不能将其当作 Taric 已有能力。不要把两台机器指向同一可写 spool 来代替这种集成。

接管时，新宿主可以先检查共享的证据元数据、哈希和历史进度；需要原文字节的后续步骤必须确认访问路径。`work.reclaim` 沿用既有任务会话引用，不自动把它迁到 B 的内容根；需要在 B 新建本地会话时，应由宿主在重新规划/创建后续 WorkRun 时显式绑定，保留旧证据和执行归属，不修改旧引用来伪装已迁移。

备份需要协调 PostgreSQL 与各宿主 spool，并记录恢复序列和文件完整性。`snapshot.export` 可作为受控检查/导出；公开 `snapshot.import` 与一般 replay 返回 `unsupported_capability`，不创建迁移基线或改变目标 authority。数据库灾备应使用已验证的内部数据库备份恢复流程，并校验匹配的 spool；恢复后重新签发租约与 generation，未知外部动作不自动重放。当前 Artifact profile 只声明进程崩溃恢复，未声明断电耐久性，详见[多主机运行手册](multi-host-authority-runbook.md)。

## 9. 上下文供给策略

| 智能 | Context Pack 配置 | 重点关注 |
|---|---|---|
| planner | 较大预算（如 12000 字符），workerRole=planner | Scope/ROE、覆盖缺口、L2 资源/关系、冲突/过期项、在跑 WorkRun、待办 WorkItem |
| executor | 中预算（如 8000），绑定 work_item_id/workerRole=executor | 本任务目标/验收/风险预算、目标资源当前版本、相关 L2 观察、最近 checkpoint、限制（低噪音/时间窗）；运行归属由宿主另行携带 |
| observer | 大预算（如 16000），workerRole=observer | 跨任务冲突、ImpactEvent、pending ActionIntent、denied/unknown 动作、心跳超期、Conflict 队列、覆盖回退 |

共同保证：Pack 固定 read_seq、字段白名单最小投影、预算不足时强制信息优先并报 `minimum_budget_required`；cursor 绑定 principal 不可跨 agent 复用。

多主机采用相同的供给策略。宿主在领取任务、提交依赖修订、接管、审批变化及规划周期边界重新查询；一个已经构建的 Pack 不会自动随其他机器提交而更新。需要获取 checkpoint 后相关变化时使用 resume delta，并检查前提失效和未检视范围。不同宿主可以在不同序列执行，但提交仍须通过当前版本、owner 与 generation 检查；共同数据库不等于所有模型实时持有同一上下文。

## 10. 长周期大量资产任务能力评估（推演）

### 10.1 评估结论

Taric 提供承载大量资产、长周期任务所需的持久记忆、治理、并发与恢复原语（§3）。按本方案落实 §10.4 的八项宿主工程前提后，还需通过目标部署的规模与韧性验证，才能判断其实际承载能力；多主机部署另须通过 §11.1 的真实宿主验收。共享 PostgreSQL 扩展了可协作的机器范围，不直接证明生产吞吐、全局调度正确性或故障后的自动恢复率。

### 10.2 四类失效模式逐项推演

#### 10.2.1 上下文溢出 → 幻觉 → 偏差：结构性防止，非彻底消除

已消除的根因（机制 → 对长周期大量资产的意义）：

| 机制 | 意义 |
|---|---|
| 预算强制 + fail closed（`minimum_budget_required`） | 溢出不表现为静默截断——强制信息（Scope/ROE/任务验收/checkpoint）放不下时直接结构化报错 |
| 固定优先级 + **resume delta** | 执行者第 30 天拿的是"checkpoint 之后的增量"，不是 30 天历史流水；上下文规模与任务时长**解耦** |
| L0/L1 排除普通召回 + 字段白名单 | 无关信息进不了上下文，噪声不随资产数增长 |
| 钉住 read_seq 快照 | 不读并发写入的半更新状态（多执行者并发时的偏差源） |
| 观察写入走宿主（host-only） | 幻觉无法变成观察事实——权威层只有宿主依据工具字节写入的记录 |
| 零模型直写 | 幻觉的传播半径被封死在 L0 隔离区 |

残余缺口与对应前提：

1. **字符预算 ≠ token 计数**（Taric 已知限制）：超 token 上限时 Taric 不会报错，溢出发生在模型侧 → **前提 1**：按所用模型建立预算校准表（如 8K 上下文模型 ≤ 6000 字符）。
2. **`omitted_ranges` 只可见、不强制消费**：预算不足时 Pack 报告未检视范围，但 planner 若不翻页，决策仍可能基于不完整视图——这是"可见的遗漏"而非"静默遗漏"，可被 observer 检测 → **前提 2**：调度器把"消费完 omitted_ranges"作为规划完成的验收条件之一。
3. **无自动摘要**：资产上万时 planner 不能靠单次 Pack 看全局；Taric 不替你生成资产级摘要 → **前提 3**：资源摘要作为 L2 观察/Claim 由宿主沉淀，planner 按资源分片 `resource.query`。

小结：溢出→幻觉→偏差的链条在**状态层被切断**（幻觉进不了事实、偏差被 Scope 优先 + observer 纠偏拦截），在**单次推理层被压缩但未归零**。

#### 10.2.2 漏报：根因转移——从"模型忘了"变为"矩阵没建/没查"，后者可管理

已消除的根因：

- **CoverageCell 是持久权威状态，不是模型记忆**：资源版本 × 测试类别 × 身份 × 操作 × 条件独立成格，`not_tested` 在白名单投影/报告中**强制可见**（发布门槛）。第 30 天 planner 不需要"记得"测过什么——它查询覆盖矩阵。
- **阴性结果有界保存**：未复现/被拦截通过 `negative_observation`/`control_observation`/`access_decision_observation` 保存 method/baseline/conditions/identity/time/limitations，既不漏（当作没测）也不夸大（不声称普遍不存在）。
- **planner 的 Pack 中覆盖缺口排在实体之前**：缺口是规划的第一输入。
- **observer 独立查缺口**：与 planner 交叉验证，防单点注意力遗漏。

残余缺口与对应前提：

1. **资源清单完备性在 Taric 之外**：Taric 只能追踪被表示为 Resource/CoverageCell 的东西；资产发现本身漏了，矩阵就是"完整的空集" → **前提 4**：资产发现/枚举任务本身作为 WorkItem 入池并接受覆盖追踪。
2. **L1 积压 = 隐性漏报**：真实发现卡在 L1（未复核）不进普通召回，报告层面等于"漏" → **前提 5**：复核 SLA 与观察者巡查周期同 Finding 产出速率匹配；高危异构复核策略显式启用。
3. **条件维度组合爆炸**：身份×操作×路径×条件的 cell 数是乘积关系 → 宿主按风险分级制定矩阵粒度裁剪策略，否则矩阵本身变成新噪声源。

#### 10.2.3 误报：治理链最强的一环，三道硬拦截

```text
无 evidence_refs          → L2 promotion "evidence" 硬门 fail closed 拒绝
引用不存在/跨域/已召回证据  → 引用完整性校验 / 证据快照钉版本 拒绝
证据真实但过期            → "freshness" 硬门拒绝（低/中/高/严重 = 180/90/30/14 天）
─────────────────────────────────────────────
通过 admission.evaluate   → 只到 L1 隔离区，默认不进普通事实召回、不进事实报告
admission.promote_l2      → L2 需独立（高风险要求异构）reviewer；
                            accept=true / 自审 / 同模型同提示一致 全部被拒（投毒回归固化）
```

误报的**代价被限制为消耗复核时间，而不是污染记忆**——这是与"无 Taric 裸跑多智能体"的本质区别。

残余缺口仅一处：**同源误读**（工具输出真实、模型读错、评审用同一模型同一提示也读错）。缓解手段 Taric 已提供（高危强制异构 reviewer / deterministic reviewer / 人工 reviewer），但是否启用是宿主策略（前提 5 的一部分）；启用后此缺口收窄到"工具输出本身歧义"的程度。

#### 10.2.4 任务异常终止：可恢复性已验证，损失窗口由宿主控制

| 故障 | Taric 行为 | 恢复结果 |
|---|---|---|
| 执行者进程崩溃 | 租约到期 → 宿主 `work.reclaim` → generation+1 → 旧 attempt `lost`、pending sidecar 封存 | 新 Attempt 校验历史进度并重建恢复边界后继续（§6.5）；旧代受保护写入被 fencing 拒绝 |
| 宿主机器故障 | 其他机器在共同 PostgreSQL 上等待租约过期后接管 | 检查历史 checkpoint、证据访问和未决动作，重建当前 Attempt 恢复边界后继续；模型进程与本地文件不自动迁移 |
| PostgreSQL 不可用或网络分区 | 多主机 Core 阻塞操作，宿主停止派发新动作 | 恢复服务、确认健康和 owner 后继续；不启用独立 SQLite 副本写入 |
| 前提已变（scope/依赖/证据撤回） | resume 返回 `blocked/replan_required` 而非盲目续跑 | 交回 planner 重规划——不会在错误前提上继续跑出偏差 |
| 写入中途崩溃 | authority 事务原子性；Artifact 使用发布标记与 reconcile | 数据库提交完整或回滚；文件与数据库不是一个事务，孤儿/缺失内容可报告，未验证原文不作为可用内容暴露 |
| 长周期数据增长 | Artifact 按天分片、catalog 水位线增量对账、keyset 分页 | 无巨型文件/单事务全量扫描问题（100GiB/跨 7 天 fixture 已验证） |
| 工具重试/进程重启 | 幂等键绑定 principal+operation+payload hash | 返回原结果，不重复转移 |

残余缺口与对应前提：

1. **checkpoint 粒度 = 损失窗口**：宿主多久 commit 一次，崩溃后就重做多少 → **前提 6**：每个工具动作/每个步骤后提交（契约支持，成本由宿主选择）。
2. **公开导入与灾备分开**：`snapshot.import` 和一般 replay 不属于宿主支持能力；内部 storage backup/restore 仍是 operator-only → **前提 7**：验证数据库备份/恢复与匹配 spool 的恢复，并例行运行 `audit.doctor`。
3. **共享 authority 写入仍需容量规划**：Core 是异步接口，但 SQLite 仍单写者，PostgreSQL 当前按 authority schema 串行协调写事务 → **前提 8**：选择适当的本机接入/维护进程模型，测量真实数据库网络延迟、锁等待和写入 p95；不能从小 fixture 外推多机吞吐。
4. **权威漂移时写入阻塞**（正确行为）：需要 operator 例行诊断，否则表现为"任务卡住"（并入前提 7）。

### 10.3 规模轴推演

| 增长轴 | Taric 机制如何响应 | 拐点 |
|---|---|---|
| 资产 10 → 10,000 | 按任务/资源分片查询并限制 Pack 预算；记录和覆盖状态持久化 | 覆盖 cell 组合爆炸及索引/查询成本；实际容量需部署压测（前提 4/5/8） |
| 时长 天 → 月 | resume delta 使上下文与时长**解耦**；Artifact 日期分片；增量对账 | 摘要沉淀质量（前提 3，宿主责任） |
| 并发 2 → 100 | 并发正确性 fixture 覆盖租约/CAS/fencing；模型和工具可并行 | 2 秒是指定 mutation 路径的 p95 目标，不能外推所有操作；锁等待和部署容量需实测（前提 8） |
| 宿主 1 → 多机器 | PostgreSQL 统一状态、有效租约与提交顺序，支持跨宿主复核和过期后接管 | 全局目标资源约束、原文路由、宿主钩子、数据库网络与可用性（§7.3、§8.4、§11） |
| 幻觉率恒定部分 | 被治理层全量吸收（L0/L1 隔离） | 注意力遗漏随规模上升 → 覆盖矩阵 + observer 交叉兜底 |

### 10.4 宿主工程前提清单（能力达成的组成部分）

| # | 前提 | 对应残余风险 | 具体动作 |
|---|---|---|---|
| 1 | 预算校准表 | 字符预算 ≠ token | 按模型设定 Pack 预算上限并纳入配置管理 |
| 2 | omitted 消费纪律 | 可见遗漏未被消费 | 调度器把"翻页完成 omitted_ranges"纳入规划验收 |
| 3 | 资源摘要沉淀 | 无自动摘要 | 资产级摘要作为 L2 记录入库；planner 按资源分片查询 |
| 4 | 资产发现入池 | 资源清单完备性 | 发现/枚举任务进 WorkItem 池并受覆盖追踪 |
| 5 | 复核吞吐与独立性 | L1 积压、同源误读 | 观察者巡查周期与 Finding 产出速率匹配；高危异构/deterministic/人工 reviewer 显式启用 |
| 6 | checkpoint 频率 | 终止损失窗口 | 每工具动作/步骤后提交 checkpoint |
| 7 | 协调备份与诊断 | 灾备、状态漂移 | 例行 `audit.doctor`；验证数据库与各 spool 的匹配恢复；逻辑导出另作迁移用途 |
| 8 | 接入模型与容量 | 写争用、网络延迟、维护开销 | 本机统一受信任接入；异步调用；隔离维护进程；按真实并发测量锁等待/吞吐/p95，多机落实全局调度与文件路由 |

缺项时对应残余风险回到未缓解状态；八项全部落地后，§10.2 的残余缺口均有抓手。

### 10.5 最终判定表

| 风险 | Taric 消除的根因 | 残余风险 | 兜底责任（前提 #） |
|---|---|---|---|
| 上下文溢出→幻觉→偏差 | 溢出 fail closed、增量上下文、最小投影、零直写、宿主代写观察 | 字符≠token；omitted 不强制消费；无自动摘要 | 宿主（1/2/3） |
| 漏报 | 覆盖矩阵持久化、未测可见、阴性有界、观察者交叉 | 资源发现完备性、L1 复核积压、维度裁剪 | 宿主（4/5） |
| 误报 | 五硬门 fail closed、证据钉版本、L1 隔离、独立/异构复核 | 同源误读（可配置缓解） | 宿主（5） |
| 异常终止 | checkpoint/resume、fencing、事务原子性、doctor/reconcile、幂等 | checkpoint 粒度、新 Attempt 恢复校验、原文访问、协调备份与写入容量 | 宿主（6/7/8） |

### 10.6 验证方法

- **规模压测**：复用 Taric `artifact-scale` 模式，扩展为资产数 × 任务时长的矩阵压测（合成 fixture；100GiB/跨 7 天已有先例），检查有界内存、keyset 分页和已知引用读取不扫描无关 payload；mutation→query 的 p95 目标单独评估，Artifact 上传/导出记录独立延迟、吞吐与峰值内存。
- **故障注入演练**：执行者崩溃/reclaim/迟到结果、证据篡改、预算不足、审计链断裂、Artifact 发布中断后重启恢复。
- **度量指标**：漏报率（金标资产集）、L1 积压时长分布、resume 成功率、未授权 L2 = 0、纠偏闭环时延。
- **纳入门槛**：以上作为 §11 P5 阶段的验收项，未通过则长周期大量资产能力判定不成立。

## 11. 宿主采用与多主机验收路线（五阶段）

以下阶段描述采用 Taric 的宿主侧工作流和验收，不是 Taric 仍未实现的代码阶段。工作区测试通过不等于某个真实宿主或部署 profile 已验收。

| 阶段 | 内容 | 验收 |
|---|---|---|
| P1 只读黑板 | 初始化 Engagement/会话绑定；三类智能体经 MCP `context.query/resource.query/evidence.query` 读取状态 | 各角色 Pack 正确、无跨 Engagement 泄漏 |
| P2 提案闭环 | planner 提交 WorkItem 提案 → 宿主 admission；执行者提交 claim 提案；observer `review.submit` | L0→L1 流转、提案不可直写权威、审计链完整 |
| P3 执行协作 + Artifact | work.claim/renew/reclaim、action 三模式、capture.observation、artifact 三段上传、checkpoint 提交/恢复 | 两个执行者并发无冲突任务、fencing 拒绝 stale 写、原文默认不出现在任何模型视图 |
| P4 观察纠偏 + 质量门槛 | observer 异常检测矩阵、resource.impact 传播、独立复核与显式 L2 promotion、audit.doctor/reconcile 例行化 | 纠偏闭环演示、高危 Finding 无独立复核不进 L2、崩溃恢复演练通过 |
| P5 规模与韧性验证 | §10.4 八项前提落地；资产规模 × 时长矩阵压测、故障注入演练、金标集漏报率评估 | 漏报率、L1 积压、纠偏时延达到约定阈值；符合恢复前提的用例全部通过，前提失效的用例全部阻塞；未授权 L2=0；指定 mutation p95 目标≤2s |

每阶段结束跑 `npm test`（schema/Core/CLI/MCP/adapter/projection/artifact-scale）与 `audit.doctor`，确认无权威漂移。

### 11.1 多主机部署与真实宿主验收

先完成上述工作流闭环，再增加机器数量；已有完整宿主的项目可直接进入以下步骤，无需重复实现 Core 治理逻辑。

1. **部署与一致性**：准备共同 PostgreSQL authority，初始化 schema；按 §4.3 生成匹配构建的 conformance 报告并启动至少两个真实宿主。检查 backend、authority 目标、schema/policy、host 身份、server-side lease 和 enabled 状态。
2. **共享记忆与跨宿主审核**：A 提交观察/覆盖和提案，B 在新查询中按权限看见；验证 L0 不泄漏、L1 只按候选可见、L2 必须经过独立 review 与授权 promotion；不同 Engagement 仍隔离。
3. **任务竞争与全局配额**：A/B 同时认领同一个 WorkItem，断言只有一个有效 owner；不同任务影响同一目标时，验证宿主全局互斥/限速真的生效。测试 claim/CAS 冲突后重新查询，避免静默覆盖。
4. **跨机接管**：A 提交 checkpoint 后中断；B 不能在有效租约内强抢，过期后可取得新 generation。检查历史 checkpoint 因旧 Attempt 不匹配时正确阻塞，再完成前提核验与当前恢复边界重建。A 恢复后的旧代写入应被拒绝/隔离；unknown 外部动作不得被自动重放。
5. **证据访问与故障**：A 上传的元数据在 B 可见，但本地无原文时返回明确的不可用结果；验证经宿主路由访问原 spool 的授权与哈希。演练 PostgreSQL 断连、续租失败、发布中断和文件损坏，确认停派、不回退 SQLite、不把损坏内容标可用。
6. **恢复与容量**：在隔离目标恢复数据库及匹配 spool，校验序列、审计和内容，重新签发租约。记录真实机器数量、网络延迟、并发 worker、事务锁等待、吞吐、mutation p95、Artifact 内存与延迟、接管时长及人工处理项。

验收报告应区分“共享 Core 功能通过”“各宿主生命周期已接通”“目标部署容量已测得”。仓库现有 PostgreSQL 功能报告不能替代这三项真实集成结果。公开 `snapshot.import`/`migration` 不受支持，不能按“导出再公开导入”切换 SQLite 到 PostgreSQL。新部署可经正常 proposal/evidence 治理接入旧材料；必须保留 authority 历史时需单独设计并验证 operator 迁移流程。灾备使用隔离数据库恢复并协调 spool，见[运行手册](multi-host-authority-runbook.md)。

## 12. 边界与注意事项

1. **Taric 不是执行器**：并发资源池的分派、无冲突判定、工具调用、HITL 审批界面均在宿主；Taric 只提供租约/CAS/冲突队列等并发原语与状态事实。
2. **观察写入必须由宿主完成**：`capture.observation` 为 host-only；执行者智能体对观察结果只有提案权，防止模型输出直写事实层。
3. **L1 ≠ 事实**：机审候选默认不进普通召回；高危 Finding 必须满足独立（可异构）复核才升 L2，观察者不可自审自己发起的提案。
4. **原文敏感**：spool 可能含凭据/Token/Cookie 字节；宿主须为内容根配置 ACL/加密卷并自定保留策略——Taric 不脱敏、不扫描、不自动删除。
5. **异步接口与写入容量分开**：Core 调用使用 `await`；SQLite 单写者、PostgreSQL schema 级写事务锁及文件操作仍有容量边界，按 §10.4 前提 8 实测。
6. **隐藏推理不入库**：checkpoint 契约剥离 reasoning/chain_of_thought 等字段；恢复依据是可验证的步骤/引用/工具结果，不是模型自述。
7. **宿主框架 hooks 非必需**：本方案以 MCP + 宿主内嵌 Core 为主通道，不依赖 Pi/Hermes/DeepSeek 原生生命周期；智能渗透测试系统作为独立宿主，直接内嵌 `@taric/core` 即可。
8. **§10.4 八项前提是能力达成的组成部分**：缺项时对应残余风险回到未缓解状态；P5 验收即是对前提落地与残余风险可控性的实证。
9. **共享数据库不自动完成协作**：宿主负责待办发现、全局资源约束、续租、上下文刷新、工具停派和结果回传；多宿主按同一 Engagement 与权限协作，不自动跨项目汇聚数据。
10. **接管不等于外部动作恰好一次**：generation 约束 authority 写入，不能撤销外部请求；旧检查点、新 Attempt、未知动作和本地证据都需校验，阻塞时由宿主/operator 处理。
11. **数据库与原文分别恢复**：PostgreSQL 不同步本地 spool、浏览器会话或凭据；数据库不可用时阻塞共享运行时，文件不可用时明确报告，不启用独立 SQLite 副本冒充共享 authority。

## 13. 端到端示例（浓缩时序）

### 13.1 单宿主协作闭环

```text
operator  engagement.init; artifact.session.bind
planner   context.query ──▶ proposal.submit(work_item ×3：R-api/静态资产/身份端点)
host      admission.evaluate ×3 ──▶ 任务池 L1
host      work.claim(W-api→executor-1) ─ work.claim(W-static→executor-2)   ← 资源不相交，并发 2
executor-1 context.query(run) ─▶ action.recommend(GET /api/users)
host      host-decision(authorized_autonomous) ─▶ 执行 curl ─▶ artifact begin/append/commit
          ─▶ capture.observation(evidence→content_ref) ─▶ checkpoint.commit
executor-2 同上（静态资产枚举，产出截图 binary Artifact + 阴性观察）
observer  context.query ──▶ 发现 executor-2 触发 WAF challenge 干扰 executor-1 前提
          ─▶ action.recommend(pause W-static) ─▶ review(needs_evidence, 可疑claim)
host      host-decision(deny→pause) ─▶ 停派/停止工具，过期后才可 reclaim ─▶ resource.impact(旧claim)
          ─▶ 重验 WorkItem 入池
planner   下一轮 context.query 冲突/缺口 ──▶ 重排：低噪音方法、错峰窗口
executor-1 proposal.submit(finding: IDOR) ─▶ host admission(L1) ─▶ observer review(pass,独立)
writer    admission.promote_l2（固定提案/证据/版本/审核）─▶ L2 Finding
          （引用 HTTP 交换 Artifact 元数据，原文留在 spool 供 operator 导出）
operator  artifact.session.output(include_content) ──▶ 分页导出全部原文 ──▶ 交付/复盘
```

该示例覆盖：纯提案规划、并发认领、三模式动作、原文落盘与 fence、观察纠偏闭环、影响传播、信任升级与最终取证导出——即本方案要求的三智能体黑板协作全链路，也是 §10 能力评估所依赖机制的最小完整闭环。

### 13.2 多宿主共享、接管与独立复核

```text
operator   部署共同 PostgreSQL，初始化 schema，验证并启用当前构建
host-A/B/C 各自启动本机 Core；共同 Engagement，独立 principal 与 session/spool
host-A     资产发现 → capture.observation / 覆盖更新 → 工具原文留在 spool-A
planner-C  新 context.query → 读取已提交资源与覆盖 → 提交验证 WorkItem 提案
operator   admission.evaluate → L1 任务；调度器显式读取候选并检查全局资源配额
host-A/B   竞争同一 work.claim → B 成功，A 收到冲突后选择其他任务
host-B     构建 Pack → 工具验证 → spool-B 上传 → 观察/证据 → checkpoint.commit
           B 中断，不能续租
host-A     租约过期后 work.reclaim → 新 Attempt / generation
           work.resume → 历史 checkpoint 存在，但旧 Attempt/动作等前提需重新核验
           获取所需证据（经宿主路由到 B 的 spool，不能假定本地已有文件）
           对账未知动作；必要时重规划/后续 WorkRun 绑定 A 的新 session
           重建当前恢复边界、再次检查通过后继续；无法核实则保持 blocked
host-B     恢复后提交旧代 checkpoint/Artifact → stale 拒绝，不覆盖 A 的进度
executor-A 提交 Finding 提案 → operator admission.evaluate → L1
reviewer-C 固定 proposal/evidence 输入独立复核 → review.submit(pass)
writer     admission.promote_l2 → 硬门通过后写入 L2；各宿主新查询可按权限读取
operator   核对全局审计/覆盖，分别导出各宿主内容，协调数据库与 spool 备份
```

此流程的共同记忆、任务归属和恢复依据由 Taric/PostgreSQL 提供；规划调度、跨机原文路由、工具执行与授权由宿主落实。只有通过 §11.1 的真实宿主验收后，才能声明对应部署具备完整的分布式协作能力。

## 14. BreachWeave 集成案例（真实宿主映射）

本节以 [BreachWeave](https://github.com/m-sec-org/BreachWeave) 当时的公开仓库和工作区快照作为第三方宿主样本，记录具体文件、进程与数据映射；该宿主未在本轮重新走读。下列代码行、运行时和集成差距均属历史推演，不能直接当作 BreachWeave 当前代码状态。本文仓库没有真实 BreachWeave 部署验收；任何已接入结论仍需按 §11.1 在真实部署上验收。

### 14.1 推演基线与宿主画像

| 项 | BreachWeave 现状（源码核验） | 对 Taric 集成的含义 |
|---|---|---|
| 运行时（历史基线） | Bun monorepo；当时由 `bun run web` / `bun build --compile` 产出容器内 Linux 二进制 | 当时 Taric Core 依赖 Node SQLite，Bun 进程内嵌不可行。当前已提供独立 `@taric/driver-bun-sqlite`；1.0.0 tarball consumer 通过，但该宿主没有实际 Bun 内嵌验收。 |
| 角色架构 | `Manager/Planner/Solver/Observer`；Solver 是 Docker 容器内的 `pi-coding-agent` 会话 | 规划者/执行者/观察者三类 LLM 天然对应 §1.1 |
| Solver 通信 | 宿主机 ↔ 容器 stdin/stdout JSONL RPC（`runtime.ts:783-881`）；容器内还有一条 `host_bridge_request` 通道回宿主机（`host-bridge-client.ts:20-48`） | stdio 已被宿主自有协议占用，**MCP stdio 不能复用该流**；容器内需要独立进程 |
| 共享记忆 | 项目级 `Memory`（`fact/evidence/failure/note/hint`）与 `Idea`（`pending/testing/verified/failed/skipped`），一条一 JSON 文件 + 目录锁 | 结构上接近 Taric 的 Observation/Evidence/Claim/TestHypothesis，但**无准入、无信任分级、无证据硬门** |
| 资产状态 | `{ asset, asset_hash, scanned: boolean }`；报告提交即 `scanned = true`，全量 `scanned` 即项目完成（`store.ts:29-33`、`store.ts:479-483`、`manager.ts:1260-1281`） | 覆盖矩阵的最小映射对象；`scanned` 必须升级为 `CoverageCell` |
| 并发控制 | 目录锁 + 60s 陈旧锁强删（`store.ts:139-172`） | 无租约、无 generation、无 CAS；由 Taric 补齐 |
| 模型生态（历史基线） | 当时观察到 `@mariozechner/pi-coding-agent@^0.65` 与 Taric 锁定的分发不同 | 不据此断言该宿主当前仍使用此版本；Taric 原生 Pi 认证只适用于 compatibility manifest 明列的 package/distribution/version/commit，具体组合需单独认证。 |
| 容器基础镜像（历史基线） | 当时观察到 Kali + Node 20（该宿主快照的 `Dockerfile` 行号见原报告） | Node 20 与 22 的运行行为需在真实镜像验证。当前 Bun SQLite driver 不要求用 Node SQLite；不能再据旧 Node 版本推出容器内 MCP 必须升级到某个版本。 |

历史基线提交：BreachWeave `6957a55`（`pentest` 分支，2026-10-09），Taric 当时工作区。该基线不代表任一仓库当前 HEAD。

### 14.2 拓扑选项：Node 桥与 Bun 内嵌的当前边界

原方案把 Node 桥作为当时唯一可运行路线。当前 Taric 提供 Bun SQLite driver 和多 principal gateway，并支持可选 TLS TCP/HTTPS；下表说明当前可选拓扑及尚未认证的宿主路径：

| 拓扑 | 做法 | 结论 |
|---|---|---|
| A. Bun 进程内嵌 Core | `@taric/core` + `@taric/driver-bun-sqlite`，经 `openRuntimeService` 配置驱动 | 当前代码可用；五个 tarball 的独立 consumer 验证通过。BreachWeave 尚未验证包消费、权限和重启。 |
| B. Node 桥进程 + gateway | Node Core；可选 Unix socket、TLS TCP 或 HTTPS，多 principal 由 `taric gateway` token resolver 映射 | 本机 gateway transport 有合同和 loopback 端到端测试；生产网络部署、具体宿主配置、token 轮换/撤销运维及跨机故障恢复仍未验收。 |
| C. `taric proxy` | CLI proxy 固定单一 host principal；多角色需分开可信入口或使用 gateway | 对单 host principal 本机桥接有验证；自身不表达 reviewer/writer/operator 多身份。transport session 可供 host-session/run-bound 归属，不替代宿主身份映射。 |

在未完成真实宿主验收前，不对某一拓扑作 BreachWeave 适用性结论。TLS TCP/HTTPS 是已实现且经本机 loopback 测试的可选 transport；生产网络部署仍待环境验收。Bun driver 是可选进程内能力。

下图保留当时 Node bridge 方案作为可读的参考拓扑，不表示它是当前唯一可行方案；`taric gateway` 可解析多 principal，单 principal `taric proxy` 则仅代表 host 身份。

```text
┌─────────────────────── 宿主机（Bun）───────────────────────┐
│ ChallengeManager / Planner 调度 / Web UI / Solver 容器管理   │
│        │ 本机 Unix socket（JSON-RPC + token，动作白名单）    │
│        ▼                                                    │
│ ┌──────────────── taric-bridge（独立 Node 22.21.1 进程）──┐ │
│ │ 内嵌 @taric/core（openRuntimeService）                  │ │
│ │ principals: bw-host / bw-operator / bw-writer /         │ │
│ │             bw-reviewer-N / bw-planner（每项目）         │ │
│ │ 负责：work.claim / capture / artifact / checkpoint /    │ │
│ │       admission / review / promote / coverage gate      │ │
│ └───────────────┬─────────────────────────┬───────────────┘ │
│                 │ SQLite WAL（单机）       │ Content spool   │
└─────────────────┼─────────────────────────┼─────────────────┘
                  │                         │
      ┌───────────▼──────────┐   ┌──────────▼───────────┐
      │ taric-mcp（Node）     │   │ 工具原始输出写入位置  │
      │ 每 solver 一个进程    │   │ （HTTP/扫描器/截图）  │
      │ model 身份，6 工具    │   └──────────────────────┘
      └───────────┬──────────┘
                  │ MCP stdio（容器内独立进程，不复用宿主 JSONL）
                  ▼
        Solver 容器（只拿 model principal + Engagement）
```

关键边界：

- **bridge 持有全部非模型凭据**。host/operator/writer/reviewer 只存在于 bridge；Solver 容器里的 MCP 进程只有 model principal，它**能提交提案但不能晋升、不能捕获观察、不能落 Artifact**。
- **原文由宿主写**。Solver 的工具输出已经通过 JSONL 回到宿主机（`runtime.ts:783-881`），bridge 依据真实字节写 Artifact；容器内不做 Artifact 上传，也不挂载 content root。
- **每个 solver 一个 MCP 子进程**，principal 形如 `bw-solver-<solverId>`；这与 §4.1 的每实例独立身份一致。
- **容器内 MCP 必须能打开同一 authority**：`proposal.submit`/`checkpoint.propose`/`action.recommend` 都是 authority 写入，`taric-mcp` 启动时会用 `TARIC_DB`（或配置文件）自行打开它（`server.ts:runMcpStdio` → `openRuntimeService`）。因此容器需要以可写方式访问该 SQLite 文件。这带来一个必须显式决策的边界：
  - 方案 B1（简单）：把 authority SQLite 文件 bind mount 进容器（同一台机器上的本地文件系统，不是 NFS），bridge 与 MCP 共享同一 WAL。可用，但意味着模型进程能读写 DB 文件——Taric 的角色/能力检查仍在，但**文件级隔离消失**。
  - 方案 B2（更严）：容器内只放一个 stdio MCP 转发器，把 JSON-RPC 行经宿主自有 RPC 转给宿主机上的 `taric-mcp`；authority 与 spool 从不进入容器。代价是 BreachWeave 需要实现一条 MCP 转发通道（§14.5 第 15 项）。
  - 本文推荐 **B2**；若先做 B1，必须在验收记录中写明“模型容器可读 authority 文件”这一事实，不能宣称已隔离。
- 单机用 SQLite WAL 时，bridge + N 个 MCP 进程会同时写同一 authority；Taric 支持该进程模型，但写入串行化，必须按 §10.4 前提 8 实测。**不要把该 SQLite 文件放到 NFS 或多台机器共享**（`deployment-guard.ts` 明确拒绝共享 SQLite authority）。

### 14.3 角色与 principal 映射

| BreachWeave 角色 | Taric principal | Role | 通道 | 只允许做什么 |
|---|---|---|---|---|
| Planner（全局调度 LLM） | `bw-planner`（或按项目 `bw-planner-<project>`） | model | MCP 或 bridge 注入 | 读 Context、提交 WorkItem/假设/纠偏提案；**不再直接启动容器** |
| Solver 主会话 | `bw-solver-<solverId>` | model | MCP stdio（容器内） | `context.query`、`proposal.submit`、`checkpoint.propose`、`action.recommend` |
| Observer sidecar（LLM） | `bw-observer` | model | MCP 或 bridge | 读全局状态、提交 memory/idea 提案（L0）、不能晋升 |
| Observer 评审通道 | `bw-reviewer-1..N` | reviewer | bridge 内进程（需 attestation） | `review.submit`；与 observer 模型身份分离 |
| ChallengeManager / Planner 工具执行 | `bw-host` | host | bridge | 认领/续租、观察捕获、Artifact 落盘、checkpoint.commit、动作决定/结果 |
| 报告闸门 / L2 晋升 | `bw-writer` | writer | bridge | `admission.promote_l2`（仅 Finding） |
| Web 运维面 / 初始化 | `bw-operator` | operator | bridge/CLI | `engagement.init`、admission、审计、导出 |

约束与现状差异：

- BreachWeave 的 Observer 当前通过 `challenge_memory_add` **直接写**项目共享记忆（`tools.ts:299-309` → `host-bridge-handler.ts:161-171` → `manager.ts:1345-1350`），宿主只做非空/枚举校验。接入 Taric 后这条路径必须改成**提案**：Observer 的结论是“对执行轨迹的判断”，不是工具字节，因此应提交 `claim` / `test_hypothesis` / `negative_observation` 提案，由 host admission 进入 L1；幻觉无法再直接进入共享层。
- `reviewer` 的 attestation 必须来自宿主的可信配置/传输，不能由模型结果自报。当前 review CLI 可从可信环境配置读取 reviewer ID/attestation，并只转交宿主/operator 准备的外部结果；旧稿“CLI 固定传 undefined、reviewer 必须在 bridge 内创建”是历史实现判断。gateway resolver 也可将 token 映射到身份与 session，凭据保管仍由宿主负责。
- 多项目 Planner 的横切视图：Taric 的 `context.query` 按 Engagement 绑定且 principal 固定（`service.ts:1211`）。BreachWeave 的 Planner 一次看 3 个活跃项目，因此有两种落地方式，二选一：
  1. **推荐**：bridge 以 operator 身份分别读取各 Engagement，拼成一份宿主侧快照注入 Planner；Planner 输出结构化 WorkItem 建议，由 bridge 写入对应 Engagement。代价是 Planner 不再是严格的 Taric model principal，但归属仍由宿主代写，审计真实。
  2. 每项目一个 Planner model 进程，跨项目调度退回宿主的确定性调度器。

### 14.4 数据模型映射

| BreachWeave 对象 | Taric 实体 | 写入路径 | 说明 |
|---|---|---|---|
| Challenge 项目 | `Engagement` + `Scope` | operator `engagement.init` | 一个项目一个 Engagement，禁止跨项目共享 |
| URL / IP 资产 | `Resource`（`asset_type: endpoint/host`）+ `ResourceRevision` | host `proposal.submit(resource)` → `admission.evaluate` | `asset_hash` 保留为 `identity` 的稳定字段，但不再是唯一真相 |
| `scanned: boolean` | `CoverageCell.status` | host `proposal.submit(coverage)` → admission | `not_tested/positive/blocked/inconclusive/...` 替代布尔；项目完成改用覆盖闸门 |
| `coverage_gaps`（标量 0–100） | 覆盖矩阵 + `coverage.gate` / `coverage.query` | host/operator 经公开 dispatch 获取 gate 与分页 cells | 不再折叠为分数；`not_tested`/`blocked` 强制可见。Gate 是状态结果，不代替宿主关闭 Engagement。 |
| `MemoryEntry.kind = fact` | `Observation` / `Claim` | host `capture.observation`（工具字节）/ model `proposal.submit(claim)` | fact 必须区分“工具观察到”与“模型归纳” |
| `kind = evidence` | `Evidence`（引用 content_ref） | host `proposal.submit(evidence)` | 必须挂 Artifact 引用，不接受裸字符串 |
| `kind = failure` | `NegativeObservation` | host `proposal.submit(negative_observation)` → admission | 需 method/conditions/limitations/baseline 或 control，schema 强制 |
| `kind = hint` | `Observation`（来源=外部 hint） | host capture | 记录来源与限制，不当作已验证事实 |
| `kind = note` | `Claim`（`status: proposed`） | model proposal | 主观记录默认 L0/L1，不进普通召回 |
| `Idea.status` | `TestHypothesis.status` | model `proposal.submit(test_hypothesis)` | `pending/testing→proposed`、`failed→contradicted`、`skipped→inconclusive`；**`verified` 不能映射为 `supported`**：`validateProposalCandidate` 直接拒绝 `supported/verified`（`validation.ts:64-65`）。`Idea.verified` 只能拆成“证据 + Claim”，经 L2 复核后由 Finding 承载 |
| 报告提交（Markdown） | `Artifact`（report）+ `Claim` + `Finding(draft)` + `CoverageCell(positive)` | host artifact → model/host proposal → admission | 报告文本进 spool；Finding 至少引用一个 Claim（schema `claim_refs` minItems 1），Claim 再引用 Evidence；不能“提交即事实” |
| Attempt 日志 | `WorkRun` / `Attempt` | host `work.claim` | `solver_id` → `agent_id`；一个 WorkItem 同时至多一个有效租约 |
| Solver 会话 JSONL / 工具结果 | `Artifact` | host `artifact.store.begin/append/commit` | 大文件用 `storage_mode: external` + `host_ref`，Taric 只存元数据 |
| Planner 上一轮摘要 | `Observation` 或 `Checkpoint` 附件 | host capture | 不能作为模型上下文直灌；下轮经 `context.query` 读取 |
| 目录锁 | Taric 租约 + CAS + PatchSet | host/model | 删除 `withDirectoryLock` 路径，禁止两套并发语义并存 |

注意两点 schema 事实：

- 普通 `observation` **没有** `conditions` / `evidence_refs` 字段；未复现、被 WAF 拦截等必须用 `negative_observation` / `control_observation` / `access_decision_observation`（`taric-api.md` 同款约束）。
- `CoverageCell` 的 `positive` 状态若无 `evidence_refs`，覆盖闸门会判为 `unverified_positive`（`coverage.ts:167-185`）；因此“报告提交”必须同时落 Artifact 与证据引用。

### 14.5 BreachWeave 侧改造点（文件级）

| # | 文件/位置 | 现状 | 改造 |
|---|---|---|---|
| 1 | `packages/core/src/runtime/runtime.ts:485-563` `launch()` | 只传 `TCH_CHALLENGE_ID` | 增加 `TARIC_PRINCIPAL_ID`、`TARIC_ENGAGEMENT_ID`、`TARIC_DB` 只读挂载；MCP 进程通过独立 `mcp.json` 启动 |
| 2 | `runtime.ts:761-771` `buildSolverRpcCommand` | 用 `--env` 传 solver 环境 | 复用同一注入点；**不要**把 `TARIC_ADAPTER_TOKEN` 或 content root 传给容器 |
| 3 | `runtime/assets/Dockerfile:124-125` | Node 20 | 升级到 Node 22.21.1（或不小于 Taric 验证版本），否则 `taric-mcp` 无法启动 |
| 4 | `packages/core/src/config/index.ts:1040-1049` | 已支持每个 prompt 的 `mcps` 白名单 | 为 solver prompt 增加 `mcps: ["taric"]`；MCP 配置指向容器内 `taric-mcp` |
| 5 | `challenge/host-bridge-handler.ts:112-195` | 项目状态/记忆/报告直写 | 新增 bridge action：`taric_context_query`、`taric_evidence_query`、`taric_proposal_submit`；旧 `challenge_memory_add` 改为“提案 → 宿主 admission” |
| 6 | `challenge/manager.ts:1260-1281` `submitReport` | 提交即 `scanned=true` | 拆成：Artifact 落盘 → Evidence/Claim 提案 → Finding(draft) → CoverageCell(positive) 提案 → 覆盖闸门 |
| 7 | `challenge/store.ts:479-483` `computeChallengeCompleted` | 全量 `scanned` 即完成 | 改为覆盖闸门结果；`scanned` 字段删除，不做兼容 |
| 8 | `challenge/manager.ts:1345-1350` `appendMemory/addIdea` | 直接写共享层 + 广播 | 删除广播注入；Observer 输出改为提案，宿主 admission 后由 `context.query` 自然可见 |
| 9 | `solver/extension/challenge-observer/tools.ts:299-309` | `publish_to_challenge` 走 `challenge_memory_add` | 改为提交 `claim/test_hypothesis/negative_observation` 提案；本地 board 可保留为草稿 |
| 10 | `challenge/manager.ts:1666-1798` `planner_launch_solver` | Planner LLM 直接启动容器 | 改为 WorkItem 提案；容器启动改由宿主调度器在 `admission.evaluate` 后执行 |
| 11 | `solver/extension/challenge-observer/observer-loop.ts:9-13` | 6 轮/`agent_end` 触发 LLM 复核 | 保留触发节奏；每轮结论提交提案，不再直接改共享层 |
| 12 | `challenge/store.ts:139-172` | 目录锁 | 删除；并发交给 Taric 租约/CAS/PatchSet |
| 13 | `runtime.ts:783-881` `readStream` | 解析 `AgentSessionEvent` | 在 `tool_execution_end` 处调用 bridge 写 Artifact；HTTP 请求/响应各一个子 Artifact |
| 14 | 新增 `packages/taric-bridge/` | 无 | 独立 Node 进程：`openRuntimeService` + 本机 socket + 动作白名单 + principal 构造 |
| 15 | 新增容器内 MCP 转发器（若选 B2） | 无 | stdio 与宿主 RPC 之间的 JSON-RPC 行转发；容器内不挂载 authority/spool |

bridge 的最小动作集（对应 §5 的 A～E 路径）：

```text
读：context.query / resource.query / evidence.query / proposal.list
写：proposal.submit / capture.observation / work.claim / work.renew /
    work.reclaim / checkpoint.commit / action.host-decision / action.host-result
原文：artifact.session.bind / artifact.store.begin|append|commit / artifact.content.read
治理：admission.evaluate / review.submit / admission.promote_l2
运维：audit.doctor / audit.reconcile / host.state
```

bridge 的 RPC 请求形如 `{action, principal, request}`，但 **principal 由 bridge 按调用方会话查表得出**，请求体不能自选身份；Bun 侧只能提交 `solverId`/`challengeId` 这类业务标识。

### 14.6 端到端时序（BreachWeave 版）

```text
operator   engagement.init(scope = 项目允许/排除目标 + ROE 引用)
operator   artifact.session.bind(host-session, root=<content>/<engagement>)
host       资产导入：proposal.submit(resource) ×N → admission.evaluate → L1
                       ↓
planner    （bridge 注入各 Engagement 快照）→ proposal.submit(work_item) ×M
host       admission.evaluate → 任务池 L1
host       调度器选无冲突 WorkItem → work.claim(agent_id=solverId)
           artifact.session.bind(run-bound, run/attempt/generation)   ← 每个 run 独立 session
host       launch solver 容器（MCP stdio 独立进程，model principal）
solver     context.query(work_item_id) → action.recommend(工具动作建议)
host       策略/审批 → 执行工具 → tool_execution_end
host       artifact.store.begin/append/commit（原始字节）
           capture.observation(artifact_refs) → admission.evaluate
host       coverage 提案（positive/blocked/not_tested）→ admission
solver     checkpoint.propose → host checkpoint.commit（每个工具动作后）
observer   读取轨迹 + evidence 元数据 → 可疑结论 review.submit(needs_evidence)
           纠偏建议 → proposal.submit(claim/负向观察)
solver     challenge_submit_report → 报告 Artifact + Finding(draft) 提案
host       admission.evaluate → L1（默认不进普通召回）
reviewer   review.submit(pass, 固定 input/evidence/policy)
writer     admission.promote_l2 → L2 Finding
host       覆盖闸门 evaluateCoverageGate → can_close 才结束项目
operator   audit.verify / snapshot.export / 导出原文
```

与 §13.1 的差异只有三处：**报告不再翻转布尔**、**Observer 不再直写**、**Planner 不再直接启动容器**。这三点正是 Taric 结构性防护在真实宿主上的落点。

### 14.7 阶段验收（对应 §11）

| 阶段 | BreachWeave 验收动作 | 通过标准 |
|---|---|---|
| P1 只读黑板 | Planner/Observer 进程接 MCP，`context.query` 读取项目与覆盖 | Pack 只含本项目；无跨项目泄漏；`omitted` 可见 |
| P2 提案闭环 | Observer `publish_to_challenge` 改为提案；Planner 输出 WorkItem 提案 | 共享层不再出现无证据直写；拒绝原因可查 |
| P3 执行协作 | `work.claim` + run-bound bind + Artifact 三段上传 + checkpoint | 两个 solver 并发无冲突；reclaim 后旧代上传被 `stale_version` 拒绝 |
| P4 观察纠偏 + 质量门槛 | 独立 reviewer + writer 晋升；覆盖闸门替换 `scanned` | 高危 Finding 无独立复核不进 L2；`can_close=false` 时项目不结束 |
| P5 规模与韧性 | 多项目/多机 PG；故障注入 | 按 §10.4 八项前提与 §11.1 报告 |

### 14.8 历史宿主基线差距与当前 Taric 状态

以下记录来自 2026-10-09 两侧源码快照，保留用于复现当时的集成分析；其中 Taric 实现差距已变化，BreachWeave 侧代码判断没有在本轮重新验证。

| # | 历史事实（2026-10-09） | 当时的影响与处置 |
|---|---|---|
| 1 | `packages/core/src/sql-driver.ts:3` 硬依赖 `node:sqlite`；Bun 无此内置模块 | 必须使用 Node bridge（§14.2 B）；不要在 Bun 内尝试 polyfill |
| 2 | BreachWeave 镜像 Node 20（`Dockerfile:124-125`） | 容器内 `taric-mcp` 无法运行；升级镜像并重新验证 |
| 3 | MCP `context.query` 接受 `work_run_id` 但 Core builder 不消费（`server.ts:6`） | 运行归属必须由宿主在 `checkpoint/action` 调用中携带；任务定位用 `work_item_id` |
| 4 | MCP `action.recommend` 无 `generation` 字段（`server.ts:11`） | run 作用域的动作建议只能走 bridge/host 路径 |
| 5 | CLI 构造 principal 时不传 reviewer attestation（`cli.ts:95`） | reviewer 身份只能由 bridge 进程内 `createPrincipal(..., attestation)` 提供 |
| 6 | `admission.promote_l2` 仅接受 `subject_type=finding`（`store.ts:3399`） | 不要把 Claim/TestHypothesis 直接晋升；它们停留在 L1 |
| 7 | 操作注册表无 WorkRun 状态迁移（`registry.ts:103-106` 只有 claim/renew/reclaim/resume） | WorkItem 完成走 `proposal.submit(work_item)` 更新 + `admission.evaluate`；WorkRun/Attempt 的终态迁移当前只能由持有 `AuthorityStore` 的受信任进程调用 `transitionWorkRun`（`store.ts:2937`），不是公开 dispatch 操作。bridge 若只持有 `CoreService`，应把“运行完成”表达为 WorkItem 状态与 checkpoint，而不是伪造 WorkRun 终态 |
| 8 | run-bound 会话要求 claim 后绑定；已绑定的 host-session **不能**升级为 run-bound（`artifact-content-store.ts:190-219`，测试 `artifact-content.test.mjs:211-215`） | 每个 solver 用独立 session id；bridge 不要复用同一 session 跨 run |
| 9 | 带 `TARIC_SESSION_ID` 的 proxy 在 claim 时会写 `task_session_ref`，而 claim 要求该 session 已注册（`store.ts:2479-2483`） | 推荐 bridge 不设全局 transport session，按 run 显式 bind；或用每 run 独立 principal |
| 10 | `artifact.store.begin` 的 `summary` 字段拒绝 URL/token/secret 字样（`artifact-content-store.ts:242`） | 摘要只写分类与状态，不把目标 URL 放进 summary |
| 11 | Artifact JSON-RPC 单行上限 1 MiB，普通 RPC 原文读 ≤512 KiB（`adapter-rpc.ts:11-13,198-207`） | 大文件用 `storage_mode: external` + `host_ref`，或 bridge 内直接调用 Core |
| 12 | `evaluateCoverageGate` 是库函数而非 dispatch 操作（`coverage.ts:167`，`index.ts` 导出） | bridge 读取 cells 后本地计算，或后续单独扩展操作面 |
| 13 | 现有 `computeChallengeCompleted` 与 `scanned` 是唯一完成判据 | 必须整体替换；新旧两套完成语义并存会产生“报告说完成、矩阵说未测”的矛盾 |

当前 Taric 状态校正：Bun SQLite driver 与 exports 已交付，独立 `1.0.0` tarball consumer 验证通过；`work.query` 与 `coverage.gate/query` 已进入 dispatch 并有 keyset/projection/同快照合同；`work.transition` 是公开操作；`artifact.ingest_file` 可在显式授权的绑定会话根内单 descriptor 读取并校验字节；review pack 固定 admission 输入，review CLI 不调用 provider。MCP 模型接口仍只有六个工具，不暴露 host-only 调度、审核或 Artifact 操作。以上是 Taric 本地能力和测试边界，不是 BreachWeave 当前版本的适配结论。

另外三条不属于 Taric 缺陷、但集成时必须由 BreachWeave 承担的责任：

1. **容器内 MCP 的进程与网络**：solver 容器需要能启动 Node 进程并访问 bridge/authority；若容器无网络或只读文件系统，只能改为“宿主代理 MCP”（§4.4 的 transport 边界）。
2. **Artifact 脱敏与保留**：spool 可能含 Cookie/Token 字节；Taric 不脱敏、不扫描、不删除，BreachWeave 必须自行配置 ACL 与保留策略。
3. **覆盖矩阵粒度**：资产 × 测试类别 × 身份 × 条件会组合爆炸；BreachWeave 需要先定义测试类别字典，否则矩阵会退化为噪声。

### 14.9 不该做的事

- **不要让 Solver 模型直接写 `challenge_memory_add`** 后再由宿主“补一个提案”：这会保留幻觉直写通道，等于放弃 Taric 的核心价值。
- **不要把 `scanned` 与 `CoverageCell` 双写**：两套完成判据必然漂移；按 AGENTS.md 的“无向后兼容”原则直接替换。
- **不要让 Observer 自审自己发起的提案**：independence 硬门会拒绝；需要独立 reviewer 身份。
- **不要把 authority DB 或 adapter token 挂进 solver 容器**：模型侧只应拿到 model principal 与 Engagement。
- **不要用 `snapshot.import` 迁移存量项目**：公开导入是 unsupported；存量资产/记忆应作为带 `observed_at` 与 `limitations` 的普通提案逐条进入治理链，且不得伪装成当前观察。
