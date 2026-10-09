# Design

## Context

本文依据 `docs/taric-design.md` 的 Phase 0–1 实现目标和验收要求，定义单机 Taric 插件首发的完成边界。动机见 `proposal.md`。本变更是规划工件，不代表下表中的能力已经实现，也不能被描述为完成 `taric-design.md` 的全部 Phase 0–5 路线图。

当前代码已具备 TypeScript workspace、SQLite WAL、基础记录/提案/审核表、部分 CAS/租约/审计方法、字符预算 Context Pack、Markdown 输出和 adapter facade。它可以作为后续实现的起点，但不能作为完整 API、CLI、MCP 或原生插件交付。

上一变更 `build-taric-memory-core` 已归档。其任务勾选只记录当时的工作状态；本次以当前入口、数据流和测试实际覆盖范围重新建立完成标准。既有 main specs 是最低契约，本变更的 delta 补齐可验证行为。

### Current Implementation Gap Matrix

状态按源代码和测试检查判断。未运行真实宿主和性能基准的能力，不声明已验证。

| 设计依据 | 当前代码证据/状态 | 剩余差距 | 对应 spec / tasks |
|---|---|---|---|
| §4.1/§12 三种接入层 | `packages/cli/src/index.ts` 仅导出命令数组；`packages/mcp/src/index.ts` 仅导出工具数组 | 无 executable/bin、参数解析、dispatch、MCP initialization/list/call 与 stdio 服务 | `taric-runtime-api`；10 |
| §4.1.1/§13 writer 隔离 | `AuthorityStore.commit` 和 `.db` 公开；`TaricAdapterFacade.store` 公开 | model/adapter 可取得 canonical writer；缺少 transport-verified principal/capability 与 engagement ACL | `taric-runtime-api`、`memory-governance`；3、5 |
| §6/§10 完整契约 | `core.schema.json` 只有基础 `$defs`；Ajv helper 未接入 store 写边界 | 首发最小 schema、引用类型、scope、时间、状态、provenance 硬门；完整领域演进延期 | `engagement-memory`；2、6、8；`evolve-engagement-memory` |
| §5/§7 admission | `admitProposal` 在事务外检查版本，随后独立 commit 和更新 proposal；validation callback 可省略 | submission/review/reject/admission 全路径原子性、必选 policy、幂等 payload 冲突和拒绝审计 | `memory-governance`、`authority-storage`；3、4、5 |
| §5.3 L2 review | `submitReview` 接受自报 reviewer；主要检查作者和 proposal hash | reviewer capability、验证 worker 隔离、原始证据固定快照、A/B 上下文隔离及 L2 原子 promotion | `memory-governance`；5 |
| §7.2 全局 ID | store 已使用 metadata 序列，但接受 caller `display_id`，更新也消耗序列；未有唯一 display 约束 | 服务分配、逻辑实体 alias 稳定、唯一约束、持久并发/重启及幂等校验 | `authority-storage`；4 |
| §7.1.1 CAS/快照 | `compareAndSet` 在事务外读版本；`snapshot` 先读 seq 再读 current records | 条件更新、实际 as-of 历史、同一 read transaction、read-your-writes 与水位 | `authority-storage`；4、7 |
| §8 审计/恢复 | 部分操作记录 hash event；`verifyAudit` 仅检查 hash chain；outbox 无消费流程 | 所有状态事件、canonicalization、counter/outbox/view/权限漂移检查和最小 doctor；完整 replay/reconcile 延期 | `memory-governance`、`authority-storage`；4、5、11；`validate-memory-quality` |
| §4.4 Context Pack | `context.ts` 按记录顺序估算 JSON 字符；cursor 字符串没有续取 API | WorkItem 强制信息优先、来源 manifest、budget 单位、固定 seq 分页和摘要引用；完整依赖 delta 延期 | `engagement-memory`；7；`evolve-engagement-memory` |
| §4.6 图持续演进 | 当前记录可覆盖更新，relation 为基础类型 | 稳定 resource identity/variant、immutable revisions、PatchSet read/write set、三方合并与冲突队列 | `evolve-engagement-memory` |
| §4.6/§4.8 影响传播 | `markStale` 是单对象更新 | 按 criticality/字段依赖定向传播、ImpactEvent、revalidation 队列、Context/index 失效与 finding recall 降级 | `evolve-engagement-memory` |
| §4.8 防护模型 | 无 ProtectiveControl/revision/ControlObservation/AccessDecision schema 与操作 | 首发 unknown/origin/suspected 硬门、不可变观察；完整适用性重算延期 | `engagement-memory`；6；`evolve-engagement-memory` |
| §9 coverage | `coverage.ts` 提供基础函数；阴性判断依赖句中是否有“未/not observed” | 最小 identity/operation/conditions、baseline/limitations、bounded negative、coverage gate；完整 profile 延期 | `engagement-memory`；6；`validate-memory-quality` |
| §4.3 WorkRun/Attempt | 有 claim/checkpoint 表与部分 generation 校验 | Attempt 实体、WorkItem 引用、状态机、heartbeat/renew、原子 reclaim/lost、agent/dispatch owner 校验 | `collaboration-state`；8 |
| §4.3 checkpoint/resume | checkpoint 接受任意对象；resume 返回最新 checkpoint/actions/current seq | 最低字段/证据/context 验证、scope/host-ref 复核；完整依赖 delta、draft rebase 延期 | `collaboration-state`；8；`evolve-engagement-memory` |
| §4.3 全写路径 fencing | checkpoint 有检查；action 只查 generation 且在事务外；late result 无完整审计 | 所有首发 write path 同事务 fencing；独立迟到结果隔离和对账 | `collaboration-state`、`host-action-integration`；4、8、9 |
| §12/§16 动作建议 | `recordActionIntent` 保存状态；没有 recommendation handler | 三模式输入、结构化建议/限制、host decision/result 归属、合法迁移、idempotency 与未知结果对账 | `host-action-integration`；9、10 |
| §4.5 projection | `projection.ts` 两份同构 JSON Markdown；先删 current 再 rename；读权限是 caller boolean | Brief/Index 分工、L0/L1 trust gating、类型白名单、manifest、保留旧 generation、真实 ACL/path 校验 | `markdown-projection`；11 |
| §4.5/§16 Git | 仅计算 `remotePushAllowed` 布尔值，没有 Git commit/push | 默认 local checkpoint、manifest/seq 绑定、pending/retry；remote push/scan 明确 unsupported | `markdown-projection`；11 |
| §4.2/§14 native adapters | Pi/DeepSeek 创建 facade；Hermes 只 describe/translate events | 首发真实 Pi hook/Core RPC/host contract；其他宿主延期 | `host-adapters`；10；`integrate-native-host-adapters` |
| §14.3/§7 snapshot/migration | 无原生 snapshot import/export 或版本迁移流程 | 首发只做一致 snapshot export 和 schema compatibility rejection；import/migration/backup/restore 延期 | `authority-storage`；4；`evolve-engagement-memory` |
| §14.5 多主机 | 仅 SQLite | PostgreSQL/server-side lease/order/backup/restore；不能用共享 SQLite/Git 代替 | `add-shared-authority-backend` |
| §15 测试/发布 | tests 主要直接调用 store/facade；根 `npm test` 不先 build | clean checkout、CLI/MCP 子进程、真实 Pi、100 并发、crash/poisoning；完整统计评估延期 | 各组测试 + 13；`validate-memory-quality` |
| §14.0 版本基线/§16 文档 | 设计声明来源/接口策略；README/API 文档先于可执行入口 | 固定参考与宿主来源版本、运行能力矩阵、命令示例/支持状态与代码对应 | `host-adapters`、`quality-evaluation`；1、12 |

### Single-host release profile

本 change 只交付下列 Phase 0–1 profile。所有条目均须有可执行验证；未实现项不得以文档、包名、接口占位或测试桩声称支持。

| Profile area | 首发要求 | 明确延期 |
|---|---|---|
| Authority | 一个 Core service + SQLite WAL；同机多进程/多 worker；全局 UUIDv7/display ID；短原子事务、CAS、固定 `read_seq`、read-your-writes、append-only audit/outbox | PostgreSQL、多机 event ordering/lease、跨主机备份恢复 → `add-shared-authority-backend` |
| Governance | proposal-only model writes；deterministic guard；独立 L2 reviewer 最小硬门；evidence/provenance/scope/version 校验；不可绕过 writer | 更复杂 reviewer 组合、统计质量与全量 replay/reconcile → `validate-memory-quality` |
| Domain | Engagement/Scope/Resource/Observation/Claim/Evidence/Finding；最小 ProtectiveControl/ControlObservation/AccessDecision/coverage | ResourceRevision variants、typed graph、PatchSet merge、ImpactEvent → `evolve-engagement-memory` |
| Collaboration | WorkItem/WorkRun/Attempt；claim/lease/renew/reclaim/fencing；完整最低字段 Checkpoint；ActionIntent、host mode/result、unknown 状态、late-result quarantine；不自动重放动作 | 完整 resume delta、draft rebase、依赖驱动恢复 → `evolve-engagement-memory` |
| Access surfaces | 可执行 CLI、MCP stdio、真实 Pi extension；统一 Core policy；未支持能力返回 `unsupported_capability` | DeepSeek/Hermes 原生 integration 与安装诊断 → `integrate-native-host-adapters` |
| Context/projection | 固定 sequence 的分页 Context Pack；scope/ROE/WorkItem/checkpoint 优先；L0/L1 trust filtering；distinct Brief/Index、manifest、ACL、atomic generation；默认本地 Git checkpoint | 高级检索/缓存、snapshot round-trip、migration/backup、远端 Git push/外部 secrets scanner → `evolve-engagement-memory` |
| Release evidence | clean build-then-test；100-worker ID/event/CAS/concurrency gate；安全不变量和 single-host p95 可重复验证 | precision/recall、95% CI、完整 poisoning corpus → `validate-memory-quality` |

### Phase gate and dependency order

1. **Gate P0 — contract and boundary**：冻结单机支持矩阵、API/schema/error/capability registry、非目标和 unsupported behavior；共享 schema validator、principal/engagement ACL、writer-only service boundary 必须先于任何 runtime write path。
2. **Gate P1 — authority and governance**：SQLite WAL startup/schema compatibility guard、ID allocator、atomic record/proposal/review/admission/audit/outbox、CAS/read sequence、minimum independent L2 review 和 recall filters；没有该 gate 不得接入 adapter、CLI 或 MCP 写操作。
3. **Gate P2 — domain/control/context**：Phase 1 domain contracts、minimum control semantics、bounded coverage、fixed-sequence Context Pack 和 L0/L1 projection filtering；没有该 gate 不得发布 model-facing tools。
4. **Gate P3 — collaboration/action**：WorkRun/Attempt state machine、lease/fencing、minimum checkpoint、ActionIntent legal transitions、unknown reconciliation 和 late-result quarantine；没有该 gate 不得宣称可恢复运行或 action integration。
5. **Gate P4 — surfaces/projection**：Core transport、executable CLI/MCP、Pi hooks、distinct projections、generation manifest/ACL、local Git checkpoint；unsupported operations must fail closed with stable errors。
6. **Gate P5 — release evidence**：clean checkout build first, then tests; 100-worker concurrency and all deterministic security gates pass. A failed gate blocks the single-host release report.

The four follow-up changes are ordered after this profile: `integrate-native-host-adapters` depends on the Core transport and adapter contract from P0/P4; `evolve-engagement-memory` depends on authority versions, fixed sequences, and patch boundaries from P1/P2/P3; `validate-memory-quality` depends on stable governance, retrieval, projection, and fixture contracts; `add-shared-authority-backend` depends on the SQLite storage conformance contract. These are dependency statements, not tasks in this change.

### Deferred capability rule

DeepSeek, Hermes, complete relation/impact, full quality evaluation, PostgreSQL, remote push, and any other deferred capability must be listed as unsupported in the runtime diagnostics and compatibility manifest. Do not update `docs/taric-design.md`, API docs, or README examples to imply support; documentation changes in this change may only describe the implemented single-host profile and the explicit follow-up references.

## Goals / Non-Goals

**Goals:**

- 每个公开操作有唯一的版本化契约、服务入口和权限判断；CLI/MCP/adapters 调用同一 Core 规则。
- 权威写入、固定序列读、最小协作恢复和投影恢复分别可验证；不得用审计恢复替代任务恢复。
- 以当前模块为起点交付 SQLite 单服务首发；多主机和后续领域演进由明确 follow-up 承担。
- 每项首发任务随实现交付测试与接入文档；“已实现”必须对应可执行入口和可重复证据。

**Non-Goals:**

- 不实现 agent loop、worker 调度、模型供应商调用、目标系统工具执行或防护绕过。
- 不签发动作授权；三种动作模式由宿主选择，Taric 只提供建议和记录宿主决策/结果。
- 不建立人的身份或 HITL 审批系统，不托管审计签名密钥。
- 不管理 Artifact 内容、保留、脱敏或凭据。远端 Git 扫描仅覆盖 Taric 将要发布的投影，不是 Artifact scanner。
- 不实现旧 KB/Link runtime、格式兼容或跨 Engagement 自动知识共享。
- 不在本 change 实现 DeepSeek/Hermes 原生 adapter、完整 ResourceRevision/Relation/PatchSet/ImpactEvent、完整质量评估或 PostgreSQL；这些能力分别由 `integrate-native-host-adapters`、`evolve-engagement-memory`、`validate-memory-quality`、`add-shared-authority-backend` 承担。
- 不通过修改 `docs/taric-design.md`、main specs 或 README 来掩盖首发未实现项；任何延期能力必须以 `unsupported_capability` 明确暴露。

## Decisions

### 1. Single Core service with scoped clients

在 `packages/core` 中建立服务层，封装 storage 和 writer；保留现有 store 代码作为内部持久化实现。model、host adapter、operator 使用不同 capability。服务从本机 transport 验证 principal，body 中的 host/reviewer/engagement/attempt 只作为需要交叉核验的归属数据。首发不实现完整 ResourceRevision 模型。

Unix-like 优先 Unix domain socket，Windows 使用受认证 loopback。operator CLI 也经服务调用。MCP stdio 使用仅有模型能力的客户端，不能带 writer credential。writer 数据目录置于 agent workspace 之外；文件权限和 capability 文件按服务身份配置。无需增加独立身份平台：这里只管理 Taric 服务权限，不管理宿主人工审批身份。

候选方案是继续让每个 adapter 直接创建 AuthorityStore。它会重复权限判断，并将 DB handle/writer 泄漏给模型工具所在进程，因此不采用。插件与不可信 shell 共享同一 OS 身份时，API capability 不能提供 OS 隔离；安装文档须说明宿主 sandbox/profile 的责任，Taric 不实现 sandbox 管理器。

### 2. One contract registry, three executable entry surfaces

`packages/schemas` 发布 domain、request、response、错误与 adapter 契约，并生成/共享类型。使用既有 Ajv 2020 helper，补齐严格字段与格式校验。服务内部在持久化前再次执行契约及引用/状态/权限硬门；transport 预验证不能替代它。

CLI 增加 package `bin`、参数解析、输入 JSON/schema 验证、JSON 输出、stderr 错误与非零退出码。MCP 使用官方 SDK 实现 stdio initialization/tools/list/tools/call；stdout 不混入日志。native adapters 使用相同客户端操作，不复制 admission 规则。

首发操作目录限定为设计 §12 的 Phase 1 子集：init/status；context/query/as-of/continue；capture/proposal list/submit/checkpoint.propose；review/admission/promotion/transition；受限 draft/patch CAS proposal；control/access；WorkRun claim/heartbeat/renew/reclaim/checkpoint/resume；action recommend/host decision/result/reconcile；audit verify/doctor/reconcile；一致 snapshot export；Pi diagnostics。完整 resource revision/relation/impact、snapshot import/round-trip、migration/backup/restore、DeepSeek/Hermes adapter management、PostgreSQL operations 均返回 `unsupported_capability`，并在 follow-up 中实现。MCP 仅注册设计中的受限 read/context/proposal/checkpoint.propose/control proposal/action.recommend 工具。

不引入通用任意 SQL/file/write API，也不实现第二套 CLI policy。宿主 checkpoint 的 operator 诊断/调用仍需当前 lease 和 host authority，不能用 CLI 绕过。

### 3. Short atomic writer transactions and durable history

SQLite 继续使用 WAL 和短 `BEGIN IMMEDIATE` 写事务。事务内统一执行版本/owner/lease/generation 校验、ID 分配、record/revision/event/idempotency/outbox 更新。把事务外 CAS、review/promotion 检查移入事务；外部 LLM/tool/Git/RPC 不占用数据库写锁。

UUIDv7 是主键；display alias 由安装级唯一 allocator 在创建实体时分配，后续 revision 保持同一 alias。显式唯一约束防止碰撞，caller `display_id` 被拒绝。幂等表绑定 principal/operation/key 与规范化请求 hash，同 key 不同 payload 返回冲突。proposal 的 id + content hash 重试同样保持幂等。

事件采用版本化 canonical JSON，包含足够恢复状态的变更数据与输入/证据 hash；使用 `SHA256(prev_hash || canonical_event)`。proposal/review/reject/admit/retract/supersede/reclaim/checkpoint/action/recovery 均记录 attribution。对派生索引 drift 的修复用显式 reconcile；权威漂移阻塞写入并给出 operator 恢复报告，不静默覆盖历史。

不增加签名密钥系统。hash chain 用于内部一致性检测，不能声称它能抵抗同时改写整个数据库的攻击者。

### 4. Real as-of reads and budgeted context

当前 snapshot 的 `seq + current records` 不能提供历史一致性。实现版本记录的 sequence 范围或等价 event materialization，在同一只读事务固定 `read_seq`。查询、Context Pack、Brief/Index manifest 与 graph/search generation 都返回 committed/projected/indexed 水位。read-your-writes 在 authority 路径满足，索引滞后显式标记。

Context Builder 按 scope/ROE、WorkItem 目标和验收、恢复 checkpoint、相关 delta、直接实体/证据、背景摘要的顺序选择。预算明确为 tokens 或字符，token estimator 和 builder 版本写入 manifest。强制内容不能容纳时返回最小预算/结构化错误，不静默丢弃强制约束。源 ID、hash、时间、revision、slice metadata、截断范围和权限一并固定。

cursor 绑定 principal、engagement、filters、sequence、排序位置和 budget 单位；续页不得更换快照或跳过未返回项。独立 reviewer pack 从同一证据快照生成，排除先前 reviewer 的结论正文。

### 5. Phase 1 domain boundary and follow-up handoff

Phase 1 只固定 Observation 不可变、Evidence 引用、Claim/Finding provenance 和最小 Resource/Scope 归属。不得用当前记录覆盖历史 observation，也不得把自然语言摘要当成 finding 证据。完整 ResourceRevision/Relation/PatchSet/TestHypothesis/AttackPath、HTTP variant identity 和冲突合并交给 `evolve-engagement-memory`。

首发的 patch surface 只接受 schema 定义的受限 proposal/CAS 更新，禁止静默 last-write-wins；遇到不支持的 revision/merge 操作返回 `unsupported_capability`。PatchSet 三方合并、冲突队列和 typed relation history由 `evolve-engagement-memory` 完成。

首发只记录直接状态变更、stale/retract 事件和宿主可见的阻塞建议；不实现跨实体依赖传播。ImpactEvent、revalidation queue、bounded fan-out、context/index invalidation 和历史影响图由 `evolve-engagement-memory` 完成，且不能因此改变首发的 no-auto-scheduling 边界。

### 6. Control semantics and coverage are structured guards

首发将最小 ProtectiveControl、ControlObservation、AccessDecisionObservation 和非秘密 auth/session metadata 接入同一 writer，保存可用的控制/资源/身份版本引用或显式 unknown、operation/network conditions 和 evidence。unknown 不伪造控制或源站归因；origin reached 必须有证据；edge block + origin not reached 必须是 blocked_by_control。完整控制 revision、applicability 和依赖传播由 `evolve-engagement-memory` 完成。

阴性结果使用 method/baseline/control/conditions/identity/time/limitations 的结构检查，移除“字符串含未字”的真实性判断。首发 Coverage cell 只保存已声明的 resource/test category/identity/operation/conditions，不生成完整 profile 或矩阵笛卡尔积；一次结果仅更新匹配 cell。关闭 WorkItem/报告前提供未测、阻塞、edge control、仅阴性、未验证阳性、矛盾证据和未完成外部结果的 gate 摘要。gate 不决定宿主动作是否允许。

### 7. Host-driven WorkRun/Attempt and action recovery

claim 创建 Attempt；renew 更新 heartbeat/expiry；reclaim 在一个事务中标记旧 Attempt lost、递增 generation，并按状态机更新 owner。旧 Attempt 的 draft 归属不可改变，新 owner 不能将其当已提交事实。checkpoint 验证完整最低字段：scope/目标版本、完成步骤、观察/evidence、阴性结果、未决假设、宿主决策/外部动作状态、下一步、预算、draft/handoff、context manifest、WorkItem/Attempt/host/agent/dispatch、lease、generation 和 `read_seq`；所有首发写端使用同一 fencing guard。

resume 从最后已提交 checkpoint 生成 packet，附固定来源 sequence、当前 scope/WorkItem/宿主引用检查、pending actions 与 context manifest；不能确认前提仍有效或 source sequence 已变化时返回 blocked/replan-required，完整依赖 delta 和 draft rebase 由 `evolve-engagement-memory` 承担。未知外部结果先由宿主查询/核对并回报，Taric 不重放工具。迟到结果独立隔离并完整保留原 attempt/generation，不自动进入新 Attempt 的观察或事实。

`action.recommend` 是基于输入、scope/coverage/claim 限制及宿主提供的 advisory 信息生成的结构化建议，不增加 Taric 内置模型调用。三模式不设全局默认；host decision/result 记录具有 idempotency、owner/Attempt/generation 和合法迁移。推荐不是授权，host_hitl 只保存 opaque host reference。

### 8. Atomic projections and local Git checkpoints

outbox worker 从固定 authority snapshot 生成类型化白名单视图。Brief 展示 scope/任务/阻塞/handoff/delta，Index 展示资产/假设/coverage/conflict 导航。敏感字段、未审 proposal、草稿和默认 L1 普通事实视图全部过滤；引用仅暴露允许的 opaque metadata。

整代写入不可变 generation 目录，manifest 记录 file hashes、schema/policy、entity list、ledger sequence。校验后原子替换 current pointer；不先删除 reader 正在读的目录，保留到 reader pin/lease 结束。ACL 服务按 principal + engagement + generation 查询，客户端不能传任意文件路径或权限 boolean。

默认提交白名单 generation 到本地 Git，commit 绑定 manifest/authority seq；Git 错误记录 pending 并按 outbox retry，不回滚 authority。本 change 不实现远端 push 或外部 secrets scan；相关请求返回 `unsupported_capability`，不把配置 boolean 当扫描或推送结果。`evolve-engagement-memory` 必须按设计要求验证私有 repo/access/retention 和该 generation 的真实 scan result，才能启用远端共享。

### 9. Native adapter support follows runtime evidence

Pi adapter 从 facade 改为宿主 extension entry point + Core client，登记真实 lifecycle callbacks。DeepSeek/Hermes 不在本 change 内实现；由 `integrate-native-host-adapters` 交付并在本 change 的 compatibility manifest 中标为 unsupported。接口来源/version/commit 仍须冻结，避免将占位描述误当支持。

Pi 宣称支持的版本必须在真实 host extension API 下通过 session/context/proposal/checkpoint/action/result/cancel/error tests；仅模拟对象或数组存在不计 supported。DeepSeek/Hermes 及未测 Pi 版本明确 unsupported；MCP/CLI 只宣称实际可用的 capabilities。

安装/移除操作只管理 Taric adapter 文件及配置，不安装另一套 host runtime、不修改 Hermes provider 选择。health/version 诊断包含 service connection、contract version、host version/commit、已测试/缺失 capabilities。

### 10. Follow-up storage boundary

单机完成标准只包含 Phase 0–1。PostgreSQL 不属于本 change 的实现或发布门槛；其完整任务由 `add-shared-authority-backend` 承担。首发只需定义 SQLite storage interface、schema compatibility guard 和 conformance fixtures；不作 import/migration/backup/restore，不能宣称多机已实现。

若本 change 进入归档，所有 follow-up 引用必须存在且未实现项仍标为 unsupported；不得将后续 change 的任务勾为本 change 完成，也不得修改 normative docs 掩盖差距。

### 11. Evidence-based completion and release evaluation

测试随模块落地。CLI/MCP 必须以已打包 bin 子进程验证，adapters 必须真实加载，storage 使用独立进程并发与故障注入。clean checkout 的测试命令先 build，不能依赖留存 dist。

versioned fixture corpus 在本 change 覆盖 Phase 1 的 positive/negative、blocked-by-control、stale、conflict、伪造引用和 poisoning 安全不变量；记录 fixture/schema/policy 版本。release report 必须通过设计 §15.4 的 100-worker 零重复/唯一事件、零 L2 bypass、所有 coverage gap 可见、active WorkRun 可恢复、单机 patch 可见 p95 ≤2s 等确定性门槛。precision/recall、人工 baseline、95% CI、完整 poisoning corpus 由 `validate-memory-quality` 负责；本 change 不把未完成评估写成通过。

## Risks / Trade-offs

- [现有数据不满足新 schema] → 首发拒绝不支持的 schema 并报告 recoverable error；保留数据，不隐式导入/迁移，也不靠补默认值把旧数据升级为 L2。迁移由 `evolve-engagement-memory` 承担。
- [同一 OS 用户的任意 shell 可访问服务文件] → 服务目录/credential 与 workspace 分离；文档标明宿主 sandbox 责任，不把插件能力声明当 OS 隔离。
- [强制 context 超预算] → 返回所需最小预算及缺项；不丢 scope/验收/恢复条件。
- [异步 projection/index/Git 滞后] → 返回水位与 pending 状态；read-your-writes 走 authority，outbox 可重试。
- [影响图过大或缺少依赖边] → 有界 fan-out/分页与 pending impact；显式提示依赖覆盖限制，不把全 engagement 自动撤销当简化实现。
- [preview host API 变化] → 独立版本锁定、真实 contract tests 与显式 unsupported/MCP fallback。
- [评估数据不足] → 报告样本量/CI 与限制，安全不变量使用确定性测试；不以小样本成功代替完整发布门槛。

## Migration Plan

1. 先建立 Phase 0 baseline、single-host compatibility manifest、schemas、schema compatibility guard、unsupported registry 和 contract tests；保持现有基础模块可构建。
2. 首发只打开当前受支持 schema 的 SQLite authority；遇到旧版或不明 schema 在写入前拒绝并报告 recoverable error，不隐式导入或迁移。import/migration/backup/restore 由 `evolve-engagement-memory` 承担。
3. 引入独立 Core service 和 scoped clients，替换 CLI/MCP/Pi 的直接 store 调用；删除公共 writer/DB handle 暴露，不提供兼容 bypass。
4. 按 P1→P2→P3→P4 顺序补齐 governance、minimum controls/context、WorkRun/action、CLI/MCP/Pi、projection/local Git；每组以本 change 的测试和 release evidence 关闭。
5. 生成 clean-checkout release report；未支持的 DeepSeek/Hermes、完整 graph/impact、quality evaluation、PostgreSQL 仅记录 follow-up 引用和 unsupported diagnostics。
6. 首发故障时保留 authority、报告 repair-required 并阻塞不安全写入，不执行隐式恢复导入；投影/Git 可从当前受支持 authority 重试生成，宿主外部动作只对账，不自动逆转或重放。
