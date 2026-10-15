# Taric 源码实现分析：亮点、差距与优化建议

- 分析日期：2026-10-14
- 分析对象：`23c6783`（HEAD）工作区源码
- 评估基准：
  - `openspec/specs/` 全部 13 个现行能力规格（engagement-memory、memory-governance、collaboration-state、host-action-integration、host-adapters、markdown-projection、authority-storage、advanced-context-recovery、engagement-memory-evolution、memory-quality-evaluation、quality-evaluation、shared-authority-backend、artifact-content-storage）；
  - `openspec/changes/archive/` 全部 7 个已完成并归档的变更（build-taric-memory-core、complete-taric-runtime-gaps、evolve-engagement-memory、integrate-native-host-adapters、validate-memory-quality、add-shared-authority-backend、add-artifact-content-storage）；
  - `docs/taric-design.md` 的边界定义（§1–§3）、架构约束（§2.1、§4）、治理与状态机（§5–§10）和验收标准（§15、§16）。
- 分析方式：源码逐模块走读（core 8,200+ 行、schemas、cli、mcp、hermes-plugin）+ 规格/设计条款逐项对照 + 本地验证。
- 本地验证记录：`npm run typecheck` 通过；`npm run build` 通过；`npm test` 通过（schemas 19、core 182 其中 1 项 PostgreSQL live 测试在无 `TARIC_TEST_DATABASE_URL` 环境时按设计跳过、cli 8、mcp 8；Hermes 插件 `python3 -m unittest` 5 项通过）。

---

## 目录

1. [总体结论](#1-总体结论)
2. [能力符合度总表](#2-能力符合度总表)
3. [实现亮点](#3-实现亮点)
4. [差距分析](#4-差距分析)
5. [优化建议方案](#5-优化建议方案)
6. [附录：证据索引](#6-附录证据索引)

---

## 1. 总体结论

Taric 当前实现**整体质量高于同类"记忆插件"的常见水准**：规格中的核心不变量——零 LLM 直写权威层、proposal→review→admission 治理流水线、L0/L1/L2 分级信任、证据引用与覆盖闭环、WorkRun/Attempt 租约与 generation fencing、append-only 哈希链审计、字段白名单最小投影、opaque Artifact 任务会话存储——均已在代码中落地，并且有相当数量的对抗性测试（投毒、越权、崩溃注入、并发 CAS、发布门槛）支撑。七个归档变更的主线任务全部可追溯到具体实现与测试，归档声称与代码基本一致。

与规格之间的主要差距集中在四个层面：

1. **运行时集成断层**：PostgreSQL shared authority 只有独立存储类与守卫/发布证据构造器，未接入 CoreService/CLI/MCP 运行时；能力清单（compatibility manifest、`service.deferred`、`docs/agent-integration.md`）仍把已归档交付的能力标为 unsupported，注册表已发生漂移。
2. **写路径与读路径的规模上限**：canonical commit 与 admission 在每次写入时全表加载 `object_refs`/`records` 做引用校验，as-of snapshot 全量加载 `record_versions`；在长周期、大记录数 Engagement 下会退化，而现有 p95 发布门槛只在小数据集上验证。
3. **个别治理不变量与规格的精确偏差**：canonical 主键仍由 caller 提供（规格要求 writer 分配）；proposal 在提交期只做最小校验，完整 schema/引用校验推迟到 admission。
4. **运维与文档一致性**：MCP 默认 `:memory:` 数据库、context cursor 进程内随机密钥重启即失效、adapter RPC 一连接一请求、`taric-design.md` §16 与 authority-storage 规格中个别段落落后于已交付实现。

上述差距均不推翻当前单机首发（`single_host_taric_plugin_v1`）的可用性结论；但其中能力注册表漂移、canonical ID 归属、写路径性能三项应在扩大宿主接入与数据规模前优先处理。

---

## 2. 能力符合度总表

| 规格 | 符合度 | 主要证据 | 主要差距 |
|---|---|---|---|
| engagement-memory | 高 | `store.ts` 记录/引用/生命周期、`context.ts` 信任过滤、`coverage.ts` 覆盖与控制观测 | canonical ID 由 caller 提供（规格要求 writer-owned）；proposal 提交期校验最小化 |
| memory-governance | 高 | `policy.ts` 硬门、`store.submitReview/promoteFinding`、审计链、特权字段拒绝 | 同上 canonical ID；审计签名按设计排除（非差距） |
| collaboration-state | 高 | `claimWorkRun/renew/reclaim`、`commitCheckpoint`、`resumePacket`、迟到结果隔离、checkpoint 禁隐藏推理 | 基本符合 |
| host-action-integration | 高 | `recordActionIntent` 状态机、幂等、unknown reconcile、三 mode | 基本符合 |
| host-adapters | 高 | `adapter.ts`/`pi-adapter.ts`/`deepseek-adapter.ts`/`adapter-rpc.ts`/Hermes 插件、truthful fallback | RPC 传输一连接一请求、单行 1MiB；并发吞吐受限 |
| markdown-projection | 高 | `projection.ts` 白名单、generation 原子发布、reader pin、本地 Git 默认、remote push 需真实 scanner callback | 基本符合 |
| authority-storage | 高 | WAL 事务、CAS、pinned snapshot、doctor/replay/rebuild、snapshot export/import | 规格中"doctor 不校验 spool"段落已落后于实现（Artifact 对账已交付） |
| advanced-context-recovery | 高 | cursor 绑定 principal/engagement/filters/seq + TTL、resume delta、draft seal/rebase、snapshot 往返 | cursor 密钥进程内随机（重启失效）；预算为字符估算 |
| engagement-memory-evolution | 高 | resource revision、typed relation、PatchSet 合并/冲突证据、bounded impact continuation、control applicability | 基本符合 |
| memory-quality-evaluation | 中高 | `quality.ts`、生命周期召回、覆盖可见性、doctor/replay、投毒 fixture | manifest 将 `quality.full_statistical_evaluation` 标为 unsupported，与已交付代码漂移 |
| quality-evaluation | 中高 | 分层 precision/recall/95%CI/ECE/kappa、release report 构造器、release gate 测试 | 仓库内缺少真实人工基线盲测数据（§15.3 要求的评估证据） |
| shared-authority-backend | 中 | `PostgresAuthorityStore`、`deployment-guard.ts`、runbook、`shared-authority-release.ts` | 未接入 CoreService/CLI 运行时；语义子集（无 proposals/admission/checkpoint/action/artifact catalog）；manifest/文档仍标 unsupported |
| artifact-content-storage | 高 | 三段式上传、SHA-256 清单、不可变分片、keyset 分页、有界读取、默认视图隔离、doctor 对账 | 64MiB 单请求内存峰值；写入无显式 fsync；manifest 物理分片未实现（实现报告已注明） |

---

## 3. 实现亮点

### 3.1 单一权威与事务一致性：把"账本恢复"做成了产品能力

- **单写者短事务模型**：`AuthorityStore.transaction()` 使用 `BEGIN IMMEDIATE` + 嵌套 savepoint，记录版本、display ID、幂等结果、审计事件、outbox 在同一事务内提交（`store.ts` `commit()`），崩溃注入测试（`atomic-failures.test.mjs`）验证"要么全部提交、要么全部回滚"。
- **append-only 哈希链审计**：每个事件携带 `prev_hash` 与规范 payload 哈希，`verifyAudit()` 校验序列连续性与链完整性；治理事件统一携带 actor/host/worker/dispatch/WorkRun/Attempt/proposal/review/policy digest/input hash/idempotency key 等归属元数据，满足 memory-governance "可追溯每次 L1/L2 写入"的要求。
- **outbox + operation marker + doctor/replay/rebuild**：每个事件同步生成 outbox 行与 operation marker；`doctor()` 区分 authority 漂移与派生视图漂移，漂移时**阻塞写入**（`#writeBlocked`），恢复动作显式分为 preview/replay/rebuild，不静默改写历史。这把设计 §2.1"可重放、可恢复"从原则变成了可操作的运维面。
- **schema 版本硬门槛**：打开库时发现未版本化或不匹配的 schema 直接拒绝（`unsupported_schema_version`），符合 authority-storage "写入前失败、不静默迁移"。

### 3.2 信任治理：硬门由代码重算，模型无法自我授权

- **proposal-only 模型写入**：`submitProposal` 拒绝 caller 携带 `trust_level/display_id/admission_status/policy_result` 等特权字段；`normalizeRecord` 再次拒绝 caller 设置 trust/display；`admitProposal` 用非 LLM 硬门（schema/scope/evidence/freshness/independence，`policy.ts`）重算结果，模型 verdict 不能移动结论。
- **独立评审与证据快照钉住**：`evidenceSnapshotHash` 把 proposal 关联的 evidence/claim/counter-evidence 按 id+version+hash 钉住；self-review、过期证据、非当前证据均无法晋升 L2；`promoteFinding` 原子写 L2 并保留 review 引用。高风险/严重 finding 需要强独立性双评审。
- **fail-closed 而非 fail-open**：机审拒绝、证据缺失时 proposal 保留但 canonical 零写入；投毒测试（`poison-fixtures.test.mjs`、`release-support.test.mjs`）覆盖恶意指令注入 HTTP 响应/注释/提案、伪造引用、重复 finding 等场景。
- **迟到 Attempt 隔离**：run-scoped proposal 校验 WorkRun/Attempt/generation/owner 归属，过期或不匹配时进入 `proposal.stale_attempt_quarantine` 而非丢弃，保留原始归属——这是设计 §2.2"多 agent 独立上下文"的关键保障。

### 3.3 权限与隔离：transport 主键 + capability，杜绝请求自报权限

- `registerTransportPrincipal` 用模块级 `WeakSet` 登记 transport 创建的 principal，`authorize()` 强制 `transport_verified === true` 且在登记集合内；请求 body 不能自报角色/capability/engagement 权限。角色（model/host/reviewer/writer/operator）与操作 capability（read/propose/admit/work/checkpoint/action/content/content_read…）双层校验。
- Engagement 隔离贯穿 commit（`validateAuthorityReferences` 拒绝跨 Engagement 引用）、snapshot、context、projection 与 Artifact 会话；快照导出用敏感字段正则做二次消毒（`sanitizeSnapshotRecord`）。
- **最小投影白名单是显式集合**：`context.ts` 的 `modelFields` 白名单 + `sensitiveField` 递归过滤（token/secret/credential/raw_artifact/host_ref/url/header/cookie…），新字段默认不进模型面；projection 同样使用 allowlist 并有 canary 泄漏测试。

### 3.4 协作状态：租约、fencing 与 checkpoint 的工程细节扎实

- `commitCheckpoint` 校验 owner/generation/lease/活跃 Attempt/WorkItem 版本/scope 一致性，要求 24 个显式结果字段（空结果必须显式声明），递归拒绝隐藏推理字段（`checkpointForbiddenFields`）——直接落实"checkpoint 不得依赖隐藏模型推理"。
- `resumePacket` 返回固定 read_seq/manifest、当前水位、owner/Attempt/lease、未决 ActionIntent、scope/WorkItem 版本检查；scope/premise 变化时返回 blocked/replan_required，不自动续跑；unknown 动作只能由 host reconcile。
- ActionIntent 状态机（recommended→authorized/denied→executed/failed/unknown）与幂等键在事务内原子提交，denied 不可进入执行态。

### 3.5 Context Pack：预算、优先级与游标都是确定性的

- 分页 pack 按 scope/ROE → 目标 WorkItem → checkpoint → 冲突/覆盖缺口 → 领域实体的优先级装载；预算不足时强制约束退化为压缩投影，仍保 scope/ROE/验收/风险预算，背景材料被截断并显式标记 `truncated`/`omitted`。
- cursor 用 AES-256-GCM 加密并绑定 principal/engagement/filters/ordering/read_seq/budget，默认 1 小时 TTL；篡改、跨 Engagement、跨 principal 复用均拒绝。
- resume delta、draft seal/rebase（保留原 Attempt 归属，禁止同 Attempt 重放）按 advanced-context-recovery 交付。

### 3.6 Artifact 任务会话 spool：把"原文可存"做成了可审计契约

- 三段式上传（begin 声明元数据/期望字节 → append 有序 base64 分片带 per-chunk hash → commit 校验总字节与全量 SHA-256），未提交上传对读取/列表不可见。
- 物理布局：内容根 0700、会话根 0700、staging → publish 目录 rename 原子发布、UTC 日期 + ID 分片、manifest/NDJSON segment/metadata sidecar 0600；会话根唯一索引 + 路径逃逸（symlink/`..`）防护。
- SQLite 只存 catalog/chunk 定位与元数据，payload 字节永不进库、不进审计、不进投影/快照；列表 keyset 分页 + watermark；读取返回单个有界分片 + continuation cursor；`include_content` 需要额外 `content_read` capability，MCP 工具面完全没有 raw content 操作。
- 发布 marker + 启动恢复 + doctor/reconcile 对比 marker/manifest/hash/catalog 行，失败进入 quarantined，不静默修复。

### 3.7 契约驱动与三端一致性

- `@taric/schemas` 一份 60 个 `$defs` 的 JSON Schema（AJV 2020 strict 编译）作为唯一契约源；`registry.ts` 登记全部操作（角色、请求/响应契约、错误码、幂等、是否写权威、engagement-scoped、capability）；Core dispatch、CLI（44 个命令）、MCP（6 个模型工具白名单）、adapter 全部从同一注册表与同一 `service.dispatch` 走，没有第二套策略实现。
- 结构化错误码贯穿：`validation_error/authorization_error/unsupported_capability/unsupported_schema_version/idempotency_conflict/stale_version/conflict/unavailable_host/internal_error`；CLI stdout/stderr 分离、退出码 0/1/2 稳定；MCP stdout 只写协议 JSON、诊断写 stderr（并屏蔽 `node:sqlite` 实验性警告避免污染协议）。
- Pi/DeepSeek/Hermes 适配器全部"truthful fallback"：pinned 版本之外一律 unsupported，不伪造能力；Hermes 插件经 0600 Unix socket + ≥32 字符 token 的 RPC 接入，Core 不可用时抛稳定 integration error，绝不把失败报告成已保存状态。

### 3.8 测试与发布门槛工程化

- core 37 个测试文件（governance、audit-cas、atomic-failures、stale、collaboration、recovery、context-coverage、evolution-memory、postgres、artifact-content/scale、release-gates/release-support 等）+ CLI/MCP/schemas/Hermes 共约 220 项自动化断言。
- 发布门槛进入测试代码：100 并发写入 ID/event 唯一、审计链有效、CAS 冲突拒绝；L1→L2 未授权升级 100% 拒绝；`PATCH_TO_QUERY_P95_BUDGET_MS = 2000` 的 p95 延迟 gate；Git checkpoint 失败保留 pending 不回滚 authority。
- 兼容清单、非目标与安全不变量是代码常量（`compatibility.ts`），投毒输入无法修改注册表——这本身是一个被测试覆盖的安全不变量。

---

## 4. 差距分析

差距按影响分为：`阻断性`（与规格直接冲突或影响宿主决策可信度）、`重要`（影响规模/运维/长期演进）、`改进`（体验与工程卫生）。每项给出规格/设计依据与代码证据。

### G1（阻断性）能力注册表与已归档规格漂移

- **依据**：OpenSpec 以"现行 specs + 已归档 changes"为完成标准；`shared-authority-backend`、`validate-memory-quality`、`add-artifact-content-storage` 均已归档且规格在 `openspec/specs/` 生效。
- **代码证据**：
  - `packages/core/src/compatibility.ts`：`storage.postgresql` 仍为 `{ state: "unsupported", follow_up: "add-shared-authority-backend" }`；`quality.full_statistical_evaluation` 仍为 `{ state: "unsupported", follow_up: "validate-memory-quality" }`。
  - `packages/core/src/service.ts` `deferred` 表仍把 `storage.postgresql/storage.backup/storage.restore` 指向已归档 change。
  - `docs/agent-integration.md` 支持矩阵仍写 PostgreSQL 为 `unsupported_capability`。
  - 与此同时 `quality.ts`（分层 precision/recall/95%CI/ECE/kappa）与 `release-report.ts` 已交付并有测试；`PostgresAuthorityStore` 已导出并有单测/live 测试。
- **影响**：`capability.status` 是宿主接入与运维决策的信任锚。当前清单把已交付能力报为 unsupported（反向漂移），一旦未来出现"把未交付能力报为 supported"的同源问题，宿主将无法用 Taric 自身诊断区分真假。
- **严重度**：阻断性（对多宿主接入决策与规格可信度）。

### G2（阻断性）canonical 主键仍由 caller 提供，与 engagement-memory 规格冲突

- **规格依据**：engagement-memory "Canonical identity is writer-owned and immutable"——"不接受 caller 指定的 canonical UUID……writer 只保留候选来源关联并自行分配 UUIDv7，或按契约拒绝该字段"。
- **代码证据**：`store.submitProposal` 要求 `typeof proposal.content?.id === "string"`，proposal 携带的 id 在 admission 后直接成为 canonical `records.id`；README 的 Core 示例也是客户端先 `uuidv7()` 再放进 `content.id`。engagement 归属与 kind 不可变**已**正确实现，但"writer 分配主键"这一半未实现。
- **影响**：模型/host 客户端可以预选 canonical ID。虽然 schema 强制 UUIDv7、Engagement 隔离与 CAS 阻止了跨库复用与覆盖，但该偏差削弱了"主键分配是权威层职责"的治理边界，也使恶意客户端可以通过预生成 ID 对目标实体做占位/探测（存在性信息经由 stale_version/conflict 错误差异泄漏的口子虽然很窄，但规格本意是关闭它）。
- **严重度**：阻断性（规格明确 SHALL，当前实现相反；需要修代码或修订规格并说明理由）。

### G3（阻断性）PostgreSQL shared authority 未接入运行时，语义面是子集

- **规格依据**：shared-authority-backend "Equivalent PostgreSQL authority semantics"要求 transactions、conditional writes、UUID/display 分配、audit ordering、idempotency、outbox、snapshot、server-side lease/fencing、pinned reads 对外行为与 SQLite 等价。
- **代码证据**：
  - `createCoreService(store: AuthorityStore, ...)` 类型上只接受同步 SQLite store；`createCoreServiceForPath` 直接 `new AuthorityStore(filename)`。
  - `PostgresAuthorityStore`（`postgres.ts`，604 行）实现了 commit/CAS/outbox/pin/lease/audit/doctor/backup 子集，**没有** proposals/reviews/admission/checkpoints/action intents/artifact catalog 等领域操作；仅在 `postgres.test.mjs`/`postgres-live.test.mjs` 中使用，CLI/MCP/adapter 均无接入路径。
  - CLI 对 `multi_host_authority` profile 的处理是"诊断不可用即退出"（`resolveCliStartup` 对 postgres backend 传 `postgresqlAvailable=false` → blocked），不存在"探测通过则用 PostgreSQL 跑"的路径。
- **影响**：多机共享当前是"存储原语 + 守卫 + runbook + 发布证据构造器"，不是可启动的产品能力。若按规格字面验收（equivalent semantics across authority surface），未达成；若按"显式可选、未启用前 disabled"的边界解释，则至少应把运行时缺失写入 capability/文档，而不是指向已归档 change。
- **严重度**：阻断性（相对 shared-authority-backend 规格）；对单机首发不构成影响。

### G4（重要）canonical 写路径全表加载引用校验，规模扩展性受限

- **代码证据**：`AuthorityStore.commit()` 每次写入执行 `SELECT id,engagement_id,kind FROM object_refs` 与 `SELECT id,body FROM records` **全表**加载，构造内存 Map 后调用 `validateAuthorityReferences`；`admitProposal` 在 admission 时重复同样的全表加载。`list()`/`snapshot()` 对 engagement 的全部记录/全部 `record_versions` 无分页加载。
- **影响**：单次 commit 成本 O(全库记录数)。渗透测试长周期 Engagement 累积数千至上万条 observation/evidence/coverage 记录后，commit 与 admission 延迟线性恶化；`PATCH_TO_QUERY_P95_BUDGET_MS=2000` 的 gate 只在小型数据集上验证，无法证明大库下的 p95。
- **严重度**：重要（单机首发可用，但在产品定位的"数小时至数天长任务"下必然触达）。

### G5（重要）同步 SQLite 阻塞事件循环

- **代码证据**：`node:sqlite` 的 `DatabaseSync` 全同步 API；MCP stdio server 与 adapter RPC server 都是 Node 进程，长事务（大 proposal admission、artifact catalog 写入、doctor 全表校验、audit verify 全链重算）期间进程内所有连接被阻塞。
- **影响**：README 已如实声明该限制，但 MCP/adapter 是长驻服务形态，阻塞会放大为宿主超时与心跳误判；doctor/verifyAudit 这类 O(N) 维护操作与业务读写同进程竞争。
- **严重度**：重要（已声明但需要工程化缓解方案）。

### G6（重要）proposal 提交期校验最小化

- **规格依据**：engagement-memory "Every persisted type SHALL be validated at every write boundary, including required fields, allowed fields, enums, formats, engagement ownership, references, and legal state transitions"。
- **代码证据**：`submitProposal` 只检查 id/engagement 归属/特权字段/base_version，content 不做 JSON Schema 契约校验与引用存在性校验；完整校验发生在 `admitProposal`（`validateCanonicalRecord` + `validateAuthorityReferences`）。
- **影响**：无效提案会占用 proposal 存储并延迟到 admission 才失败，模型侧错误反馈滞后；同时 admission 时的引用校验失败会把 proposal 打成 rejected，而提交期本可更早给出结构化错误。属于"质量与体验"而非安全漏洞（canonical 层仍被守住）。
- **严重度**：重要。

### G7（重要）MCP 默认 `:memory:` 数据库与 CLI 默认不一致

- **代码证据**：`createMcpService()` = `process.env.TARIC_DB ?? ":memory:"`；CLI 默认 `~/.taric/authority.sqlite`。
- **影响**：宿主按 README 直接启动 `taric-mcp` 而未设置 `TARIC_DB` 时，会得到一个进程退出即丢弃的权威库，模型提案/context 全部静默丢失；这与"MCP 与 CLI 共享同一 authority"的承诺冲突，属于高危部署 footgun。
- **严重度**：重要。

### G8（重要）context cursor 密钥为进程内随机量，重启即全部失效

- **代码证据**：`context.ts` 模块级 `const cursorSecret = randomBytes(32)`；cursor 内嵌完整未投递记录集（`CursorState.records`），加密后体积随分页内容增长。
- **影响**：进程重启后所有在途 continuation cursor 因解密失败被拒（fail-closed，安全但体验受损）；cursor 携带全量记录也放大了响应体积与加解密开销。
- **严重度**：重要（可用性/性能）。

### G9（重要）Artifact 上传的内存峰值与崩溃持久化细节

- **代码证据**：`ARTIFACT_CHUNK_BYTES = 64MiB`，append 单请求经 JSON + base64（约 85MiB 字符串）一次性载入内存并同步解码；写入用 `writeFileSync`（无显式 `fsync`），发布靠 rename + marker 恢复。
- **影响**：大 chunk 对 Node 字符串长度与内存形成压力，多客户端并发上传时峰值叠加；断电（非进程崩溃）场景下 rename 后未 fsync 的文件可能丢失，虽有 marker/doctor 对账兜底，但恢复语义依赖"标记与文件不一致→quarantined"，最好显式提供 fsync 选项。实现报告已如实声明 100GiB 验证为合成 fixture、manifest 物理分片未做。
- **严重度**：重要（在"100G 级原文"目标场景下）。

### G10（改进）adapter RPC 传输协议吞吐受限

- **代码证据**：`adapter-rpc.ts` `handleSocket` 处理一行请求后即 `socket.end()`，且读入第一行后将 `buffer` 清空（同 chunk 中后续行被丢弃）；单行上限 1MiB。
- **影响**：一连接一请求、无并发、无背压；Hermes 插件按"每次调用新建连接"工作正常，但高频 context/proposal 回调下连接风暴与延迟累积；若未来客户端在单连接内 pipeline 请求会静默丢请求。
- **严重度**：改进。

### G11（改进）错误分类存在 message 正则兜底

- **代码证据**：`service.ts` `safe()` 对非 `ContractValidationError` 异常用 `/stale|lease|generation|version conflict/i` 与 `/unavailable host/i` 从 message 推断错误码。
- **影响**：底层错误若 message 含关键词会被误映射为 `stale_version`；规格要求"stable errors"，应统一让 store/artifact 层抛带 code 的错误。
- **严重度**：改进。

### G12（改进）文档与规格内部的滞后表述

- **证据**：
  - `docs/taric-design.md` §16 仍写"Taric 不实现 Artifact 存储"，而 artifact-content-storage 规格与实现已交付显式授权的 opaque 任务会话存储（README 已更新，设计文档未同步）。
  - `openspec/specs/authority-storage/spec.md` Artifact 小节仍写"启动 doctor/reconcile 尚不校验或重建该 spool"，而实现已交付 marker/manifest/hash/catalog 对账（`audit.doctor`/`audit.reconcile` + `ArtifactContentStore.reconcile`）。
  - `docs/agent-integration.md` 的 PostgreSQL 行未随归档变更更新（见 G1）。
- **影响**：以"specs + 归档 changes + design 文档"为共同标准的本仓库，三处标准源之间出现互相矛盾，会误导后续变更以错误基线开工。
- **严重度**：改进（但建议与 G1 一并尽快处理，因为它们共同构成"可信能力声明"问题）。

### G13（改进）质量评估缺真实人工基线与盲测数据

- **依据**：taric-design §15.3/§15.4 要求盲测报告对比人工基线、给出样本量与置信区间；quality-evaluation 规格要求分层统计证据。
- **现状**：`quality.ts`/`release-report.ts` 的统计与报告框架完整，fixture 为仓库内确定性样本；仓库内没有真实标注数据集与人工基线对比产物。
- **影响**：当前质量结论只能覆盖确定性安全不变量（release report 也如实声明了这一限制），"漏检不劣于人工基线"等验收无法在本仓库复现。
- **严重度**：改进（证据缺口，非代码缺陷）。

### G14（改进）其他工程卫生项

- `snapshot()`/`exportSnapshot` 对全量 `record_versions` 的加载与去重在超大 Engagement 下与 G4 同源。
- `DeepSeekHarnessAdapter` 仅锁定 session 事件（pinned 契约如此，文档如实标注 fallback），context/action 生命周期缺失。
- `normalizeCliOperation` 的别名表与 `cliCommands` 双份维护，存在漂移空间（低风险）。

---

## 5. 优化建议方案

按优先级组织：P0 = 正确性/可信度，应在下一次能力发布前完成；P1 = 规模与运行时演进；P2 = 工程卫生与证据补全。每项给出方案、涉及模块与验收标准，与仓库"最小可用、分层生长、无向后兼容包袱"的硬约束保持一致。

### P0-1 能力注册表回归单一事实源（对应 G1、G12）

**方案**
1. 以 `openspec/specs/*/spec.md` + 归档状态生成/校验能力声明：新增脚本（可并入 `scripts/check-schema.mjs` 同级的 `check-capabilities.mjs`）解析 specs 目录与 archive 元数据，对照 `TARIC_COMPATIBILITY_MANIFEST` 与 `service.deferred`，发现"已归档但仍标 unsupported/follow-up 指向归档 change"或"specs 无对应能力却标 supported"即失败。
2. 修正当前漂移：`storage.postgresql` 与 `quality.full_statistical_evaluation` 的条目按实际状态改写（PostgreSQL 建议改为 `state: "unsupported", detail: "runtime integration pending"` 并去掉指向已归档 change 的 follow_up，或引入 `state: "partial"`；质量统计改为 supported 并注明证据边界）；`service.deferred` 删除或改写已归档项；同步 `docs/agent-integration.md` 支持矩阵。
3. 将该校验并入 `npm test` 或 CI，使规格归档与能力清单无法再次脱钩。

**涉及模块**：`packages/core/src/compatibility.ts`、`packages/core/src/service.ts`、`packages/schemas/src/registry.ts`（若 deferred 移入注册表）、`docs/agent-integration.md`、`scripts/`。

**验收**：CI 中能力清单 ↔ specs/archive 全量一致；`capability.status` 输出与 docs 支持矩阵逐项相同；投毒测试继续证明注册表不可被请求修改。

### P0-2 canonical 主键改为 writer 分配（对应 G2）

**方案**
- `submitProposal` 不再接受 `content.id` 作为未来 canonical 主键：Core 在 admission 成功时分配 UUIDv7；caller 的 id 字段重命名为 `client_request_id`/`source_ref` 保留在 proposal 元数据与 provenance 中（保持可追溯），schema 相应调整（无兼容包袱，按仓库硬约束直接切换）。
- admission→commit 路径在发现同 Engagement 下逻辑实体冲突时仍走 CAS/base_version 语义，主键冲突面归零。
- 同步更新 README 示例（去掉客户端 `uuidv7()` 作为 content.id 的用法）与 engagement-memory 规格中的示例描述。

**涉及模块**：`store.ts submitProposal/admitProposal`、`schemas core.schema.json`（proposal/recordBase）、README、相关测试（governance、api-boundary、release-support）。

**验收**：caller 提交携带 canonical id 字段的提案被结构化拒绝；admission 产出的 canonical id 全部由 Core 分配且 UUIDv7；现有投毒/越权测试全绿。

### P0-3 proposal 提交期完整契约校验（对应 G6）

**方案**
- 在 `submitProposal` 内按 `recordContractNames[kind]` 执行 `validateContract` + `validateCanonicalRecord`（L0 视角）+ 引用存在性/Engagement 归属检查（复用 P1-1 的索引化校验器）。
- 校验失败返回结构化 `validation_error`，不落 proposal 表（规格要求"makes no state change"）；对"引用暂缺但语法合法"的提案可保留 `needs_evidence` 语义（若保留，需写入 schema 状态枚举并出审计事件）。
- admission 仍保留全部重算（防 TOCTOU：提交与准入之间引用可能被撤回/过期），形成双保险而非单一闸门。

**涉及模块**：`store.ts`、`validation.ts`、schemas、governance/contracts 测试。

**验收**：非法提案在提交边界零状态变更并返回字段级错误；合法但证据缺失的提案行为有明确契约与测试；admission 重算路径不退化。

### P0-4 统一 MCP/CLI 默认 authority 并输出启动诊断（对应 G7）

**方案**
- `createMcpService()` 默认改为与 CLI 一致的 `~/.taric/authority.sqlite`（或在未显式设置 `TARIC_DB` 时拒绝启动并提示，二选一，推荐前者 + 诊断输出）。
- MCP initialize 响应或 stderr 诊断输出 authority 路径（哈希化可选）、schema 版本、engagement 绑定状态，避免"静默内存库"。
- 增加测试：未设置 `TARIC_DB` 时两个入口解析到同一路径。

**涉及模块**：`packages/mcp/src/server.ts`/`bin.ts`、`packages/cli/src/cli.ts`、测试。

**验收**：默认配置下 MCP 重启后提案/上下文不丢失；文档与诊断一致。

### P1-1 引用校验与读取路径索引化（对应 G4、G14）

**方案**
1. `validateAuthorityReferences` 改为按引用集合批量查询：对每类 ref 字段用 prepared statement `SELECT engagement_id,kind FROM object_refs WHERE id IN (...)` 分批（如每批 500）取回，status 从 `records` 按 id 批量取；彻底移除 commit/admit 的全表 `object_refs`/`records` 加载。
2. 为 `object_refs(engagement_id)`、`records(engagement_id, kind)`、`record_versions(engagement_id, commit_seq)` 补索引（Postgres 侧已有部分，SQLite 侧核对）。
3. `list()` 增加 engagement + kind/status 过滤与 limit/offset 或 keyset；`snapshot()` 保持语义不变，但内部按 `(commit_seq DESC)` 游标分批物化，避免一次性大数组。
4. 引入规模化基准测试：10k / 50k 记录 Engagement 上测 commit p95、admission p95、`context.build` p95、`snapshot.export` 耗时，纳入 release gate（阈值可先宽松，重点是建立基线曲线）。

**涉及模块**：`store.ts`、`validation.ts`、`postgres.ts`（同步语义）、`release-gates`/新增 benchmark 测试。

**验收**：单次 commit 的引用校验成本与引用数线性、与全库记录数无关；50k 记录基准纳入 CI 或发布前手动 checklist；现有 CAS/隔离/崩溃测试全绿。

### P1-2 PostgreSQL shared authority 运行时接入（对应 G3）

**方案（分两步，保持"显式可选"边界）**
1. **抽象后端接口**：从 `AuthorityStore` 公共面提炼 `AuthorityBackend`（或保留同步 facade，内部以队列/worker 桥接 async backend），把"Core 需要的最小操作集"定义为接口，而非让 PostgreSQL 追平全部 SQLite 私有方法。
2. **补齐语义面**：按 CoreService 实际派发的操作为 `PostgresAuthorityStore` 增加 proposals/reviews/admission/lease/checkpoint/action/catalog 表与逻辑（迁移 SQL 沿用现有纯 SQL migrations 风格），server-side lease/fencing 已有基础。
3. **运行时接线**：CLI `resolveCliStartup` 在 postgres profile 下执行真实健康探测（`health()`），通过后创建 async-backed CoreService；失败保持 blocked、绝不回落 SQLite（现有 guard 语义保留）。MCP/adapter 复用同一 service 工厂。
4. **conformance 收口**：把 SQLite 与 PostgreSQL 放进同一套 storage/service conformance suite（现有 `postgres-live` 扩展），release evidence 继续要求全部 gate 通过才 enabled。
5. 在完成前，能力清单如实标注"存储原语已交付、运行时接入 pending"（与 P0-1 联动）。

**涉及模块**：`postgres.ts`、`service.ts`、`storage-contract.ts`、CLI/MCP 入口、deployment guard、runbook、双后端测试。

**验收**：`multi_host_authority` profile 在健康 PostgreSQL 上可完成 init→propose→admit→work.claim→checkpoint→artifact 上传的全链路；双后端 conformance 同绿；不可用时 blocked 且零 SQLite 回退。

### P1-3 context cursor 持久密钥与瘦身（对应 G8）

**方案**
- cursor 密钥从内容根下的 keyfile（0600，首次生成）加载，进程重启后 cursor 仍可解密校验；密钥轮换策略留版本字段（cursor 已有 `v`）。
- `CursorState` 不再内嵌完整 records：改为 `snapshot_id + read_seq + ordering + offset + delivered_ids + budget/filters`，续页时按 `read_seq` 固定重建分页源（store 已支持 as-of），交付集用 id 列表去重；必要时服务端短 TTL cache（已有 `ContextCacheEntry` 形态）。
- 保留 TTL 与绑定校验语义不变。

**涉及模块**：`context.ts`、`store.snapshot`（复用 as-of）、context/cursor 测试。

**验收**：重启后未过期 cursor 可继续且无重复/遗漏；cursor 体积与页大小解耦；篡改/跨 principal 用例继续拒绝。

### P1-4 Artifact 上传内存与持久化优化（对应 G9）

**方案**
- 默认单 chunk 降到 4–8MiB、保留配置上限（规格只要求 bounded，不必 64MiB）；append 在 JSON 解码后立即落盘并释放字符串引用。
- commit 阶段对 manifest 与最后一个 chunk 提供可选 `fsync`（配置项默认开启本地 spool 场景），再执行 rename 发布；性能敏感部署可关闭。
- 继续推进实现报告已注明的 manifest 物理分片 rollover，保持 API 不变。

**涉及模块**：`artifact-content-store.ts`、配置、artifact-content/scale 测试。

**验收**：并发多路上传的进程内存峰值有界且可配置；断电模拟（或单元级模拟 rename 前/后失败）下恢复路径有测试；100G 目标场景的元数据 fixture 基准不回退。

### P1-5 长驻进程的阻塞缓解（对应 G5）

**方案**
- 短期：把 `audit.verify/doctor/reconcile`、大规模 `snapshot.export` 标记为 operator 维护操作，CLI 单次进程执行；MCP/adapter 进程内避免自动触发全量校验。
- 中期：以 worker_threads 或独立 CLI 子进程承载重操作，或评估 `better-sqlite3` 之外的 async 驱动（与 P1-2 的 backend 抽象合流，避免两套抽象）。
- 任何方案保持"单写者事务"语义不变。

**涉及模块**：`service.ts` 维护操作、CLI、（可选）worker 封装。

**验收**：维护操作期间模型工具 P99 不受影响的量化证据（或在文档中明确隔离部署要求）。

### P2-1 adapter RPC 帧协议升级（对应 G10）

**方案**：单一长连接 NDJSON 多路复用——按行读取、逐行应答（带请求 id），保留单行上限但可配置，正确处理 chunk 边界（修复"读完首行丢弃余量"的隐患）；Hermes 客户端可保持现有每调用一连接的兼容用法（协议层向后不兼容允许，按仓库硬约束直接切换并同步插件）。

**涉及模块**：`adapter-rpc.ts`、`taric_hermes_plugin.py`、adapter-rpc 测试。

**验收**：单连接 pipeline 请求无丢失、按 id 正确配对；背压下不爆内存；现有 Hermes 测试与集成文档同步。

### P2-2 错误映射去正则化（对应 G11）

**方案**：store/artifact 层所有抛错统一为带 `code` 的 `ContractValidationError`（或等价结构）；`safe()` 删除 message 正则分支，仅按 code 白名单透传，未知异常一律 `internal_error` 且不泄漏堆栈。

**验收**：构造含 "stale" 字样的内部错误不再被误映射；api-boundary 测试补充该用例。

### P2-3 文档与规格同步自动化（对应 G12）

**方案**：新增 `scripts/check-docs.mjs`：
- 扫描 `docs/*.md` 与 specs 中"unsupported/不实现/尚不"句式的能力关键词（postgresql、artifact body、doctor、quality 等），对照 manifest 输出差异报告；
- 将 `taric-design.md` §16 的 Artifact 表述更新为"宿主外部管理或显式授权的 opaque 任务会话 spool，脱敏/保留/凭据生命周期仍属宿主"，与规格/README 对齐；
- 修正 authority-storage 规格中已过时的"doctor 不校验 spool"段落（作为一次规格 sync change）。

**验收**：三处标准源（specs、design docs、manifest）对同一能力无互相矛盾的表述；脚本进入 CI。

### P2-4 质量证据补全（对应 G13）

**方案**：
- 建立最小真实标注集（即使每层 30 样本起步），覆盖 web/host × 风险等级 × 证据等级分层，附人工基线判定；跑通 `evaluateMemoryQuality`→`buildReleaseReport` 全链产出可复现报告；
- 报告入库 `docs/` 或 release 附件，注明样本量与置信区间边界；
- 保持"样本不足 → insufficient → gate 失败"的 fail-closed 语义。

**验收**：仓库内可复现一份含人工基线对比的质量报告；§15.4 中"漏检不劣于人工基线"的验收有数据支撑（或明确标注未达样本量而阻塞发布）。

### 实施顺序建议

| 阶段 | 内容 | 理由 |
|---|---|---|
| 立即（P0） | P0-1 注册表对齐、P0-4 MCP 默认库、P0-2 canonical ID、P0-3 提交期校验 | 修正可信度与规格冲突，改动面小、风险低 |
| 短期（P1 前半） | P1-1 索引化 + 基准、P1-3 cursor、P2-2 错误码 | 在扩大数据规模前消除线性退化点 |
| 中期（P1 后半） | P1-2 PostgreSQL 运行时、P1-4 Artifact 优化、P1-5 阻塞缓解 | 支撑多宿主与大原文场景 |
| 持续（P2） | P2-1 RPC、P2-3 文档自动化、P2-4 质量证据 | 工程卫生与验收证据闭环 |

---

## 6. 附录：证据索引

### 6.1 关键实现位置

| 主题 | 文件 | 关键符号 |
|---|---|---|
| 权威事务/审计/outbox | `packages/core/src/store.ts` | `commit`、`transaction`、`nextEvent`、`verifyAudit`、`doctor`、`replayDerived`、`rebuildDerived` |
| 治理流水线 | `store.ts`、`policy.ts` | `submitProposal`、`admitProposal`、`submitReview`、`evaluateAdmission`、`promoteFinding`、`DEFAULT_ADMISSION_POLICY` |
| 协作状态 | `store.ts` | `claimWorkRun`、`renewWorkRun`、`reclaimWorkRun`、`commitCheckpoint`、`resumePacket`、`recordActionIntent`、`reconcileAction`、`recordLateResult` |
| Context Pack | `packages/core/src/context.ts` | `buildContextPack`、`encodeCursor/decodeCursor`、`buildResumeDelta`、`sealDraft/rebaseDraft`、`modelFields` |
| Artifact spool | `packages/core/src/artifact-content-store.ts` | `bind/begin/append/commit`、`readBounded`、`list`、`output`、`reconcile`、`requireBinding` |
| 投影 | `packages/core/src/projection.ts` | generation 发布、`pinProjection/readProjection`、`gitCheckpoint`、`runRemotePush`、`SecretScanEvidence` |
| PostgreSQL | `packages/core/src/postgres.ts` | `PostgresAuthorityStore`、`POSTGRES_MIGRATIONS`、`pinSnapshot`、`backup/restore` |
| 部署守卫 | `packages/core/src/deployment-guard.ts`、`shared-authority-config.ts`、`shared-authority-release.ts` | `checkDeploymentGuard`、`resolveAuthorityConfiguration`、`buildSharedAuthorityReleaseEvidence` |
| 服务/授权 | `packages/core/src/service.ts` | `authorize`、`capabilityForOperation`、`dispatch`、`deferred`、`registerTransportPrincipal` |
| 契约 | `packages/schemas/schemas/v1/core.schema.json`、`packages/schemas/src/registry.ts`、`packages/core/src/validation.ts` | 60 个 `$defs`、操作注册表、`validateAuthorityReferences` |
| 入口 | `packages/cli/src/cli.ts`、`packages/mcp/src/server.ts`、`packages/core/src/adapter-rpc.ts`、`packages/hermes-plugin/taric_hermes_plugin.py` | CLI 配置发现/启动诊断、`modelTools` 白名单、RPC 认证传输、Hermes hooks |
| 兼容清单 | `packages/core/src/compatibility.ts` | `TARIC_COMPATIBILITY_MANIFEST`、`TARIC_NON_GOALS`、`TARIC_SECURITY_INVARIANTS` |

### 6.2 验证命令与结果（2026-10-14）

```bash
npm run typecheck   # 通过
npm run build       # 通过
npm test            # schemas 19、core 182（1 skipped：PostgreSQL live 需 TARIC_TEST_DATABASE_URL）、cli 8、mcp 8
cd packages/hermes-plugin && python3 -m unittest discover -s tests  # 5 tests OK
```

### 6.3 差距与建议映射

| 差距 | 优化项 |
|---|---|
| G1 注册表漂移 | P0-1 |
| G2 canonical ID | P0-2 |
| G6 提交期校验 | P0-3 |
| G7 MCP 默认库 | P0-4 |
| G4/G14 写读路径规模 | P1-1 |
| G3 PostgreSQL 运行时 | P1-2 |
| G8 cursor | P1-3 |
| G9 Artifact 内存/持久化 | P1-4 |
| G5 同步阻塞 | P1-5 |
| G10 RPC 协议 | P2-1 |
| G11 错误映射 | P2-2 |
| G12 文档漂移 | P2-3（联动 P0-1） |
| G13 质量证据 | P2-4 |
