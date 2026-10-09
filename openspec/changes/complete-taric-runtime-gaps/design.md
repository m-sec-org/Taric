# Design

## Context

本文依据 `docs/taric-design.md` 的实现目标、Phase 0–5 和验收要求，补齐当前代码与设计之间的差距。动机见 `proposal.md`。本变更是规划工件，不代表下表中的能力已经实现。

当前代码已具备 TypeScript workspace、SQLite WAL、基础记录/提案/审核表、部分 CAS/租约/审计方法、字符预算 Context Pack、Markdown 输出和 adapter facade。它可以作为后续实现的起点，但不能作为完整 API、CLI、MCP 或原生插件交付。

上一变更 `build-taric-memory-core` 已归档。其任务勾选只记录当时的工作状态；本次以当前入口、数据流和测试实际覆盖范围重新建立完成标准。既有 main specs 是最低契约，本变更的 delta 补齐可验证行为。

### Current Implementation Gap Matrix

状态按源代码和测试检查判断。未运行真实宿主和性能基准的能力，不声明已验证。

| 设计依据 | 当前代码证据/状态 | 剩余差距 | 对应 spec / tasks |
|---|---|---|---|
| §4.1/§12 三种接入层 | `packages/cli/src/index.ts` 仅导出命令数组；`packages/mcp/src/index.ts` 仅导出工具数组 | 无 executable/bin、参数解析、dispatch、MCP initialization/list/call 与 stdio 服务 | `taric-runtime-api`；10 |
| §4.1.1/§13 writer 隔离 | `AuthorityStore.commit` 和 `.db` 公开；`TaricAdapterFacade.store` 公开 | model/adapter 可取得 canonical writer；缺少 transport-verified principal/capability 与 engagement ACL | `taric-runtime-api`、`memory-governance`；4 |
| §6/§10 完整契约 | `core.schema.json` 只有基础 `$defs`；Ajv helper 未接入 store 写边界 | 多个领域类型缺失；scope、引用类型、时间、状态、provenance 与跨字段硬门不完整 | `engagement-memory`；2、5、8 |
| §5/§7 admission | `admitProposal` 在事务外检查版本，随后独立 commit 和更新 proposal；validation callback 可省略 | submission/review/reject/admission 全路径原子性、必选 policy、幂等 payload 冲突和拒绝审计 | `memory-governance`、`authority-storage`；3、5 |
| §5.3 L2 review | `submitReview` 接受自报 reviewer；主要检查作者和 proposal hash | reviewer capability、验证 worker 隔离、原始证据固定快照、A/B 上下文隔离及 L2 原子 promotion | `memory-governance`；5 |
| §7.2 全局 ID | store 已使用 metadata 序列，但接受 caller `display_id`，更新也消耗序列；未有唯一 display 约束 | 服务分配、逻辑实体 alias 稳定、唯一约束、持久并发/重启及幂等校验 | `authority-storage`；3 |
| §7.1.1 CAS/快照 | `compareAndSet` 在事务外读版本；`snapshot` 先读 seq 再读 current records | 条件更新、实际 as-of 历史、同一 read transaction、read-your-writes 与水位 | `authority-storage`；3、7 |
| §8 审计/恢复 | 部分操作记录 hash event；`verifyAudit` 仅检查 hash chain；outbox 无消费流程 | 所有状态事件、canonicalization、可重建记录、counter/outbox/view/权限漂移检查、doctor/replay/reconcile | `memory-governance`、`authority-storage`；3、5、11 |
| §4.4 Context Pack | `context.ts` 按记录顺序估算 JSON 字符；cursor 字符串没有续取 API | WorkItem 强制信息优先、来源 manifest、budget 单位、固定 seq 分页、摘要引用与相关 delta | `engagement-memory`；7 |
| §4.6 图持续演进 | 当前记录可覆盖更新，relation 为基础类型 | 稳定 resource identity/variant、immutable revisions、PatchSet read/write set、三方合并与冲突队列 | `engagement-memory`；6 |
| §4.6/§4.8 影响传播 | `markStale` 是单对象更新 | 按 criticality/字段依赖定向传播、ImpactEvent、revalidation 队列、Context/index 失效与 finding recall 降级 | `engagement-memory`；6、8 |
| §4.8 防护模型 | 无 ProtectiveControl/revision/ControlObservation/AccessDecision schema 与操作 | 版本和条件绑定、unknown 归因、origin evidence、suspected 指纹、不可变观察与适用性重算 | `engagement-memory`；8 |
| §9 coverage | `coverage.ts` 提供基础函数；阴性判断依赖句中是否有“未/not observed” | resource revision/identity/operation/conditions 矩阵、baseline/limitations、bounded negative、coverage close gate | `engagement-memory`；8 |
| §4.3 WorkRun/Attempt | 有 claim/checkpoint 表与部分 generation 校验 | Attempt 实体、WorkItem 引用、状态机、heartbeat/renew、原子 reclaim/lost、agent/dispatch owner 校验 | `collaboration-state`；9 |
| §4.3 checkpoint/resume | checkpoint 接受任意对象；resume 返回最新 checkpoint/actions/current seq | schema/证据验证、context manifest、scope/依赖/host-ref 复核、checkpoint delta、draft 封存/rebase | `collaboration-state`；9 |
| §4.3 全写路径 fencing | checkpoint 有检查；action 只查 generation 且在事务外；late result 无完整审计 | proposal/observation/evidence/patch/decision/result 同事务 fencing；独立迟到结果隔离和对账 | `collaboration-state`、`host-action-integration`；4、9 |
| §12/§16 动作建议 | `recordActionIntent` 保存状态；没有 recommendation handler | 三模式输入、结构化建议/限制、host decision/result 归属、合法迁移、idempotency 与未知结果对账 | `host-action-integration`；9、10 |
| §4.5 projection | `projection.ts` 两份同构 JSON Markdown；先删 current 再 rename；读权限是 caller boolean | Brief/Index 分工、L0/L1 trust gating、类型白名单、manifest、保留旧 generation、真实 ACL/path 校验 | `markdown-projection`；11 |
| §4.5/§16 Git | 仅计算 `remotePushAllowed` 布尔值，没有 Git commit/push | 默认 local checkpoint、manifest/seq 绑定、pending/retry、engagement opt-in 与真实 secrets 扫描结果 | `markdown-projection`；11 |
| §4.2/§14 native adapters | Pi/DeepSeek 创建 facade；Hermes 只 describe/translate events | 真正 hook registration、受认证 Core RPC、安装/移除/配置/诊断、锁定 host metadata、runtime contract tests | `host-adapters`；12 |
| §14.3/§7 snapshot/migration | 无原生 snapshot import/export 或版本迁移流程 | JSON/JSONL round-trip、完整性/冲突检查、replay/projection rebuild 和可恢复升级 | `authority-storage`；3 |
| §14.5 多主机 | 仅 SQLite | 条件交付 PostgreSQL/server-side lease/order/backup/restore；不能用共享 SQLite/Git 代替 | `authority-storage`；14（条件阶段） |
| §15 测试/发布 | tests 主要直接调用 store/facade；根 `npm test` 不先 build | clean checkout、CLI/MCP 子进程、真实宿主、100 并发、crash/poisoning 与统计评估报告 | `quality-evaluation`；各组测试 + 13 |
| §14.0 版本基线/§16 文档 | 设计声明来源/接口策略；README/API 文档先于可执行入口 | 固定参考与宿主来源版本、运行能力矩阵、命令示例/支持状态与代码对应 | `host-adapters`、`quality-evaluation`；1、各组文档 |

## Goals / Non-Goals

**Goals:**

- 每个公开操作有唯一的版本化契约、服务入口和权限判断；CLI/MCP/adapters 调用同一 Core 规则。
- 权威写入、读快照、协作恢复和投影恢复分别可验证；不得用审计恢复替代任务恢复。
- 以当前模块为起点补齐行为。SQLite 单服务为首发；多主机能力按原设计的条件阶段保留。
- 每项任务随实现交付测试与接入文档；“已实现”必须对应可执行入口和可重复证据。

**Non-Goals:**

- 不实现 agent loop、worker 调度、模型供应商调用、目标系统工具执行或防护绕过。
- 不签发动作授权；三种动作模式由宿主选择，Taric 只提供建议和记录宿主决策/结果。
- 不建立人的身份或 HITL 审批系统，不托管审计签名密钥。
- 不管理 Artifact 内容、保留、脱敏或凭据。远端 Git 扫描仅覆盖 Taric 将要发布的投影，不是 Artifact scanner。
- 不实现旧 KB/Link runtime、格式兼容或跨 Engagement 自动知识共享。

## Decisions

### 1. Single Core service with scoped clients

在 `packages/core` 中建立服务层，封装 storage 和 writer；保留现有 store 代码作为内部持久化实现。model、host adapter、operator 使用不同 capability。服务从本机 transport 验证 principal，body 中的 host/reviewer/engagement/attempt 只作为需要交叉核验的归属数据。

Unix-like 优先 Unix domain socket，Windows 使用受认证 loopback。operator CLI 也经服务调用。MCP stdio 使用仅有模型能力的客户端，不能带 writer credential。writer 数据目录置于 agent workspace 之外；文件权限和 capability 文件按服务身份配置。无需增加独立身份平台：这里只管理 Taric 服务权限，不管理宿主人工审批身份。

候选方案是继续让每个 adapter 直接创建 AuthorityStore。它会重复权限判断，并将 DB handle/writer 泄漏给模型工具所在进程，因此不采用。插件与不可信 shell 共享同一 OS 身份时，API capability 不能提供 OS 隔离；安装文档须说明宿主 sandbox/profile 的责任，Taric 不实现 sandbox 管理器。

### 2. One contract registry, three executable entry surfaces

`packages/schemas` 发布 domain、request、response、错误与 adapter 契约，并生成/共享类型。使用既有 Ajv 2020 helper，补齐严格字段与格式校验。服务内部在持久化前再次执行契约及引用/状态/权限硬门；transport 预验证不能替代它。

CLI 增加 package `bin`、参数解析、输入 JSON/schema 验证、JSON 输出、stderr 错误与非零退出码。MCP 使用官方 SDK 实现 stdio initialization/tools/list/tools/call；stdout 不混入日志。native adapters 使用相同客户端操作，不复制 admission 规则。

操作目录覆盖设计 §12、§4.6、§14.2：init/status；context/query/as-of；capture/proposal/review/admission；resource revision/draft/patch/relation/claim/impact；control/access；WorkRun claim/renew/checkpoint/resume；action recommend/host decision/result/reconcile；audit/reconcile/snapshot；adapter install/remove/config/health/version。MCP 仅注册设计中的受限 read/context/proposal/checkpoint.propose/control proposal/action.recommend 工具。

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

### 5. Typed revisions, bounded merges, and targeted impact

完成 ResourceRevision/Relation/PatchSet/TestHypothesis/AttackPath 等 schema。原始 Observation 不可变；理解更新生成新 revision。HTTP logical identity 和 principal/tenant variant 显式建模，不以自然语言段落替代高影响 claim。

PatchSet 使用 base_generation/base_version/read_set/write_set。叙述按基线做三方合并；独立字段可合并；集合新增幂等并集；删除、scope/status/互斥事实必须显式 CAS。冲突保留双方值及来源，进入 conflict queue，不由 timestamp 静默选取。

ImpactEvent 沿 `depends_on/derived_from` 与字段/criticality 定向传播，区分普通描述 stale 与关键证据撤销。大扇出使用有限批次和 continuation，未完成时暴露 pending watermark。finding/report/recommendation 的当前适用性、context/index 缓存失效使用事件和派生视图表达，历史 observation/checkpoint/host decision 保持原值。Taric 返回 revalidation WorkItem 建议，宿主决定调度。

### 6. Control semantics and coverage are structured guards

将 ProtectiveControl/revision、ControlObservation、AccessDecisionObservation 和非秘密 auth/session metadata 接入同一 writer。观察绑定控制/资源/身份版本、operation/network conditions 与 evidence。unknown 不伪造控制或源站归因；origin reached 必須有证据；edge block + origin not reached 必須是 blocked_by_control。

阴性结果使用 method/baseline/control/conditions/identity/time/limitations 的结构检查，移除“字符串含未字”的真实性判断。Coverage 按资源 revision × test category × identity × operation/parameter × conditions 建 cell。关闭 WorkItem/报告前提供未测、阻塞、edge control、仅阴性、未验证阳性、矛盾证据和未完成外部结果的 gate 摘要。gate 不决定宿主动作是否允许。

### 7. Host-driven WorkRun/Attempt and action recovery

claim 创建 Attempt；renew 更新 heartbeat/expiry；reclaim 在一个事务中标记旧 Attempt lost、递增 generation、封存旧 draft，并按状态机更新 owner。checkpoint 验证 schema、WorkItem、Attempt、host/agent/dispatch、lease、source sequence、evidence/result refs；任何写端使用同一 fencing guard。

resume 从最后已提交 checkpoint 生成 packet，附相关 delta、scope/目标/依赖失效、pending actions 与 context manifest。未知外部结果先由宿主查询/核对并回报，Taric 不重放工具。迟到结果独立隔离、完整保留原 attempt/generation，仅通过新 proposal/rebase 使用。

`action.recommend` 是基于输入、scope/coverage/claim 限制及宿主提供的 advisory 信息生成的结构化建议，不增加 Taric 内置模型调用。三模式不设全局默认；host decision/result 记录具有 idempotency、owner/Attempt/generation 和合法迁移。推荐不是授权，host_hitl 只保存 opaque host reference。

### 8. Atomic projections and local Git checkpoints

outbox worker 从固定 authority snapshot 生成类型化白名单视图。Brief 展示 scope/任务/阻塞/handoff/delta，Index 展示资产/假设/coverage/conflict 导航。敏感字段、未审 proposal、草稿和默认 L1 普通事实视图全部过滤；引用仅暴露允许的 opaque metadata。

整代写入不可变 generation 目录，manifest 记录 file hashes、schema/policy、entity list、ledger sequence。校验后原子替换 current pointer；不先删除 reader 正在读的目录，保留到 reader pin/lease 结束。ACL 服务按 principal + engagement + generation 查询，客户端不能传任意文件路径或权限 boolean。

默认提交白名单 generation 到本地 Git，commit 绑定 manifest/authority seq；Git 错误记录 pending 并按 outbox retry，不回滚 authority。远端 push 仅在 engagement 显式配置私有 repo/access/retention 且对该 generation 的真实 secrets scan 通过后执行。扫描使用可配置外部扫描器/宿主回调，并记录工具版本/result hash；缺少或失败时不推送，不把配置 boolean 当扫描结果。

### 9. Native adapter support follows runtime evidence

Pi 和 DeepSeek adapters 从 facade 改为宿主 extension entry point + Core client，登记真实 lifecycle callbacks。Hermes 交付 Python general plugin + RPC client，不替换 external memory provider。接口具体版本在实现组开始前固定来源/version/commit，并写入 compatibility manifest。

每个宣称支持的版本必须在真实 host extension API 下通过 session/context/proposal/checkpoint/action/result/cancel/error tests；仅模拟对象或数组存在不计 supported。DeepSeek preview adapter 独立发布，未测版本明确 unsupported；MCP/CLI 降级只宣称其确实可用的 capabilities。

安装/移除操作只管理 Taric adapter 文件及配置，不安装另一套 host runtime、不修改 Hermes provider 选择。health/version 诊断包含 service connection、contract version、host version/commit、已测试/缺失 capabilities。

### 10. Phase 5 remains conditional

单机完成标准包含 Phase 0–4；PostgreSQL 位于任务组 14，只在部署明确需要多主机 authority 时启用。组 14 以共享 storage conformance 测试验证事务、CAS、ID、event ordering、server-side lease/fencing、快照及备份恢复。不能因组 14 未启用而否认已通过的单机发布门槛，也不能宣称多机已实现。

若本 change 在单机范围内进入归档，组 14 的完整 spec/task 必须先迁入独立 follow-up change 并记录引用；不能把未实现条件任务勾为完成。此规则保留所有剩余设计目标且避免影响首发。

### 11. Evidence-based completion and release evaluation

测试随模块落地。CLI/MCP 必须以已打包 bin 子进程验证，adapters 必须真实加载，storage 使用独立进程并发与故障注入。clean checkout 的测试命令先 build，不能依赖留存 dist。

versioned fixture corpus 覆盖 positive/negative、web/host、身份/租户/过期/控制阻断/伪造引用/反证/poisoning；记录人工 baseline、样本量和 95% CI。项目 release report 对应设计 §15.4 的 100 并发零重复/唯一事件、零 L2 bypass、高/严重 unsupported-claim 0、known-positive 不劣于基线、所有 coverage gap 可见和单机 patch 可见 p95 ≤2s。Taric 的评估只测自身记忆/治理对这些结果的贡献，不承诺代替宿主扫描能力。

## Risks / Trade-offs

- [现有数据不满足新 schema] → 迁移先 dry-run/报告；保留原记录并显式 quarantine，不靠补默认值把旧数据升级为 L2。
- [同一 OS 用户的任意 shell 可访问服务文件] → 服务目录/credential 与 workspace 分离；文档标明宿主 sandbox 责任，不把插件能力声明当 OS 隔离。
- [强制 context 超预算] → 返回所需最小预算及缺项；不丢 scope/验收/恢复条件。
- [异步 projection/index/Git 滞后] → 返回水位与 pending 状态；read-your-writes 走 authority，outbox 可重试。
- [影响图过大或缺少依赖边] → 有界 fan-out/分页与 pending impact；显式提示依赖覆盖限制，不把全 engagement 自动撤销当简化实现。
- [preview host API 变化] → 独立版本锁定、真实 contract tests 与显式 unsupported/MCP fallback。
- [评估数据不足] → 报告样本量/CI 与限制，安全不变量使用确定性测试；不以小样本成功代替完整发布门槛。

## Migration Plan

1. 先建立 baseline manifest、schemas、storage migrations 和 contract tests；保持现有可用的基础模块。
2. 对现有 SQLite store 导出备份快照并运行 migration dry-run；验证 schema/reference/provenance，无法验证的历史输入进入 quarantine。建立 version/event materialization 与唯一 alias 约束。
3. 引入独立 Core service 和 scoped clients，替换 CLI/MCP/adapters 的直接 store 调用；删除公共 writer/DB handle 暴露。旧 public writer 不提供兼容 bypass。
4. 分模块补齐 governance、context、revision/impact、controls、WorkRun/action、projection/Git 与 native adapters；每组通过自身测试并更新 README/API/agent guide。
5. dry-run replay/reconcile 与 snapshot round-trip；通过完整单机 release report 后发布。PostgreSQL 按条件阶段独立启用和验证。
6. 回退使用升级前的已验证数据库快照及匹配服务版本；已发布新事件不通过原地删除回滚。投影/Git 可重建，宿主外部动作只对账，不自动逆转或重放。
