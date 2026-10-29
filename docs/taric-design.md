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

Taric 是渗透测试智能体的长期记忆与协作组件。Engagement 是隔离单位；Core 管理版本化记录、Proposal/Review/Admission、覆盖、WorkRun/Attempt、checkpoint、动作状态、审计、Context 和可选 Artifact spool。宿主负责模型调用、worker 调度、真实工具执行、人工身份、动作授权及目标凭据的 ACL、加密、生命周期和内容保留策略。授权的目标系统认证材料可以作为 opaque Artifact 原文存取；连接 Taric 所需的 gateway、authority 和 TLS 配置凭据由宿主独立保管。

当前实现同时支持持久单机 SQLite 与显式启用的 PostgreSQL 共享 authority，两者复用同一套异步 Core 治理代码。CLI、MCP、原生 adapter 和本机 Node proxy 都调用 Core；PostgreSQL 不复制业务治理，Markdown/Git 不充当 authority。模型不能调用 writer/host/operator 路径，也不能自行声明已验证事实。

主要能力包括 L0/L1/L2 信任隔离、独立 Finding 晋升、不可变资源修订、关系与三方 patch、有界影响传播、运行租约与恢复、固定版本 Context、有界宿主状态轮询、分块原文存储及可重建投影。公开快照导入与通用迁移不受支持。

当前 root workspace 和 runtime components 均为 `1.0.2`，API `1.2.0`、schema `1.0.0`、authority storage `authority-storage/3` 不变。仓库中的[候选发布记录](../openspec/changes/harden-taric-authority-runtime/release-report.md)绑定的是较早的 dirty worktree，不是当前 `1.0.2` 发布证据；当前实现状态应对照源码、测试和下文注明的实际验证结果。

## 2. 技术栈

| 层 | 实际实现 |
|---|---|
| TypeScript | ESM、strict、target ES2022，`tsc` 分包构建 |
| Node.js | Node SQLite driver 在调用时才动态加载 `node:sqlite`；已验证 Node 22.21.1。使用 Bun 注入 Bun SQLite driver 时不加载 Node driver |
| SQLite | `DatabaseSync`、WAL；对外为异步方法，同进程按数据库文件排队 |
| PostgreSQL | `pg` 驱动，支持声明为 14～18；事务、服务端时钟与 schema 范围锁；布局 `authority-sql/4` |
| Schema | JSON Schema 2020-12、Ajv 与 ajv-formats；72 个 `$defs`，包含基础类型、领域及请求/响应定义，不等于 72 种领域记录 |
| Transport | CLI JSON、MCP stdio、本机 Unix socket JSON-RPC、独立 Artifact binary socket |
| 验证 | `node:test`、`assert/strict`；Hermes 插件使用 Python unittest |

`pg` 是已安装 workspace 依赖，但 SQLite 默认启动不加载 PG 驱动或连接数据库。Bun 可通过独立 Node proxy 接入，也可以选择 `@taric/driver-bun-sqlite@1.0.1` 进程内驱动；本次 `1.0.1` 包版本完成构建和 Bun driver 11 项验证，不代表 npm registry 发布或第三方宿主认证。

## 3. 仓库与代码结构

| 模块 | 职责与实现入口 |
|---|---|
| `packages/schemas` | [JSON Schema](../packages/schemas/schemas/v1/core.schema.json)、[操作注册表](../packages/schemas/src/registry.ts)、[TS 类型](../packages/schemas/src/types.ts) |
| `core/service.ts` | [公开 dispatch、身份与能力授权、请求校验及返回映射](../packages/core/src/service.ts) |
| `core/store.ts` | [共享治理与持久化](../packages/core/src/store.ts)：版本、CAS、admission、运行、审计、目录与有界读取 |
| `core/sql-driver.ts` / `sql-schema.ts` | [连接、队列、事务、SQL 方言与测量](../packages/core/src/sql-driver.ts)；[表和索引](../packages/core/src/sql-schema.ts) |
| `core/runtime-startup.ts` / `runtime-service.ts` | [配置发现与解析](../packages/core/src/runtime-startup.ts)；[SQLite/PG 服务构造和启用门](../packages/core/src/runtime-service.ts) |
| `core/postgres.ts` / `shared-runtime.ts` | PG readiness、共享后端合同、构造前及调用前健康校验 |
| `core/policy.ts` / `coverage.ts` | 非 LLM 晋升硬门、防护控制与访问决策观察 |
| `core/context.ts` / `cursor-key.ts` | [固定读取点与有界 Context](../packages/core/src/context.ts)；[authority/root 绑定的持久密钥](../packages/core/src/cursor-key.ts) |
| `core/artifact-content-store.ts` | [会话 spool、上传、发布、恢复、原文与目录读取](../packages/core/src/artifact-content-store.ts) |
| `core/projection.ts` | 白名单投影、generation 发布、本地 Git checkpoint、受控 remote callbacks |
| `core/adapter.ts` / `pi-adapter.ts` / `deepseek-adapter.ts` | 通用薄客户端、实例状态、锁定宿主合同及 hook 绑定 |
| `core/adapter-rpc.ts` | [固定 host principal 的本机 JSON/binary socket](../packages/core/src/adapter-rpc.ts) |
| `core/quality.ts` / `release-report.ts` | 确定性分层质量计算、来源校验及带 digest 的 release report |
| `core/quality-release-activation.ts` | 独立报告 pin、implementation/schema/policy digest 校验及质量 capability fail-closed activation |
| `core/implementation-digest.ts` | 当前 Core 实现摘要，用于 runtime quality evidence 绑定 |
| `packages/cli` | JSON 命令、文件流式 append、配置管理；[proxy.ts](../packages/cli/src/proxy.ts) 打开 Core 并监听本机 RPC |
| `packages/mcp` | [stdio server](../packages/mcp/src/server.ts)，固定六工具 |
| `packages/driver-bun-sqlite` | Bun `bun:sqlite` reference authority driver |
| `packages/hermes-plugin` | Python general plugin，经认证 Unix socket 调用 Core，不替换 MemoryProvider |

## 4. 核心设计决策

### 4.1 权威层：单写者事务、钉住快照与部署防护

`AuthorityStore` 统一执行 SQLite/PG 治理。driver 提供异步 SQL、连接队列、嵌套事务、时钟与方言；同一治理事务提交 canonical/历史版本、审计、幂等结果、outbox 和 operation marker。SQLite 使用写事务串行提交；PG 写事务保持同一 checked-out client，租约使用服务端时间。

canonical ID 由 Core 分配 UUIDv7，display ID 使用安装级递增别名；更新保持逻辑身份。Proposal 的 `expected_version` 是创建/更新基线，CAS 竞争不能覆盖另一提交。幂等键同时核对 operation、principal、Engagement 与规范化请求哈希；不同载荷同键明确冲突。

`recordsPage`/`proposalsPage` 固定历史序列并用 keyset 分页；`snapshot`/export 是全量物化路径，不能因 Context 已有界就宣称全部读取有界。outbox 是派生层恢复设施，宿主轮询不消费 outbox。

`openRuntimeService` 默认打开 `~/.taric/authority.sqlite`。CLI、MCP 和 proxy 可以分别打开同一台机器上的本地文件，由 SQLite 锁协调提交；同进程队列不是跨进程队列。共享 SQLite 文件、NFS 锁、共享 Git clone 或独立副本不能提供多主机 authority。

多主机显式选择 `multi_host_authority`，读取匹配当前编译 Core/schema/policy 摘要的 activation report，检查已部署 schema/lease，再构造服务并在调用前复验健康。缺失/不匹配证据或数据库故障失败关闭，没有 SQLite fallback。runtime 启动不自动运行 conformance fixture，也不迁移 PG schema。

### 4.2 分级信任与提案治理

```mermaid
flowchart LR
    P[Proposal: L0 / pending] --> A[admission.evaluate: 结构准入]
    A --> C[canonical: L1 / machine_approved]
    C --> R[独立 reviewer: review.submit]
    R --> G[writer/operator: admission.promote_l2]
    G --> V[Finding: L2 / independently_verified]
```

`capture.observation` 仍委托提案入口，不直接创建 L2。`admission.evaluate`（以及 `admission.commit` 别名）检查结构、引用、来源、版本，返回业务决策；它不运行完整证据/freshness/independence 硬门。调用方既要检查外层 `ok`，也要检查 admission 的 `data.ok`，拒绝决策可以在没有 canonical 更新的情况下追加审核事件。

Finding 晋升固定 proposal/evidence hash、target version、policy 和 review refs，由策略引擎重算 schema/scope/evidence/freshness/independence 五门。informational/low/medium 至少一名独立 reviewer，high/critical 至少两名且要求异构性；证据年龄上限分别为不限/180/90/30/14 天。reviewer 身份与模型/提示/规则栈 attestation 来自可信 transport，请求不能自报。

普通记录查询默认只返回可召回 L2；host/operator 可以显式查看 L1。Context 有自己的 `include_candidates` 与安全/必含项规则，不能把“普通查询默认 L2”推广为所有 Context 项均为 L2。模型提交内容不能指定 canonical ID、版本、display ID、trust、审核或策略结果。

### 4.3 身份与授权模型

公开接入统一使用 `service.dispatch(operation, principal, request)`。`createPrincipal`/`registerTransportPrincipal` 将对象登记到进程内 WeakSet；仅在 body 中写 `transport_verified:true` 无效。reviewer attestation 和 host transport session 在 WeakMap 中保存注册时快照。

授权是 operation 注册表角色 × 所需 capability × Engagement；operator 也不能绕过 host-only 或 reviewer-only 的角色限制。默认能力如下：

| role | `createPrincipal` 默认 capability |
|---|---|
| model | read、propose |
| host | read、propose、work、checkpoint、action、content |
| reviewer | read、review |
| writer | read、propose、admit、writer |
| operator | read、propose、admit、writer、audit、operator、content |

host 调用 admission 需可信 transport 额外授予 `admit`；host/operator 原文读取均须另授 `content_read`。CLI `TARIC_CONTENT_READ_ENABLED=true` 可启用该额外能力；普通 proxy 不提供任意 capability grant。请求不能提升角色或 capability。注册表角色不允许的操作也不能靠加 grant 放开。

`createCoreService` 暴露的 `init()`、`status()` 等低层库方法并非每个都带 principal；宿主不能把 service 对象或这些方法原样暴露给不可信调用者。公开 dispatch 才是统一 operation 边界。

### 4.4 Context Pack：最小投影、cursor 与草稿封存

Context 首屏与续页固定 `read_seq/read_time`，SQL 下推 Engagement/sequence/筛选，按 scope/ROE、目标 WorkItem、checkpoint、delta/冲突/过期/覆盖缺口、直接材料与背景分组 keyset 读取，再做字段白名单投影。后续提交或到期不改变该分页的原读取点。

字符预算默认 4000，单位为序列化字符，非模型 token。强制项放不下返回 `minimum_budget_required`；分页返回 `items`、`mandatory_constraints`、`manifest`、`used`、`cursor`、`read_stats` 和 omitted 完整性标志，未检视范围不能当作完整遗漏计数。

Core helper `buildContextPack` 的 `scanBudget` 为 2～1000（默认 256，含 lookahead），`cursorTtlMs` 默认一小时；这些 camelCase 参数没有暴露到 `service.buildContext`、CLI 或 MCP 请求。公开请求使用 `budget/work_item_id/worker_role/policy_version/read_seq/cursor/filters/ordering/include_candidates`；Core service 另支持 checkpoint/resume 输入，MCP 不暴露全部参数。

Context cursor 是 v2 AES-256-GCM，加密保存固定序列/时间、排序元组、有界 delta IDs 与绑定，不含完整 records 或增长的 delivered-ID 列表。普通 authority 列表 cursor 是 v1 HMAC，Artifact catalog cursor 是 base64url keyset 状态；三者合同不同。密钥文件 `.taric-context-cursor-key.v1` 为 0600，绑定 real content root 和 authority ID；丢失/轮换导致旧 Context/authority list cursor 失败，不影响已提交记录。详见[恢复手册](context-recovery.md)。

`resumeContextDelta` 按固定前后序列读取变更 subject 与事件，超过预算返回 `minimum_budget_required`；这是状态差分，不是事件重放或可靠投递证明。草稿及迟到提案保留原 Attempt/generation，重用须显式 rebase。

### 4.5 协作状态：WorkRun / Attempt / Checkpoint / ActionIntent

host 认领 WorkItem 后创建 WorkRun/Attempt、owner、generation 和租约；默认 TTL 60000ms，显式 TTL 必须为正安全整数。`work.claim` 的 host_id 以 principal 覆盖，task-session 只能来自可信 transport。renew 延长租约；过期 reclaim 推进 generation，并保留旧 Attempt 及迟到归属。

`checkpoint.propose` 只生成候选，不续租或更新有效 checkpoint；`checkpoint.commit` 必须由当前 host 验证运行/Attempt、版本、scope、Context manifest、引用与真实结果。空列表也必须显式。proposal/commit 的隐藏推理字段递归检测并拒绝，不是静默剥离后保存。

`work.resume` 返回 run、checkpoint、pending_actions、会话 Artifact 元数据，以及 Engagement/WorkItem/scope/checkpoint/Attempt/lease/manifest/宿主决定/动作结果 premise checks；前提失败返回 `blocked/replan_required`，不会执行动作。当前 `resumePacket` 会物化该 session 的全部 Artifact 元数据，与有界 Context delta 是不同读取路径。

无 WorkRun 的 `action.recommend` 生成提案；有 WorkRun 时写 advisory ActionIntent 并要求当前 generation。host 记录 `authorized/denied` 决定及 `executed/failed/unknown` 结果，选择 `llm_recommend/authorized_autonomous/host_hitl` 模式。unknown 只经 host reconcile 解决，Taric 不自动重放目标操作。

### 4.6 记忆演化与宿主状态

`resource.revise` 创建不可变 ResourceRevision；`resource.relation` 维护同 Engagement 类型化边；`resource.patch` 按 base generation/version 三方合并，非重叠修改合并、敏感重叠形成审计冲突；`resource.impact` 沿显式依赖有界传播，返回 continuation/pending watermark 与重验 WorkItem，不调度 worker。

Coverage 按资源版本、测试类别、身份、操作与条件成格；ControlObservation 与 AccessDecisionObservation 分离。未知层不能归因具体控制/源站，边缘拦截且源站未达不能关闭 origin coverage；历史观察通过新修订/applicability event 演进。

`host.state` 在只读事务内返回固定时间、范围 hash watermark、有界聚合及逐类完整性：L1（排除 conflict/impact）、Conflict、Impact、unknown action、过期 lease、到期 freshness。limit 默认 100、范围 1～1000；freshness 只检查前 limit 个记录头，不完整时不是全局到期总数。该操作没有 continuation/事件清单，状态未提交也可因时间到期改变；host 应持续轮询，不能仅依赖 watermark 判断每个底层事件。

### 4.7 派生投影与恢复

`projection.ts` 从固定快照生成白名单 Markdown generation、manifest 哈希与 current 指针；本地 Git checkpoint 默认启用，失败记录 pending/可重试，不回滚 authority。remote push 通过宿主提供的真实扫描与 push callbacks，要求私有仓库、访问控制、保留策略和 Engagement 授权；它不是公开 `remote.push` operation。

operator `snapshot.export` 返回 sanitized Taric-native JSON，包含所选序列的最新记录版本，也保留普通召回隐藏的 L0/recalled 记录；不是模型 Context，更不是数据库全历史备份。`exportSnapshotJsonl` 是库方法，公开 dispatch 未提供格式选项。公开 `snapshot.import` 拒绝，内部后端恢复只供隔离恢复/conformance。

## 5. Artifact 原文存储（任务会话 spool）

### 5.1 模式与会话绑定

宿主可仅保留外部 `host_ref`，或授权存储 opaque text/binary/manifest 字节，包括用户提供或任务中获得的目标系统用户名密码、token、cookie、密钥和 SSO 材料。持有 `content_read` 的可信 host/operator 可按需经 `artifact.content.read` 读取原始字节。Taric 不抓取外部引用、不解析/执行/脱敏或扫密，也不签发、验证、刷新、轮换、撤销或管理凭据生命周期；原文的 ACL、加密卷、保留、删除与备份由宿主负责。普通模型查询仅获允许的引用/类型化元数据。

`artifact.session.bind` 必须指定模式：

| mode | 必须字段与约束 | 后续保证 |
|---|---|---|
| host-session | Engagement、session_id、root；禁止 work_run_id/attempt_id/generation/owner_host | 会话隔离、内容完整性，不承诺运行 lease |
| run-bound | 上述字段加完整 WorkRun/Attempt/generation/owner_host，owner 必须等于 principal.id；持久化时验证当前租约 | begin/append/commit 与 publication 恢复按持久绑定复验，省略请求字段不能降级 |

root 必须位于 configured content root，resolve/realpath 复核，禁止会话根重叠及现有绑定的 root/mode/run 改写。host 的 transport session 存在时，所有 Artifact 请求必须匹配；run-bound operator 绑定也必须满足 owner 等于 principal。

### 5.2 上传、传输与文件布局

begin 创建 upload 与服务器分配 Artifact ID/version；append 按 ordinal 顺序核验块长度/哈希，同块重试必须一致；commit 验证总长度、块数与全量 SHA-256。成功返回 `artifact_id@vN`，不拼装整个多块 Artifact。`base_content_ref` 为版本链，`derived_from/parent_ref/child_refs` 表达派生或复合关系，不拼接子内容。

| 入口 | 实现限制 |
|---|---|
| Core base64 append | decoded ≤64 MiB；base64 ≤89,478,488 字符；metadata ≤16 KiB，有编码/解码副本 |
| CLI append-file | 1 byte～64 MiB；先流式计算哈希，再读取文件流写 staging；不是公开 operation |
| 普通 adapter RPC | 请求/响应每行 1 MiB；超长请求关闭连接，超长响应返回有界错误 |
| 独立 binary RPC | header ≤16 KiB；4-byte BE header 长度 + JSON + 精确 raw body；≤2 活跃上传，64 KiB 接收块、每上传队列 2 块，有背压 |
| 普通 RPC raw read | decoded ≤512 KiB；Artifact list/output 总是最多 16 项，带内容另限 128 KiB |

`taric proxy` 只启动普通 Unix JSON socket。可选 `taric gateway` 可同时启动 Unix socket、TLS TCP JSON-RPC 和 HTTPS `/rpc` listener，并将请求送入同一个 CoreService；HTTPS 不支持连接式通知，客户端通过 authority reads 恢复。网络 `artifact.session.bind` 将 session 映射到 gateway contentRoot 下的服务端目录并忽略调用方 root，远程 `artifact.ingest_file` 被拒绝。Core 的 binary Artifact listener 仍只支持 Unix socket，不会被 gateway 暴露成网络上传端点。

```text
<session-root>/
  manifest.json
  manifest/segments/YYYY/MM/DD/ab/<artifact-id>-vNNNNNN.ndjson
  artifacts/YYYY/MM/DD/ab/<artifact-id>/vNNNNNN/
    payload-000001.part
    content.manifest.json
    metadata.md
  execution/…                 # 按运行/Attempt 分片的执行 sidecar
  .staging/<upload-id>/
```

日期由 UTC stored_at 派生，captured_at 不控制路径；每 Artifact 版本单独 NDJSON 条目，不提供固定条目数聚合滚动段。数据库保存目录/块/上传/发布元数据，payload 是原生文件。

### 5.3 发布与崩溃恢复

发布先登记起始状态，临时目录写操作标记/块/manifest/Markdown/NDJSON，持久化待发布 row/chunks，然后 rename、更新 published marker，最后在 authority 事务复验 fence 并提交 catalog、幂等结果和审计，再清理 staging。

`local_process_crash` 使用完整性核验与 publication markers；没有显式 fsync，不声明断电耐久。故障测试覆盖 before_manifest、before_rename、after_rename、after_publication_marker、before_catalog_commit、after_catalog_commit。重启只恢复内容完整且绑定仍有效的 publication，过期/被 reclaim 的运行不能发布为 available。

### 5.4 读取与维护

`artifact.metadata` 返回元数据；`artifact.content.read` 是显式原文操作，即使没有 `include_content` 也会读字节，必须 `content_read`。list/output 默认元数据，`include_content=true` 另检查原文权限；单次 Core read 上限 64 MiB，transport 可收紧。chunk cursor 为 ordinal:offset，catalog cursor 为 scoped base64url keyset，不是固定 read_seq 的 Context cursor。output 有独立 `execution_next_cursor`。

读取按 manifest 与目标 chunk 核验；缺失或篡改返回结构化错误，不将未核验内容视为 available，不自动重建丢失 payload。PG 只共享元数据，不同步各主机 spool；数据库恢复须协调所有相关内容根，跨机原文访问由宿主路由。

## 6. 数据模型

共同布局包含 25 张表，JSON 正文在 SQLite/PG 均以 text 保存：

| 分组 | 表 |
|---|---|
| canonical/历史 | metadata、records、record_versions、object_refs |
| 治理 | proposals、proposal_versions、admission_review_packs、reviews |
| 审计/恢复 | events、idempotency、outbox、operation_markers、reader_pins |
| 运行 | work_runs、attempts、checkpoints、action_intents |
| Artifact | artifact_sessions、artifact_catalog、artifact_chunks、artifact_catalog_watermarks、artifact_uploads、artifact_idempotency、artifact_publications、execution_catalog |

索引覆盖 Engagement/版本、历史 sequence、proposal 历史、Context 访问、host.state 聚合、Artifact 会话/类别/媒体/运行 keyset 及执行目录。参考 [sql-schema.ts](../packages/core/src/sql-schema.ts)，不以文档中的旧行号作为合同。

领域记录包括 Engagement/Scope、Resource/Revision/Relation、Observation/Evidence/Claim/Finding、假设/攻击路径、Coverage/Control/Access、Conflict/Impact/PatchSet 与 WorkItem/Run/Attempt/Checkpoint/ActionIntent。记录 ID、版本、信任和审计归属由 Core 管理；原文字节不进入 canonical JSON。

## 7. API 表面

当前 schema registry 有 57 个 operations、5 个 unsupported declarations、8 个 permanent non-goals；`service.ts` 还单独识别 `storage.backup`/`storage.restore` 两个 deferred 名称。CLI `cliCommands` 有 49 项（含本地 `artifact.store.append-file` helper），MCP 固定六工具，三种清单不等价。完整逐操作角色与 capability 见 [API](taric-api.md#operation-inventory)。

Core service 方法与公开 dispatch 的请求形状不总等于领域 schema：Artifact 请求在 dispatch 编译 schema 校验，其余很多注册项使用 `apiSuccess` 占位并由方法手工检查。不能声称每个输入都会自动套用完整领域 schema 或统一拒绝所有额外字段。错误 envelope 为 `ok:false/error`，11 个稳定 Core 错误码；startup 与 JSON-RPC 另有错误层。

MCP 支持 `initialize/tools/list/tools/call`，返回协议 `2024-11-05` 与 `{tools:{}}`，不实现 resources/subscriptions、Tasks 或 HTTP。Pi 静态 descriptor 是认证上限，实例注册结果与 `status()` 才反映 hooks/tools/run binding；DeepSeek 仅 session lifecycle，Hermes 仅 context/session/tool observer，详细映射见[接入指南](agent-integration.md#native-adapter-setup)。

## 8. 配置与环境变量

兼容配置发现依次检查 `TARIC_CONFIG`、工作区 `.taric/config.json`、用户 `~/.taric/config.json`，选择第一个存在的文件，不合并；`--runtime-config` 显式路径不存在或无效时直接失败，不继续候选。`config.authority` 整体优先于环境 profile，其他字段逐项解析，不能笼统说所有环境变量最高优先级。

| 项目 | 实际解析 |
|---|---|
| authority | config.authority 优先；否则由 TARIC_AUTHORITY_PROFILE/DATABASE_URL/HOST_ID/LEASE_MODE 组合 |
| db_path | TARIC_DB → config.db_path → authority.sqlite.path → ~/.taric/authority.sqlite |
| content_root | TARIC_CONTENT_ROOT → config.content_root → DB 旁 content；显式 :memory: 使用临时根 |
| runtime_conformance_path | TARIC_RUNTIME_CONFORMANCE → config.runtime_conformance_path |
| quality release evidence | `TARIC_QUALITY_RELEASE_REPORT` + 独立配置的 `TARIC_QUALITY_RELEASE_REPORT_SHA256`；Core 校验报告原始字节 pin 与当前实现/schema/policy digest，失败或缺失时保持 disabled |
| principal | CLI 默认 operator/operator-local；MCP stdio 强制 model，但 ID 来自 resolver，缺省可为 operator-local；proxy 固定 host |
| content_read | 环境值为 true 或 config.content_read_enabled=true；环境 false 不覆盖配置 true；MCP server 不保留额外 grants |
| transport session | TARIC_SESSION_ID 仅由 proxy 消费，普通 CLI/MCP 不读取 |
| adapter config | TARIC_ADAPTER_CONFIG 或 ~/.taric/adapters.json，只管理三个内置 adapter 的配置 |
| socket/token/network gateway | proxy 使用 TARIC_CORE_SOCKET、TARIC_ADAPTER_TOKEN（≥32 字符）与 Engagement；可选 gateway 使用固定 token-to-principal 表，TLS TCP/HTTPS 需 PEM key/certificate，细节见宿主接入指南；Hermes client 仍使用 Unix socket |

PG 的 dbPath 仍参与默认 contentRoot 推导，但不打开 SQLite；部署应显式指定每 host 独立持久内容根。详细可运行配置见[接入指南](agent-integration.md#runtime-configuration)。

## 9. 外部依赖

Node、SQLite 与本地文件系统是单机运行前提；PG profile 另外依赖数据库连接与有效证据。宿主提供工具、身份、批准、目标凭据执行策略及可选扫描/push callbacks；目标凭据需要在任务中持久化时，可通过 Artifact 内容接口交给 Taric。连接 Taric 所需的数据库、gateway 和 TLS 凭据仍由宿主单独提供。`reference/` 的冻结输入只用于设计，不是运行时依赖。系统不调用模型 API。

## 10. 业务规则与约束（代码强制的不变量）

1. canonical 写入、版本、审计和幂等由共享 Core 管理；输入不能自行授予 trust/writer。
2. 角色与 capability 同时检查；host/operator/reviewer/writer 不是可互换的身份。
3. Engagement、引用、评审 hash、运行 owner/generation 和持久会话各自检查；旧绑定不因字段省略降级。
4. 迟到隔离保留来源，unknown 动作必须对账；Taric 不执行目标动作。
5. Context/query/projection/export 各有不同可见性，不能混用导出与模型召回。
6. Artifact 原文可显式保存，但不默认进入模型/派生视图；内容权限不等于原文读取权限。
7. 修复是显式 operator 操作，不能静默改写 canonical 历史或凭空恢复文件。

## 11. 非功能特性

SQLite API 虽包装成 Promise，底层 SQL/部分文件阶段仍同步；排队与长操作可阻塞 event loop，没有后台维护 worker。`SqlMetrics` 记录 statements、rows_returned/affected、queue_wait_ms、sql_elapsed_ms；`read_stats` 的行界限不等于磁盘访问数、所有 SQL 扫描成本或常数延迟保证。

50k Context 首屏历史测量为 3.08s，对比 5.36s 基线降低 42.5%，未达到 50% 候选目标。2s patch→query 是指定 mutation 路径目标，不是通用读取 SLA。[规模](benchmarks/authority-scale-v3.json)、[Artifact transport](benchmarks/artifact-transport-v2.json)、[维护](benchmarks/maintenance-concurrency-v2.json)、[轮询](benchmarks/host-state-poll-v1.json)均是特定机器/fixture 的保存结果。

`audit.verify/doctor` 与 `audit.reconcile {action:"preview"}` 是观察路径；默认 reconcile 会消费 outbox 并检查/修复 Artifact，replay/rebuild/reconcile 是显式修复模式，不能把省略 action 当只读。导出/全审计和 resume Artifact 元数据仍可能随历史/会话规模增长。

## 12. 测试策略与发布门槛

```sh
npm run typecheck
npm run build
npm test
node scripts/check-doc-links.mjs
node --test scripts/test/profile-verification.test.mjs
```

重点回归包含 API 权限、L1/L2/CAS、transport session fencing、host.state、Core/RPC bounded subscription、bounded Context/持久 cursor、Artifact durability/scale/RPC、runtime startup/readiness/conformance 与 adapter 实例状态。2026-10-27 的 `1.0.1` workspace 测试在配置 live PostgreSQL 后通过：Schemas 10/10、Core 356/356（无跳过）、CLI 37/37、MCP 12/12、Hermes 5/5、Bun driver 11/11。build、typecheck、matrix 也通过。当前 PG 12 场景、独立备份恢复、双 host 容器 bridge 网络 lease/reclaim 和容器 bind-mounted spool 检查通过。它们不代表跨物理机/网络恢复或真实第三方宿主验收。此前候选报告绑定较早工作树，仍只作为历史证据。

[此前候选报告](../openspec/changes/harden-taric-authority-runtime/release-report.json)绑定 source/build/schema/policy/profile digest；专项报告为 [clean consumer](../openspec/changes/harden-taric-authority-runtime/clean-consumer-report.json)、[proxy restart/replay](../openspec/changes/harden-taric-authority-runtime/proxy-restart-report.json) 与 [PostgreSQL runtime](../openspec/changes/harden-taric-authority-runtime/postgres-runtime-report.json)。这些报告对应早期候选工作树，不代表本次 1.0.1 发布验证。质量发布因 30 条 synthetic samples、0 条人工标注样本而 blocked。历史 benchmark 仅代表对应环境与 fixture，不代表当前构建或部署自动启用。

## 13. 已知差距与假设

- native adapter 认证限固定合同，不是第三方宿主生产端到端认证；实例 `service_connected` 只表示曾调用过 service，不是持续健康探针。
- 自定义 adapter ID 与通用协议已开放，但 adapter install/config 只管理内置三类，未知版本/fork 不自动获得 native certification。
- `host.state` 聚合/时间轮询及 Core in-process、adapter RPC bounded subscription 已实现，使用 query/read_seq 作为恢复保证；MCP resources subscription、MCP Tasks 和通用远程 host RPC 未交付。Bun SQLite driver 已提供，远程和容器 profile 仍需独立环境验收。
- Context 有界不代表 snapshot/export/audit/work.resume 全部有界；字符预算不是 token 预算。
- 默认 Artifact 仅声明 local_process_crash，不声明 fsync/断电耐久；PG 不同步 spool。
- 公开 `snapshot.import`、`storage.backup` 和 `storage.restore` 会在 dispatch 返回 deferred/unsupported；`migration`、`backup.restore` 与 `remote.push` 不是公开 operation。质量统计算法已实现，但 `quality.full_statistical_evaluation` 默认 disabled，只有当前构建匹配的人工标注 release evidence 校验通过后才会动态启用；底层恢复/callback/统计函数不自动变成公开 operation。
- Taric 不证明工具观察真实、发现完整、凭据安全或动作恰好执行一次；目标部署容量与人工质量需独立证据。

## 14. 附录

[API 请求与权限](taric-api.md)、[宿主集成](agent-integration.md)、[Context 恢复](context-recovery.md)、[单机维护](authority-storage-runbook.md)、[多主机运行](multi-host-authority-runbook.md)、[PG readiness](postgres-runtime-readiness.md)分别承担接口、接入与操作细节。历史差距分析与改进提案记录设计来源，不覆盖本文的当前实现合同。

### 接口、函数与测试索引

| 功能 | 公开入口/函数 | 主要回归测试 |
|---|---|---|
| WorkRun 状态迁移 | `CoreService.dispatch("work.transition", ...)`；经 `AuthorityStore.transitionWorkRun()` 提交 | [work-transition-dispatch](../packages/core/test/work-transition-dispatch.test.mjs)、[schema](../packages/schemas/test/schema.test.mjs) |
| Coverage 写入、查询与 gate | `coverage.record/query/gate`；`createCoverageCell`、`coverageGateSnapshot`、`coverageCloseGate` | [coverage record](../packages/core/test/coverage-record-dispatch.test.mjs)、[coverage dispatch](../packages/core/test/coverage-dispatch.test.mjs)、[coverage lifecycle](../packages/core/test/coverage-lifecycle.test.mjs) |
| 主机状态提示 | `CoreService.subscribe()`；RPC `taric.subscribe`/`taric.unsubscribe` | [subscription signals](../packages/core/test/subscription-signals.test.mjs)、[adapter RPC](../packages/core/test/adapter-rpc.test.mjs) |
| Artifact 文件摄取 | `CoreService.dispatch("artifact.ingest_file", ...)` | [artifact ingest](../packages/core/test/artifact-ingest.test.mjs)、[Bun embedding smoke](../packages/driver-bun-sqlite/test/embedding-smoke.test.ts) |
| 质量评估与报告 | `evaluateMemoryQuality()`、`buildReleaseReport()`、`verifyReleaseReport()` | [quality](../packages/core/test/quality.test.mjs)、[release report](../packages/core/test/release-report.test.mjs) |
| 质量 capability 启用 | `verifyPinnedQualityReleaseReport()`、`loadPinnedQualityReleaseActivation()`、`runtimeImplementationDigest()`、`buildRuntimeActivationEvidence()` | [release support](../packages/core/test/release-support.test.mjs)、[runtime startup](../packages/core/test/runtime-startup.test.mjs) |
| Schema 和兼容矩阵 | `operationContracts`、`core.schema.json`、`compatibility-matrix.json` | [schema contracts](../packages/schemas/test/schema.test.mjs)、[profile verification](../scripts/test/profile-verification.test.mjs) |
| Bun SQLite driver | `BunSqliteAuthorityDriver` 与 Core `AuthorityStore` driver injection | [driver conformance](../packages/driver-bun-sqlite/test/conformance.test.ts)、[driver-specific tests](../packages/driver-bun-sqlite/test/driver-specific.test.ts) |

公开 dispatch 的角色、capability、请求字段与传输差异见 [API 边界](taric-api.md)。
