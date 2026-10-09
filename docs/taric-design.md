# Taric：面向多智能体渗透测试的长期记忆扩展插件

## 1. 产品定义与边界

Taric 是面向通用 LLM 智能体框架的**渗透测试专属长期记忆与协作扩展插件**。它为多个独立上下文的 agent 提供共享的 Engagement 记忆、攻击面状态、证据关联、任务交接、可恢复检查点、提案审核和审计能力。Taric 不自带模型，不替代 Pi、DeepSeek Harness、Hermes 等宿主的 agent loop、工具执行器、sandbox 或 worker 调度器。

Taric 的对外领域词汇采用 PTES（Penetration Testing Execution Standard；[PTES 官方项目](https://github.com/pentest-standard/docs)）及渗透测试团队熟悉的概念，如 Engagement、Scope/Rules of Engagement、Intelligence Gathering、Threat Modeling、Vulnerability Analysis、Exploitation、Evidence、Finding、Reporting；记忆治理吸收 Link 的 proposal、review、accept、audit 机制。PTES 阶段是分类和索引维度，不是 Taric 强制的线性工作流。`reference/tools/kb`、`reference/link` 和 `pentest-skills` 是设计与评审参考，不构成 Taric runtime dependency、公开 API 或格式兼容承诺。

核心信任边界是：LLM 只能提交带 provenance 的 proposal、observation、evidence 引用和私有草稿；它不能直接写 canonical memory，也不能决定 admission。确定性策略服务执行 proposal → review → guard → accept → audit。机器审核通过只形成有标签、默认不进入普通事实召回的候选层；verified finding 按 Taric 的证据与审核规则升级。高风险动作的最终允许与执行由上层宿主应用负责，Taric 提供三种可配置协作模式：LLM 给出审批建议、宿主已充分授权后的自主执行、以及由宿主应用通过 HITL 获取用户授权后执行。

Taric 采用分层实现：PTES 领域契约与存储内核独立于宿主；TypeScript 本地服务提供 CLI、MCP 和事务存储；TypeScript/Python 宿主适配器负责生命周期、工具注册和上下文注入；Markdown/Git 保持可读、可 diff 的 Engagement 投影。agent 的执行仍由宿主框架负责。WorkRun、checkpoint、handoff 和 动作协作接口 是协作状态服务，不是 Taric 自己调度或执行渗透任务。

### 1.1 目标与非目标

目标：

- 为长周期 web、host/network 渗透测试提供跨 agent、跨 session 的领域记忆。
- 关联宿主管理的认证资料及 Artifact；Taric 保存必要的领域状态和 opaque reference，不管理认证材料本身。
- 将 WAF、RASP、CDN/reverse proxy、rate limiting、request filtering、network ACL、RBAC/ABAC 等防护控制作为可版本化领域对象，记录作用层、覆盖范围和观察到的 allow/deny/challenge/block 结果。
- 同机多进程/多 worker 对同一 Engagement 并发读写，保持唯一 ID、局部冲突检测和一致性快照。
- 在上下文预算内检索必要状态；大体积 Artifact 由宿主存储，Taric 按宿主提供的引用/切片元数据关联和检索。
- 保存宿主提供的 worker/task 身份、执行尝试、checkpoint 和 handoff，支持中断后由宿主启动新 attempt 恢复。
- 支持框架原生插件、MCP 和 CLI 三种接入层，核心数据契约不绑定任何一个 agent runtime。

非目标：

- Taric 不创建或管理模型供应商，不实现自己的 agent loop，不默认派生 worker。
- Taric 不替宿主应用决定或执行渗透动作。宿主可选择 LLM 审批建议、已充分授权的自主执行、或经宿主 HITL 用户授权后执行；Taric 记录所选模式、动作上下文及宿主返回的授权/执行结果。宿主负责最终策略和工具调用，Taric 不将某一种模式设为全局强制默认。
- Artifact 内容及凭据材料的保存、脱敏和授权由宿主应用负责；Taric 的 model-facing 投影按字段白名单排除原始 Artifact、SecretRef、token、私有路径、未审 proposal 和敏感草稿。
- Taric 不承诺机器审核能证明事实为真，也不声称能完全消除 LLM 幻觉或漏报。
- 第一版不做跨 Engagement 的自动知识共享；默认每个 Engagement 的数据与权限隔离。

### 1.2 宿主假设

本文将“Hermes”暂按 **Hermes Agent（NousResearch）** 理解；如指其他项目，应替换该宿主 adapter。框架 capability 以本方案评审时的官方文档/公开 API 为依据。宿主接口变化由版本化 adapter contract 管理，核心协议不依赖框架私有 API。

## 2. 架构约束与差距评审

### 2.1 原则

1. **分级信任**：proposal、机器审核通过和独立验证通过是不同状态，不合并成一个 `accepted`；动作授权由宿主应用管理。
2. **证据优先**：结论必须引用证据对象；证据等级、限制和复现条件随结论传播。
3. **不变量由代码执行**：ID 唯一、状态迁移、范围检查、哈希和权限矩阵不交给 LLM 自我保证；高风险动作策略由宿主应用执行。
4. **可重放、可恢复**：权威变更先形成事务记录，再更新物化视图；中断后可以检测和恢复。
5. **最小权限**：host adapter/worker 只能提交自己负责的 proposal；不能直接改权威状态或给自己的内容做最终审批。
6. **可撤销而不抹历史**：更正使用 supersede/retract 事件，审计历史只追加保存。
7. **零 LLM 直接写权威层**：LLM 可以生成观察、草稿、候选 claim 和 patch，但不能持有 canonical ledger/authority/STATE generation 的写权限；所有落盘由非 LLM 的 CLI/service writer 在确定性守卫和状态机约束下完成。

### 2.2 与原始需求的差距评审

对照 `docs/memory-design.docx`，上一版已把信任分层、proposal 治理、证据引用、ID 唯一性和审计恢复讲清楚，但仍主要是“可靠记忆存储层”，还不是能持续运行和自我恢复的多智能体执行系统。DOCX 明确要求 `STATE.md`/`index.md` 作为 stigmergy 黑板、raw 大数据不进入上下文、worker 私有 draft、唯一写入口分配全局 ID，以及每次提交可回溯的 Git 快照。上一版没有把这些要求写成操作协议，并且将 SQLite 定为权威、Markdown 仅作投影，与 Markdown 原生工作体验存在张力。

| 用户痛点 | 上一版覆盖 | 差距 | 本次修订后的目标 |
|---|---|---|---|
| 数小时至数天的长任务 | 旧实现有 WorkItem/coverage 基础 | 缺少可接管的 WorkRun、租约、心跳、阶段检查点和接管语义 | 增加 Taric 持久化协作状态；宿主仍负责调度 |
| 数据量超过上下文 | 提到按需检索与 raw 分区 | 没有 token 预算、证据切片、分层摘要、截断标记和继续检索游标 | 增加可重建 Context Pack 和 Context Builder；大对象由宿主存储 |
| 任务无故中断 | Link 操作恢复与事务 outbox | 文件/数据库事务恢复不等于扫描/推理/外部动作续跑 | 增加 checkpoint、lease reclaim、重试/对账，并禁止不安全盲目重放 |
| 幻觉造成误报和漏报 | L1/L2 与独立审核偏重阻止误报升级 | 没有阴性结果语义、覆盖矩阵和可量化的漏报评估 | 增加 claim/evidence 结构、覆盖矩阵、反证流程及 precision/recall 验收 |
| 多 agent 独立上下文 | 只规定 Auditor A/B 独立 | 普通 worker 如何获得独立任务上下文和交接未定义 | 每个 worker 独立生成任务包，不共享 transcript，只经已提交黑板交接 |
| 并行读写同一状态 | 有 SQLite 写事务、CAS 和 ID 分配思路 | 读者可能读到不同版本/半成品；多文件投影未定义原子发布 | 固定 `read_seq`/generation，写入版本检查，物化视图整代生成后原子切换 |
| Markdown/Git 黑板体验 | 有 Markdown 投影和 Git 计划 | agent 的原生读写、STATE/index 协议、目录写入权责不清 | 保留 Markdown 草稿与黑板；统一合并入口；每次权威提交生成本地 Git checkpoint |

本次修订将“任务恢复”“账本事务恢复”“读取投影恢复”明确视为三个不同问题。审计/回滚不能代替任务 checkpoint；coverage 通过不能证明没有漏报；两个 auditor 意见一致也不等于事实确定。

## 3. 源码分析与可复用边界

### 3.1 `reference/tools/kb`：渗透测试领域骨架（源码参考）

KB 已有丰富且贴合场景的 schema：`ENDPOINT/ROUTE/PAGE/WORKFLOW`、`HOST/DOMAIN/SERVICE/WEBAPP/CRED`、`HYPOTHESIS/TASK/FINDING/EVIDENCE/CHAIN/NOTE`；web/host profile、覆盖率与终止 gate、证据前置的 finding 录入、凭证读写 lease、draft 隔离和 worker dispatch 归因，都是本系统应优先吸收的领域经验。Taric 重新建模这些概念，不继承其文件布局、主键、字段名或 schema。

并发与编号方面，`kb/lock.py` 用 engagement 级排他文件锁串行化写操作；`ids.py` 将类型计数器保存在 `target.json`，在分配前扫描已有 ID 并重协调；`commit.py`、`draft.py` 在锁内分配 ID、改写文件、更新状态并记事件。这适合作为同一状态目录的多 worker 起点，但不是分布式一致性方案：锁文件基于 PID、无 fencing token/租约续期；多个文件和 JSONL 的修改没有真正的统一事务；进程若在文件、计数器和事件写入之间退出，可能留下部分提交。`promote.py` 也展示了将计数器落盘与实体文件写入分开的恢复窗口。

持续修订能力也不能从现有编辑命令直接推定：`verbs/edit.py` 支持有限的 status/bullet set/append，但不是任意实体 revision 或并发 patch 合并；`verbs/draft.py` 的 integrate 主要处理新增 evidence/finding、状态翻转、关系追加和 STATE/index additions；`asset_memory.py` 适合追加原始观察、再集中 consolidate，不是对资产关系图做即时 upsert/失效传播。schema 中虽然有 `ENDPOINT/ROUTE/BUNDLE`，却没有资源版本身份、请求/响应变体、JS 哈希和 JS→接口→功能→数据对象的类型化关系模型。因此“允许修改 Markdown”本身还不足以满足持续演化要求，本方案需要新增后文的 resource revision、patch merge 和 dependency impact 机制。

KB 的 `events.jsonl` 有事件归因与 `dispatch_id`，但它不是防篡改审计链：事件缺少前序哈希、签名、统一事务序号和完整 before/after 摘要。Taric 重新设计自己的审计事件契约，吸收其归因语义并补足事务与完整性。

### 3.2 `reference/link`：记忆治理、权威层和操作恢复

Link 在 `ARCHITECTURE.md`/README 中将“memory layer 内不运行 LLM”列为设计原则：ingestion/recall、候选提取、去重和冲突判断走确定性代码；agent 层可以提出写入意图，但原始 capture 保持 proposal-only。memory schema 使用 `review_status` 等字段区分待审与常规召回；memory log 会按操作呈现影响与状态变化；`validation.py` 提供结构校验，`guard.py` 在相关请求出现时提醒约束记忆。`operations.py` 的 operation marker、受影响路径快照、失败记录和恢复报告为长事务的中断处理提供了可借鉴实现。

本项目吸收这些机制的概念与合适实现，不照搬以人为唯一 reviewer 的交互层。需要把 review 状态扩展成渗透测试语义下的多个信任层，并让“机器可接受”与“结论可依赖/动作可执行”严格分离。Link 的日志文件也不能直接被视为密码学意义的 tamper-evident log；若需要防篡改，需要显式哈希链、签名或外部锚定。

### 3.2.1 Link 的“零 LLM 直接写入”机制：已借鉴，但需要强化

Link 的文档和主要流程体现了“memory layer 内没有 LLM 写路径”的目标：确定性候选提取从输入文本识别候选；`write_session_capture()` 将会话内容以 proposal-only 原始 capture 写入 `raw/memory-captures/`，并记录用户原始 turns、来源和 secret warning；`propose-memories` 只生成候选，不写 durable memory；`accept-capture` 再由 CLI 调用 `_write_memory_page()`，执行 schema、secret、重复、冲突、frontmatter、索引和 operation journal 后才创建/更新页面；`update_memory_page()` 会追加更新、将 review status 退回 pending，并通过 operation journal 记录可恢复操作。Link skill 还明确要求“先提议，未经用户批准不得保存 durable memory”。

这套机制已融入本方案的 proposal/quarantine、确定性 guard、机器审核层、私有 draft 和 Taric non-LLM writer。但必须准确区分两种含义：

- **已融合的架构原则**：LLM 输出只能是输入数据/候选 patch；canonical memory 由代码 writer 按 schema、权限、冲突、来源和状态机落盘；审核结论不能直接成为文件写权限。
- **尚未自动获得的强保证**：Link 的公开流程主要依赖 CLI/skill 的流程约束，并没有统一的 approval token/actor 签名来证明“这次调用确实来自人”；其部分直接 `remember`/MCP 路径可以绕过 proposal-only 语义，拥有工作区写权限的进程也可能直接编辑 Markdown。因此本项目不能只复制命令名，必须把 writer capability 与 agent capability 在运行时隔离，并禁止 worker 使用通用 `remember`/`accept` 写入入口。

本系统的 L1 `machine_approved` 也不是可信事实层：它是由 writer 代码创建的**受限候选记忆/审核中层**。proposal/L0 默认不进入普通 recall；L1 只有在 task context 明确请求候选线索时才可检索，并必须显示 `origin`、证据状态、来源、policy digest 和“不可作为事实”的标记。L1 不进入“已验证事实”或正式报告。只有 L2 才能用于相应 finding 用途。这样既保留“机器审核通过即可继续工作”的效率，也不会把 LLM 生成的未经独立验证内容伪装成 durable authority。

本方案进一步收紧 Link 中容易被误解的“accept”语义：Auditor A 的模型输出只能是 advisory verdict，不能直接决定 L1；非 LLM policy engine 重新执行硬门并按版本化 admission policy 写入 `machine_approved`。如果某类 claim 的语义真实性不能被确定性校验，policy 可以要求它继续留在 L0，或要求额外独立 review；不能把“格式/来源检查通过”宣称成已证明无幻觉。L2 finding 需满足独立证据审核规则。高风险动作是否允许、采用何种授权方式，由宿主应用决定；Taric 不签发 action grant。

**保证边界**：这里的“零 LLM 写入”严格指 LLM 不直接写 canonical memory、不执行 admission decision、不凭自己的 verdict 获得 writer capability；它不等于所有由 LLM 起草的字符串都绝不持久化。机器审核通过的 L1 候选本身仍可能包含错误判断，所以 L0 默认不可普通召回，L1 必须显式作为待验证线索呈现，且永远不能冒充已验证事实。若产品要求“任何 LLM 生成内容都不得进入持久化层”，则必须禁用 LLM 产物入 L1、仅保存可引用的原始工具观察，并把 LLM 派生断言留在易失的任务上下文；这比当前已对齐的机器审核层要求更严格。

### 3.3 `pentest-skills`：工作流与评估资产

`runtimes/shared`、`runtimes/web`、`runtimes/host` 中的 worker 约束、hypothesis/closure auditor 规约、draft/handoff 集成流程，以及 `runtimes/shared/tests` 中的 coverage、promotion、ID、draft 和运行时上下文测试，适合作为策略来源和行为评估基线。只提取它们表达的领域语义与测试意图，不保留其 CLI/schema/文件格式。其 target 场景、POC/资产工作流与评估脚本可用于构造回归和投毒测试集。

复用时应将规则拆成机器可执行 policy（结构、scope、证据引用、状态迁移、动作限制）与供 agent 遵循的说明（探测方法、推理任务、handoff 习惯）。自然语言 skill 文档不能替代运行时守卫。外部目录应按版本/commit 固定来源，避免设计与实现期间规则悄然变化。

### 3.4 源码边界对本方案的影响

`reference/tools/kb/verbs/draft.py` 提供 worker 私有 draft 和 worker 返回后的集成流程，但没有活跃 worker 的续跑协议；`TASK` 是计划实体，不是带 lease 的执行记录。`reference/tools/kb/lock.py` 的 PID 文件锁没有 lease 续期/fencing；`commit.py` 的文件改写、counter、event 和 Git commit 分阶段执行，仍有中断窗口。`reference/link/mcp_package/link_core/operations.py` 恢复的是多文件写操作，`handoff.py` 面向主动交接，二者都不保存探测/推理的执行位置。Link 的查询预算可作为参考，但还不是长渗透任务的证据与状态上下文协议。

所以 Taric 从 KB 源码研究领域概念、coverage gate 和私有草稿经验，不保留其命令或目录作为产品 contract；从 Link 提取 proposal/review、operation journal 思路；再定义 adapter 无关的 WorkRun/checkpoint 服务、执行恢复、快照读一致性和外部动作对账。

### 3.5 Taric 领域词汇表

Taric 对外使用 PTES/渗透测试团队熟悉的领域词汇，避免把内部借鉴项目的命令、目录和类型直接暴露为产品契约。旧 KB ID 只用于源码映射分析，不进入 Taric schema、API 或 allocator。

| Taric 术语 | 含义 | 参考源码中的相近概念 |
|---|---|---|
| `Engagement` | 一次经授权的测试范围、目标、运行状态和交付物边界 | PTES engagement |
| `Scope` / `RulesOfEngagement` | 允许目标、禁止目标、测试窗口、方法限制和授权引用 | PTES pre-engagement scope/ROE |
| `Resource` | 攻击面中的逻辑资源及其版本/变体 | host/domain/service/application/endpoint/route/page/static asset |
| `Observation` | 由工具/worker 在指定时间、身份和条件下记录的观察 | reconnaissance、response、control observation |
| `Relation` | 资源、功能、数据对象、假设和证据之间的类型化边 | calls/reads/writes/protects/authenticates 等关系 |
| `Claim` | 可由证据支持或反驳的原子陈述 | testable security statement |
| `TestHypothesis` | 对潜在弱点或攻击路径的待验证解释 | PTES threat modeling/vulnerability analysis hypothesis |
| `WorkItem` / `WorkRun` | 测试工作定义与宿主实际运行/尝试状态 | PTES activity + host execution attempt |
| `Artifact` / `Evidence` | 宿主管理的大对象引用及用于支撑 finding 的可定位证据记录 | captured request/response, scan, JS, logs |
| `Finding` | 经独立验证、满足报告准入策略的安全问题 | PTES reporting finding |
| `AttackPath` | 由资源、claim、finding 和 capability 组成的攻击路径 | exploitation/post-exploitation path |
| `Proposal` / `Review` / `AuditEvent` | 记忆治理与可追溯变更机制 | Link-style proposal/review/audit |

产品状态优先用无歧义名称：`proposal`、`machine_reviewed_candidate`、`independently_verified`。内部使用 L0–L2 简写；动作授权状态由宿主应用定义。命令/API 不使用裸 `accept` 指代多种状态。

### 3.6 新项目边界

Taric 不实现旧 KB 文件、frontmatter、`TYPE-NNN` 主键、`bin/kb` 命令或目录树兼容，也不为这些旧契约限制 schema、ID 或 API。KB 只作为源码参考和设计评审输入。Taric 原生采用版本化 JSON Schema、UUIDv7 主键、自己的 API 和 projection format。旧 engagement 搬迁不属于本项目范围；若之后单独提出，应作为独立工具评估，不能反向约束 Core。

## 4. 系统架构与宿主兼容

```text
 ┌──────────────────────────────────── Agent Host ───────────────────────────────────┐
 │ Pi / DeepSeek Harness / Hermes / other harness                                    │
 │ owns model, tool loop, sandbox, worker scheduling and execution                   │
 │    ┌────────────────────────────┐       ┌────────────────────────────────────┐    │
 │    │ Native Adapter             │       │ MCP / CLI fallback                 │    │
 │    │ hooks, host context         │       │ model-callable restricted tools   │    │
 │    └──────────────┬─────────────┘       └──────────────────┬─────────────────┘    │
 └──────────────────┼────────────────────────────────────────┼──────────────────────┘
                    └────────────────────┬───────────────────┘
                                         ▼
                          ┌──────────────────────────┐
                          │ Taric Versioned API      │
                          │ context / propose / read │
                          │ checkpoint / action advice │
                          └────────────┬─────────────┘
                                       ▼
 ┌──────────────────────────────── Taric Core ───────────────────────────────────────┐
 │ PTES Domain Core | Context Builder | Proposal/Review/Policy | Work State Service │
 │ deterministic writer | ID allocator | audit ledger | dependency impact analysis   │
 └──────────────────┬─────────────────────────────┬─────────────────────────────────┘
                    ▼                             ▼
          Transaction Store                 Host Artifact refs + Projections
          SQLite / PostgreSQL               Markdown, local Git, Search Index
```

### 4.1 Taric 内核边界

- **PTES Domain Core**：定义 Engagement、Scope、Resource、Observation、Relation、Claim、TestHypothesis、WorkItem、Evidence、Finding、AttackPath、宿主认证元数据、ProtectiveControl 和 AccessDecision 的版本化契约。
- **Framework Adapter SPI**：映射宿主的 session、agent/worker attribution、task/dispatch identity、context injection、tool lifecycle、checkpoint、动作模式和宿主决策回传到 Taric API。
- **Context Service**：构建固定 `read_seq`、带 token 预算/来源 manifest 的 Context Pack，并关联宿主提供的 Artifact references/authorized slices。
- **Proposal service**：校验调用身份、engagement、dispatch/task 归属，保存不可信输入快照和规范化候选对象。
- **Non-LLM writer**：独立于 worker/auditor 的 CLI/service 进程，持有 ledger、authority generation、counter 和 canonical blackboard 的写权限；它只接受结构化 proposal/review/policy 结果，不接受“请直接写文件”的自然语言指令。
- **Collaboration State Service**：持久化 WorkItem/WorkRun/Attempt、lease、经 adapter attestation 的 checkpoint、handoff 和 ActionIntent；由宿主决定何时 claim、启动、重试、暂停或委托 worker。
- **Artifact 接口**：Taric 保存宿主提供的 Artifact 引用及领域关联；内容、存储、保留期限和脱敏由宿主应用决定。
- **Protection Control Registry**：记录防护控制类型、部署层、覆盖资源/路径/身份、版本/有效期和证据来源，并将观察到的拦截结果与源站行为区分。
- **Deterministic guard**：检查 schema、ID 引用、scope、证据引用、状态迁移、重复项、必需字段和动作上下文；动作允许与执行由宿主应用决定。
- **Auditor A / B**：由宿主提供的 review worker/人类流程；Taric 管理输入快照和 reviewer 隔离，review verdict 本身不是 writer capability。
- **Authority store**：事件账本为变更依据，实体/记忆记录为可查询物化视图。Artifact 内容由宿主存储和控制访问。
- **Retriever + action interface**：按信任层、scope 和任务上下文检索；向宿主提供动作信息及所选协作模式，接收宿主的建议采纳、授权和执行结果。Taric 不调用目标系统工具，也不替宿主作最终 allow/deny 决定。
- **Audit/operation manager**：记录提案、审核、接受、拒绝、撤销、恢复、策略版本和关联 ID。

### 4.1.1 Writer capability 与 LLM 隔离

“LLM 不直接写入”必须是运行时权限不变量，不能只写在 prompt 或 skill 中：

1. worker、auditor 和 report agent 只能提交 `proposal.submit`、`draft.write`、`observation.add`、`checkpoint.propose` 等候选输入；这些进入 review/private draft。`checkpoint.commit` 是仅供 authenticated host adapter 调用的内部 API，要求 adapter credential、有效 lease generation 和可核验的 tool-result references；模型不能调用此接口。这些接口不授予 canonical store 或 writer credential。
2. canonical writer 以独立服务身份运行，只暴露 typed commands：`merge_patch`、`admit_machine_candidate`、`promote_verified`、`record_host_action_decision`。每个命令都重新读取并验证 proposal、evidence 引用、base version、policy digest、reviewer independence 和 scope；不能把 LLM 返回的 `accept=true` 当作记忆准入或宿主动作授权。
3. worker/auditor 的操作系统账户或容器只得到 scoped Taric API capability：可提交宿主提供的 Artifact 引用、向自己的 Proposal namespace 写草稿；authority store、ID allocator、projection 和审计链对其不可直接访问。Pi/DSH 等进程内 extension 与宿主共用 OS 权限，所以这条保证依赖 adapter/runtime 隔离或工具不暴露 service credential。
4. 原始 capture、LLM 文本、审核理由和 patch 都按不可信输入处理；writer 通过 schema/引用/scope/status/版本守卫后才会落盘。模型生成的 Markdown 只作为内容处理，不作为可执行配置。
5. agent 不能使用 `--force`、直接打开 authority 数据库/投影路径或修改 review/audit 字段；宿主动作授权身份由宿主管理，Taric 不建立独立人工身份系统。
6. 运行 `taric audit verify`/`taric reconcile` 时检查 canonical store 权限、writer identity、事件来源和 projection 漂移；发现直接存储修改时隔离该 generation，不静默把漂移当作已接受记忆。

Markdown projection、Context Pack 和查询结果采用字段白名单；排除原始 Artifact、SecretRef、token、私有路径、未审 proposal 和敏感草稿。宿主应用负责其 Artifact 的脱敏及保存策略。新的实体或字段须明确列入可见白名单后才能进入模型视图。

API 必须分成两组：`capture/propose/submit_patch` 只能产生 L0 proposal、宿主 Artifact 引用或私有 draft；`commit_machine_approved` 只能由 admission service 内部调用，且只由确定性 policy engine 决定是否写 L1；`promote_verified` 需要符合独立审核规则；动作相关写入只记录宿主提供的动作模式、决策引用和结果，不签发 Taric action grant。worker 不得看到或调用通用的 `remember`、`accept`、`write_memory_page` 或“传入任意 Markdown 即写入”的写入口。Taric 只发布自己的版本化 API，不为旧 CLI 提供兼容转发。

原始响应、代码注释、LLM 输出和 worker 草稿全部标记为 `untrusted_input`，保存来源类型、Artifact 引用/哈希、采集/对话 turn attribution 和 producer identity。若 capture 来自对话，提案抽取优先使用用户/工具原始 turns，过滤 agent 自己的回声，不能把 assistant 的总结重新归因给用户或目标。Artifact 内容及其保留、脱敏由宿主应用处理。

因此，“零 LLM 写入”在本方案中的精确定义是：**LLM 不直接写 canonical durable memory，也不能仅凭自己的文字使内容获得权威信任；LLM 可以提交候选内容，非 LLM writer 才能在可验证的机器规则和所需审核条件满足后创建相应信任层记录。**

### 4.2 Framework Adapter SPI、兼容矩阵与技术栈

#### 4.2.1 Adapter 契约

各宿主能力不同，不能把“可以注册一个 MCP tool”误认为具备完整长期记忆集成。Taric 定义稳定、带版本的 `Adapter Contract v1`，适配器按 capability 声明支持项：`tool_registration`、`session_start/end`、`pre_context_injection`、`pre/post_tool`、`worker_identity`、`subagent_handoff`、`pre_compress_checkpoint`、`action_mode`。动作模式由宿主配置，Taric 提供审批建议、宿主授权状态及执行结果的传递接口，不要求宿主采用特定身份系统。Artifact 脱敏和保留由宿主负责，不作为 Taric adapter 的强制 capability。核心 API 只接受标准化的 `HostContext`、`Proposal`、`Checkpoint`、`ToolIntent` 和 `ContextPack`，不暴露 Pi/Cordis/Hermes 私有类型。

| 宿主 | 原生适配器 | 适配责任 | 通用降级 | 支持策略 |
|---|---|---|---|---|
| Pi | TypeScript extension | `before_agent_start` 注入 context；`tool_call` 可 block/改写；`agent_before_settle` 保存 checkpoint/handoff | MCP server 或 CLI | 优先实现；随 Pi API 版本契约测试。Pi extension 与宿主同进程/权限域，不是 OS 隔离边界；不携带 canonical writer 权限 |
| DeepSeek Harness | TypeScript Cordis plugin | `agent/request` 注入 context；`tools/pre-execute` 传递所选动作模式及宿主决策；`session/event` 跟踪持久化 session 水位 | MCP server 或 CLI | 单独版本锁定。官方仍处于预发布阶段；Taric 只支持通过契约测试的锁定版本，adapter 不进入 Core |
| Hermes Agent（用户写作 Helmes） | Python general plugin | `pre_llm_call` 注入 context；`pre_tool_call` 传递宿主动作模式和决策；`post_tool_call`/`on_session_end` 同步结果 | MCP server 或 CLI | 默认采用可与其他插件共存的 general plugin；MemoryProvider 不作为默认集成 |
| 其他 agent harness | 无需专属代码 | 具备 MCP client 即可检索、提交 proposal、checkpoint | MCP；再退化为 CLI/Skill | 不承诺 lifecycle 自动化；由用户/agent 按流程调用 |

官方接口依据：Pi [Extensions](https://pi.dev/docs/latest/extensions)；DeepSeek Harness [Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md) 与 [Extension Cookbook](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/extension-cookbook.md)；Hermes Agent [Plugins](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/plugins.md) 与 [Memory Provider Plugin](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/memory-provider-plugin.md)。框架接口可能演进，Taric 只承诺矩阵中经过 CI 契约测试的 adapter/framework 版本组合。

截至 2026-10-09 的文档评审，DeepSeek Harness adapter 按经过契约测试的上游版本单独锁定发布，不把 Cordis plugin loader 当安全隔离。Hermes 默认集成使用可与现有 provider 并存的 general plugin。

MCP 是跨框架最低共同分母，但 MCP-only 接入无法自动获知所有 session 边界、压缩时机、worker attribution 或工具执行结果。因此每个有成熟 extension API 的宿主配一个薄原生 adapter；MCP/CLI-only 可使用 Taric 记忆能力及动作建议，执行模式、用户授权和工具调用由宿主应用处理。

#### 4.2.2 技术栈决策

采用 **TypeScript/Node.js 作为 Taric Core 与首批原生适配器的主实现语言**，原因是 Pi 与 DeepSeek Harness 都以 TypeScript 扩展为主要原生集成面；同一套版本化 API、schema 和客户端可复用于两者。Python 用于 Hermes Agent adapter 和独立的 `pentest-skills` fixture/evaluation 脚本，不复制 authority 规则，也不实现旧 KB runtime/import compatibility。Rust 暂不作为首发核心语言，等压力测试证明 SQLite/Node service 是瓶颈后再考虑独立存储/解析组件。

| 部件 | 技术选择 | 边界 |
|---|---|---|
| Taric Core/CLI/MCP | TypeScript + Node.js LTS | schema、domain service、记忆治理、ID、事务和审计的唯一规则实现 |
| 同机事务存储 | SQLite WAL，单一 Taric service 负责写事务 | 适用于同机多进程/多 adapter；事务事件与 outbox 原子提交；不共享写入多个独立 SQLite 文件 |
| 跨主机共享 authority | PostgreSQL backend | 使用服务端事务、唯一约束、lease/fencing；Markdown/Git 只投影/导出 |
| Artifact | 宿主提供的存储或 Artifact API | Taric 保存引用及必要关联；宿主决定存储、保留和脱敏策略 |
| 宿主 adapters | Pi/DSH TypeScript；Hermes Python | 只做 host lifecycle 到 Adapter Contract 的映射，不能自行维护第二份 memory DB 或业务规则 |
| 互操作协议 | versioned JSON Schema + MCP; 内部插件 RPC | MCP model-facing tools 仅有 read/context/propose/checkpoint.propose/action.recommend；canonical writer API 不注册为模型工具 |
| 人工可读输出 | 默认启用的 Markdown projection + 本地 Git checkpoint | 字段白名单排除原始 Artifact、SecretRef、token、私有路径、未审 proposal 和敏感草稿；共享由 Taric 权限控制。远端推送按 Engagement 显式启用，并要求私有仓库、访问控制、保留策略和 secrets 扫描 |

Core 对外提供 MCP stdio、operator CLI 和本机受认证的 adapter RPC。authority store 放在 agent workspace 之外、由 Taric service identity 持有；agent tool/shell 只得到受限 API。Windows 可用受认证 loopback RPC，Unix-like 系统优先 Unix domain socket。Pi/DeepSeek Harness 等进程内 adapter 与宿主共享 OS 权限；若威胁模型包含可运行任意 shell 的不可信 worker，应将 adapter/agent 放入 OS sandbox 或单独 profile/process，writer credential 只存在 Taric service 中。插件 API capability 本身不构成操作系统隔离。

#### 4.2.3 部署边界

首发支持一台机器上的多个 agent process/worker 共用一个 Taric service 与 Engagement store。各宿主负责启动、调度、取消和恢复 worker；Taric 负责原子 claim/checkpoint、协作状态及返回 next-step/handoff 建议，不自行调度 agent。Markdown projection 默认启用，按字段白名单生成并由 Taric 权限控制共享；Git checkpoint 默认只在本地提交。远端推送须按 Engagement 显式启用，并配置私有仓库、访问控制、保留策略和 secrets 扫描。worker 在私有 proposal/draft 中编辑，由 Core 合并，不直接争写 canonical Markdown。跨主机共享 authority 时使用 PostgreSQL 服务；禁止用 NFS 文件锁、共享 Git clone 或多个 SQLite 副本伪装全局一致性。

### 4.3 持久化协作状态：WorkItem、WorkRun 与 Attempt

`WorkItem` 表示要验证什么，由 Taric 存储但由宿主/使用者创建；`WorkRun`/`Attempt` 记录宿主实际派发的执行实例。Taric 不管理 agent loop 或 worker 进程，只提供可 claim 的任务状态、lease、checkpoint 和 resume packet。

| 对象 | 责任 | 关键字段 |
|---|---|---|
| `WorkItem` | 目标、假设、依赖、优先级和覆盖语义 | `work_item_id`、`hypothesis_id`、目标资源、状态、验收条件、risk class |
| `WorkRun` | 某次可恢复的宿主执行生命周期 | `run_id`、work item、状态、host、当前 owner、lease generation、heartbeat、checkpoint、预算、read seq |
| `Attempt` | 一次 host worker/tool 执行尝试 | `attempt_id`、agent/worker/dispatch、开始结束时间、结果、错误、retry reason、context manifest |
| `Checkpoint` | 可验证的续跑边界 | 完成步骤、待做步骤、证据引用、lease/action 引用、draft 引用、下一步和来源版本 |
| `ActionIntent` | 可能产生外部副作用的调用意图 | action ID、目标、方法、幂等键、授权引用、状态、外部结果引用 |

WorkRun 状态为 `queued → claimed → running → checkpointed/blocked → completed/failed/cancelled`；宿主调用 Taric claim API 时，Core 原子递增 fencing generation 并返回 lease。租约过期后其他宿主 worker 可请求 reclaim；旧 generation 的迟到提交必须被拒绝。Taric 返回 retry/resume/defer 建议，由宿主调度器决定是否启动新 attempt。宿主返回的阻塞、scope 变化和外部动作状态应写入 WorkRun；Taric 不自动重放外部动作。

恢复的含义是**宿主启动新的 worker attempt，从最后一个已提交 checkpoint 继续**，不是试图恢复原模型的隐藏思维或进程内存。未提交 draft 可由旧 attempt 封存供审计，但新 attempt 只能通过显式 rebase/复制继续使用其中经校验的产物。

Checkpoint 在**动作边界**和阶段完成时提交，至少包含任务范围/目标版本、已完成步骤、观察与证据引用、阴性结果、未决假设、宿主宿主决策引用、外部动作状态、下一步、预算消耗、worker draft/handoff 和 `read_seq`。它不是模型隐藏思维链；只记录可执行状态与可审计依据。

外部扫描或请求可能已经执行但 worker 在落盘前中断。宿主在执行可能有副作用的工具前，可向 Taric 写入 `ActionIntent`，调用工具时传稳定 action/idempotency key，随后将结果引用回报 Taric。恢复时先按 action ID 查询工具侧结果或人工对账；对不可证明幂等的写操作、锁定风险操作、持久化和数据变更默认不自动重放。账本操作恢复、WorkRun 恢复与外部动作恢复分别验收。

标准接管流程为：① heartbeat/lease 超时后将旧 attempt 标为 lost，并在事务中递增 fencing generation；②读取最新已提交 checkpoint 和它固定的 `read_seq`，封存旧 attempt 的未提交 draft；③逐个 reconcile 未完成 `ActionIntent`，有歧义则阻塞并要求人工/adapter 核对；④重新校验授权范围、scope、宿主授权引用、目标版本和 WorkItem 是否仍有效；⑤为新 attempt 生成新的 Context Pack，引用旧 checkpoint 和最新 store generation，并标出两者间变更；⑥宿主决定是否启动新 worker，从最后一个安全动作边界继续，完成后提交新 checkpoint。scope 已变化或出现新冲突要求重新规划，不机械续跑。

fencing generation 必须覆盖所有写端和外部结果回传：proposal、evidence/observation attach、patch、checkpoint、ActionIntent completion、宿主动作决策和执行结果。旧 generation 的请求不能合并进新 attempt 的 authority；迟到的真实工具结果可由 adapter 送入独立 `late_result quarantine`，标记原 attempt/generation 和结果时间，供新 owner/reviewer 决定是否以新 proposal 引用。不能把迟到结果伪装成新 attempt 观察，也不能在丢失原 worker 后自动重放动作。结果已发出但无法核验的副作用标为 `result_unknown` 并先对账。

### 4.4 独立上下文与 Context Pack

每个 worker、auditor 和 host controller 都有独立 transcript/context；不读取另一个 agent 的隐藏推理或完整对话。协作只通过已提交的 Taric state、proposal/evidence、WorkRun checkpoint 和 handoff。每次宿主请求上下文时由 Context Service 生成不可变 `context_snapshot_id`，包括 `read_seq`、adapter/builder/policy 版本、检索项、摘要来源和省略/截断范围。

Context Pack 按 WorkItem 和当前 adapter 的 token/字符预算定制，包含：

1. scope、engagement 安全约束、worker 职责和当前风险预算；
2. Engagement 状态摘要、WorkItem/TestHypothesis/依赖和验收条件；
3. 相关资产、近因已提交变更、冲突/过期标记和覆盖缺口；
4. 当前 WorkRun 的 checkpoint、已执行步骤、未决问题与建议下一步；
5. 必要证据的引用、内容哈希、字节/行/HTTP 请求定位及读取权限；宿主允许共享的非秘密主体/认证元数据可按需包含；
6. 检索游标、token 使用预算和未被纳入上下文的候选范围。

Context Builder 先放不可省略的 scope、任务目标、禁令、验收和恢复点，再放直接相关实体与新变更，最后放背景摘要。大体积 Artifact 由宿主保存；Taric 仅将显式允许的引用或切片纳入 Context Pack。检索结果超预算时按优先级分页返回 cursor；被截断的范围显式标为“未检查”，不能让 agent 推断为不存在。分层摘要必须逐条保留来源 ID、时间和哈希；摘要帮助导航，不替代 evidence 引用。

Auditor B 从同一个已固定的 store sequence 构造独立 Context Pack，直接读 claim、原始 evidence 和限制条件；不读取 Auditor A 的结论正文，只可看到固定 rubric 和必要身份/风险元数据，避免 anchoring。不同 WorkItem 的 worker 默认只拿最小必要视图，不能因共享 Engagement 就获得所有宿主 Artifact。各宿主的 adapter 将对应 lifecycle hook 映射到这一相同的 Context Service。

### 4.5 共享状态投影与 Git 快照

原始 DOCX 中 `STATE.md` 与 `index.md` 的职责必须保留，但它们是 Taric 的可读 projection，而不是新的公共 API、事务源或强制的 agent 工作目录：

- **Engagement Brief**（可导出为 `STATE.md`）展示 Scope、active focus、开放 WorkItem、阻塞、handoff、近期变化与 store watermarks，不承载唯一历史事实。
- **Attack Surface Index**（可导出为 `index.md`）按 host/web 资产与 PTES 阶段索引 Resources、TestHypotheses、Findings、coverage gaps、冲突和下一步入口。
- 当前攻击面叙述由 Resource/Relation revisions 投影为 Markdown；Artifact 存储和凭据管理由宿主提供；每个 Attempt 有私有 proposal/draft namespace。
- adapter 在 host lifecycle 允许的时机获取 Context Pack；worker 完成、让出或在可控中断前通过 adapter 提交 checkpoint/handoff。没有 checkpoint 的进程中断仍可接管，但未提交文本不视为共享事实。
- agent 可用 Markdown 编写 private draft，Taric SDK/MCP 提交小粒度 patch；Core 校验 base version、权限、冲突和 schema，事务成功后更新 authority generation。共享 Markdown 只由 projection service 原子生成，不由各 adapter 直接写；字段白名单排除原始 Artifact、SecretRef、token、私有路径、未审 proposal 和敏感草稿。
- 每次 authority generation 生成白名单 Markdown projection，并默认创建本地 Git checkpoint，用于 diff、回溯和评估。远端推送须按 Engagement 显式启用，并配置私有仓库、访问控制、保留策略和 secrets 扫描。Git 失败只将 checkpoint 标为 pending 并重试；Git 不负责互斥或事务协调。

Brief/Index 仅供人和 agent 阅读。更新必须经 patch/CAS，不允许无锁追加。Context Pack/查询返回 `generation`/`read_seq`；陈旧 patch 由 Core 返回冲突项，adapter 再请求 host 重新规划。投影过时不阻塞 authority transaction，但 API 标明 `projected_seq < committed_seq`。

### 4.6 持续演进的实体、关系与假设

渗透测试中的知识不是先建模后验证的静态目录：新流量、响应差异、JS bundle、用户操作与数据对象会不断改变资产边界和威胁判断。存储层必须允许“当前理解”频繁就地修订，同时保留“当时观察到什么”不被后来的解释覆盖。为此采用双时间/双表示模型：

- **不可变观察层**：请求/响应、扫描结果、JS bundle、截图/日志等由宿主管理为 Artifact；每次观察记录稳定 ID、时间、来源、主体、采集条件及可用的 Artifact 引用/哈希。后续分析变化不能改写观察记录。
- **可变理解层**：Taric 的 Resource/Feature/Workflow/Host/Service 当前理解可自由更新叙述、字段、关系和未知项。每次保存产生 revision（作者、时间、base revision、diff、来源 observation、review 状态），稳定 resource UUID 保持不变。
- **可重建攻击面图**：以稳定 Resource ID 表示逻辑接口/静态资源，以 revision 表示它在某次观察或部署版本下的具体内容。HTTP resource identity 至少包含 origin/host、method、规范化 path、关键参数/内容类型及principal/tenant 维度；同一路径不同角色、参数行为或版本可以关联到同一个逻辑接口下的独立 variant。Artifact 以宿主引用和可用内容哈希识别具体版本；请求/响应体不塞进节点字段。
- **可追溯断言层**：影响安全判断的原子 claim 和关系（如端点读写属性、JS 函数调用接口、功能对应的数据对象、授权边界）记录支持/反驳证据、适用范围、有效时间和状态。非结构化正文可自由变化，但高影响 claim 不能只存在于自然语言段落中。
- **假设/工作层**：TestHypothesis 和 WorkItem 关联它们依赖的 asset revision、claim 和 coverage cell。新证据推翻旧理解时，旧假设不被删除；将其转为 `contradicted/stale/replan_required`，并产生待重评的 WorkItem 建议，由宿主/用户决定调度。

对同一个实体的更新采用混合合并语义，不能统一做文本 last-write-wins：自由叙述段落保留 agent 起草体验，基于 revision 的三方 diff 自动合并不重叠行；同段冲突交由 host controller/operator 或独立 merge reviewer 比较 evidence 后整合。集合型关系（links/tags/source refs）可去重并集，但删除/解除关系必须是显式操作。事实字段、scope 和 claim 状态使用 CAS；冲突时两种观察都保留为 evidence，当前理解降级到 `inconclusive` 并触发复核。任意“编辑”都产生 revision，不意味着每次都要重做昂贵的 LLM 全审：结构与权限走代码 gate，只有受影响的高风险 claim 才要求重新 machine review 或独立审核。

实体关联采用类型化、有来源、有时间范围的边，而不只依赖自由文本 wikilink：例如 `BUNDLE defines/calls ENDPOINT`、`ENDPOINT implements ROUTE`、`WORKFLOW reads/writes DATASET`、`ENDPOINT returns OBJECT`、`FEATURE uses WORKFLOW`、`HYPOTHESIS tests CLAIM`、`CLAIM supported_by/contradicted_by EVIDENCE`。每条 edge 有自己的 ID/version、source observation、有效时间、置信/状态和可选 scope。Markdown wikilink 仍是 agent 可读表达，图关系索引由已提交 revision 派生并带 generation。函数名、路由字符串、source map、代码行范围和请求样本位置作为可检索 chunk refs。新 bundle 不覆盖旧 bundle：创建新 revision，并对其引用或内容相异的派生 endpoint/claim 建立变更候选。

Worker 的提交单位是小粒度 `PatchSet`，必须带 `base_generation`、每个节点/edge 的 `base_version`，以及 `read_set/write_set`。patch 支持 `upsert resource/edge`、`replace property`、`add/remove relation`、`revise claim/hypothesis`、`attach observation`。不同标量字段的非冲突修改可以三方合并；集合关系的新增可幂等合并；删除边、互斥关系、scope/status 等关键属性要求显式操作和 CAS。相同字段并发修改时保存两个候选值及来源 evidence，建立 conflict record，由宿主控制者/独立审核处理；禁止静默 last-write-wins。每个 patch 的审计事件记录 before/after hash、字段/边变更、基础版本和 merge 结果。

当某个来源 revision/edge 变化或新 observation 与旧理解冲突时，依赖图执行事务化的**影响分析**：沿 `derived_from/depends_on` 找出下游 claims、TestHypotheses、WorkItems、coverage cells、WorkRun checkpoints、Context Pack、Findings、AttackPaths 和报告段落；写入 `ImpactEvent` 与 review queue，并使对应摘要/图索引/检索缓存在新 generation 中失效。旧对象保留，不自动断言为假，也不静默改写审计历史。

失效分级：普通描述变化将下游标记 `stale/review_required`；直接反证将 claim 与依赖假设降为 `inconclusive/contradicted` 并创建 revalidation WorkItem；若 L2 Finding 的关键证据前提被撤销或强反证，Finding 暂停进入新报告/普通高信任召回并要求 Auditor B 重审；基于该 Finding 的未执行动作建议标记为 stale，宿主运行中的 WorkRun 在安全边界暂停并重新检查授权。不能因资源标题或无关备注变化就一刀切撤销所有下游，依赖边需标注 `criticality` 与具体字段/claim。

影响队列按风险和阻塞关系排序：影响 scope/授权、凭证、可写能力、Finding 关键证据的变化优先；普通描述更新可后台重算。新 worker Context Pack 必须列出自其 checkpoint/read_seq 以来的相关 delta、冲突、失效前提和待复核任务；旧 context 不可悄悄继续当成最新。Host controller 的工作循环可周期性 reconcile 新 artifact、请求影响摘要、处理 stale hypotheses 并重建 context；Taric 不接管调度。

连续更新由 Taric API/SDK 提供：`taric draft <resource-id> --base <revision>` 获取 agent 可反复编辑的 Markdown 工作副本；`taric patch apply` 提交整页 diff，由 Core 按段落/字段/edge 做三方合并并发布当前 revision。`taric observation add` 登记原始 observation 引用，`taric relation add/remove` 修改图边，`taric claim revise` 修订高影响判断，`taric impact <resource-id>` 查看下游影响。对 agent 是逻辑上的就地更新，对底层是保留旧 revision 的可回溯版本更新。提交记录 `base_revision`、正文 diff、关系变化、受影响依赖数和待重审对象。Adapter 在 session/turn/task lifecycle 适当位置提示调用 context、checkpoint、handoff，不自行维护攻击面模型。

### 4.7 宿主管理的认证与 Artifact

认证与 Artifact 是宿主应用的职责。Taric 保存非秘密的认证状态/主体元数据和宿主提供的 opaque reference；不保存凭据明文，不实现凭据存储、凭据注入、Artifact ingestion、脱敏或保留流程。宿主可把经其允许的 Artifact 引用及定位信息交给 Taric，用于 Evidence、Observation 和 Context Pack。

Taric 的 Context Pack、Markdown projection、Git checkpoint 和查询结果统一使用字段白名单：排除原始 Artifact、SecretRef、token、私有路径、未审 proposal 和敏感草稿。Taric 不验证宿主的脱敏完整性。

### 4.8 防护控制与访问决策模型

WAF、RASP、CDN/reverse proxy、IDS/IPS、bot management、rate limiting、request/input filtering、network ACL、RBAC/ABAC、tenant isolation 等不能只写在自由文本 NOTE。Taric 将防护配置假设、实际拦截观察和源站访问决策分开：

- `ProtectiveControl` 描述一个控制面：`control_type`、执行层/组件、版本/策略引用、保护的 Resource/Route/Feature、身份/网络条件、状态、来源和有效时间。关系谓词包含 `protects`、`filters`、`authenticates`、`permits`、`denies`、`routes_to`。
- `ControlObservation` 是某次有明确测试条件的不可变观察：target Resource revision、HTTP method/path/parameter、principal/tenant、来源网络、请求样本、时间、control/edge response ref、是否确认抵达 origin、结果 `observed | suspected | not_observed | inconclusive | changed`、evidence refs、limitations、confidence 和 TTL。
- `ControlObservation.outcome` 只表示防护控制被观察/怀疑触发、未观察或状态不明；allow/deny/challenge/filter 的请求结果只写入 `AccessDecisionObservation.decision`，两种状态不能互相替代。
- `ControlObservation` 和 `AccessDecisionObservation` 必须绑定当时的 `control_revision_id/policy_snapshot_hash`、resource revision、principal/authentication-session revision、操作与网络条件。配置不可见时记录 `unknown` 与证据限制，不伪造 revision。策略或控制变化时追加 observation/invalidation event，并通过当前视图重算适用性；不可变历史 observation 本身不改成 stale。
- 测试 agent 默认只读取与当前 WorkItem 相关、ROE 允许的控制元数据和防护观察；WAF 规则、RASP 配置、ACL 清单等原始配置按敏感 Evidence 管理，只有 operator/专门 reviewer 按 capability 获取。导出、上下文和普通日志不附带可用于规避防护的原始策略配置。
- `AccessDecisionObservation` 记录“主体 S 在资源版本 R、操作 O、条件 C 下观察到 allow/deny/challenge/filter/unknown”，包含 control layer、origin outcome、身份角色/租户和对照请求。一次 `403`/`429`/challenge 只能支撑该测试条件下的决策，不能外推成全局授权规则或“源站无漏洞”。
- 组合约束：`decision_layer=edge` 且 `origin_reached=false` 时，`origin_outcome` 必须是 `not_reached`，edge 的 deny/challenge/filter 不能投影成源站拒绝或漏洞阴性；`decision_layer=unknown` 时不得归因到具体 WAF/RASP；若 `origin_reached=true`，必须有能支持该结论的证据引用。MVP 至少实现这些硬校验和 `blocked_by_control` 覆盖状态，完整矩阵可后续扩展。
- 防护指纹与实际控制事实分开：Server/header/banner、响应模板、challenge page 或响应时序可生成 `suspected` claim；只有来源清楚、重复验证或控制配置证据才可提升状态。边缘层拦截必须和源站行为区分，无法确认来源时记 `unknown/inconclusive`。
- Coverage matrix 增加 `blocked_by_control` 与 `tested_at_origin` 维度。被 WAF/RASP/ACL 挡在测试目标之前，应记录为受控阻塞/未到达源站，不能记成 `tested_no_observation`，不能关闭该 Resource/identity/operation 的漏洞覆盖缺口，也不能据此断言漏洞不存在。

当保护控制 revision、ACL/RBAC policy 或观测到的 access decision 变化时，追加新的观察/修订，由依赖分析使相关 negative claim、TestHypothesis、coverage cell、checkpoint 的当前前提、Finding 和宿主尚未执行的动作建议进入 stale/review_required 状态，并排入有优先级的 revalidation WorkItem。不可变 Observation、原始 checkpoint 和过去的授权事件保留原值；新鲜度与可继续依赖的状态通过事件及当前视图表达。不同身份、租户、网络位置、method/parameter 的结果不得合并成一个全局结论。Taric 记录控制与观察、帮助判断测试是否到达预期层；它不自动规避、绕过或削弱防护措施。

## 5. 信任模型与状态机

### 5.1 信任层

| 层级 | 状态 | 用途 |
|---|---|---|
| L0 | `proposal` | 仅审核/提交者可见，不进入普通召回 |
| L1 | `machine_approved` | 可作为线索，不可作为已证事实或正式 finding |
| L2 | `independently_verified` | 经独立证据审核，可用于符合准入要求的 finding |

高风险动作不属于 Taric 信任层；最终授权由宿主应用负责。

### 5.2 状态迁移

```text
proposal
 ├─ guard_rejected ─────────────> rejected (保留原因与审计，不进入正常召回)
 └─ guard_passed -> auditor_a
       ├─ review_rejected ──────> rejected
       ├─ needs_more_evidence ──> proposal (带缺项，重新提交形成新版本)
       └─ machine_approved ─────> L1
                ├─ 普通记忆：维持 L1，可过期/撤销/被新版本 supersede
                └─ 高影响候选：独立审核
                       ├─ reject / defer -> L1 或 rejected，按理由处理
                       └─ pass -> independently_verified (L2)
                                  └─ action request -> host decision (mode-specific)
```

`verified finding` 至少要求：明确 claim、一个或多个被引用证据、可复现步骤、验证结果、限制条件、适用资产和时间；由独立 reviewer 针对原始证据作判断。worker 的 `verdict: verified`、模型输出的“确认”或机器审核通过本身都不是验证凭据。

### 5.3 审核独立性

- Auditor A 与 Auditor B 使用不同 `reviewer_id`、独立上下文和独立判定记录；不得读取对方结论后简单复述。
- 最低要求是 B 直接检查原始证据、claim、反例和限制条件。高危、高影响、潜在破坏性结论可要求不同模型/规则栈，或人审批。
- 提案作者、执行验证的 worker、审核者不能在同一身份下自审自批。无法证明独立性时降级为 L1。
- 两个 auditor 同模型同提示不构成强独立性。配置应记录模型/版本、policy digest、输入快照哈希；风险高时使用异构审查或人类复核。

## 6. 数据模型

Taric authority store 使用版本化 JSON Schema 作为 canonical contract；Markdown 只是可读投影和 private draft，不承载唯一状态机。新主键为全局 UUIDv7，并可选分配无实体类型编码的 Taric 原生可读引用（如 `TAR-000042`）。TypeScript/Python adapter 使用同一 schema 验证或生成类型。

```yaml
work_run:
  run_id: <uuid>
  work_item_id: <uuid>
  engagement_id: <uuid>
  status: checkpointed
  owner: { host_id: pi | deepseek-harness | hermes, agent_id: ..., dispatch_id: ... }
  lease: { generation: 4, expires_at: ..., heartbeat_at: ... }
  attempt_id: <uuid>
  checkpoint_id: <uuid>
  context_snapshot_id: <uuid>
  read_seq: 182
  budget: { tool_calls: 12, token_limit: 24000, elapsed_seconds: 1800 }
  draft_refs: [private-proposal://<run-uuid>/<attempt-uuid>]
  last_event_seq: 182

claim: ...
  scope_ref: ...
  risk_class: informational | finding | action
  requested_transition: machine_approve | verify | action_recommendation

review:
  review_id: <uuid>
  proposal_id: ...
  reviewer_id: auditor-a
  reviewer_kind: deterministic | model | reviewer
  verdict: pass | reject | needs_evidence | defer
  checks: [{ policy_id: ..., result: pass | fail, details_hash: ... }]
  rationale: ...
  input_hash: ...
  policy_digest: ...
  model_ref: ...
  created_at: ...
  writer_required: non_llm_writer

authority:
  entity_id: <uuid>
  display_id: TAR-000042
  trust_level: machine_approved | independently_verified
  status: active | stale | superseded | retracted
  evidence_refs: [<uuid>]
  scope: ...
  confidence: ...
  valid_from: ...
  expires_at: ...
  supersedes: ...
  last_event_seq: ...
  provenance: { origin: llm_candidate | tool_observation | host, writer_id: ...,
                policy_digest: ..., review_refs: [...] }

host_action_decision:
  decision_ref: <opaque-host-reference>
  engagement_id: <uuid>
  action_ref: <uuid>
  mode: llm_recommend | authorized_autonomous | host_hitl
  status: recommended | authorized | denied | executed | failed | unknown
  result_ref: <opaque-host-reference-or-null>
  recorded_at: ...

claim:
  claim_id: <uuid>
  proposition: ...
  subject_ref: ...
  status: proposed | supported | contradicted | inconclusive
  supporting_evidence: [<uuid>]
  contradicting_evidence: [<uuid>]
  verification_procedure: ...
  limitations: [...]
  observed_at: ...
  applicable_scope: ...

negative_observation:
  observation_id: <uuid>
  statement: "未在本次测试条件下观察到 ..."
  method: ...
  tested_resources: [<uuid>]
  identities: [...]
  paths_or_cases: [...]
  time_window: ...
  evidence_refs: [<uuid>]
  coverage_refs: [...]
  limitations: [...]

resource_revision:
  resource_id: <uuid>
  display_id: TAR-000043
  revision_id: <uuid>
  logical_identity: { origin: ..., method: GET, path_template: /api/orders/{id} }
  variant: { identity: tenant-a/user, params_hash: ..., content_type: ... }
  content_hash: sha256:...
  observed_at: ...
  source_observation: <uuid>
  raw_refs: [{ object_hash: sha256:..., start: ..., end: ... }]
  valid_from: ...
  supersedes: ...

relation:
  edge_id: <uuid>
  from: <uuid>
  predicate: calls | defines | reads | writes | returns | belongs_to | protects | filters | authenticates | permits | denies | routes_to
  to: <uuid>
  edge_version: 7
  source_observations: [<uuid>]
  valid_from: ...
  status: active | disputed | stale | retracted

protective_control:
  control_id: <uuid>
  engagement_id: <uuid>
  control_type: waf | rasp | reverse_proxy | cdn | ids_ips | bot_management | rate_limit | request_filter | network_acl | rbac | abac | tenant_isolation | other
  enforcement_layer: edge | network | host | application | identity | unknown
  protected_resources: [<uuid>]
  current_revision_id: <uuid-or-null>
  status: suspected | observed | configured | changed | unknown
  source_refs: [<uuid>]
  valid_from: ...
  valid_until: ...

protective_control_revision:
  revision_id: <uuid>
  control_id: <uuid>
  deployment_layer: edge | network | host | application | identity | unknown
  policy_snapshot_hash: sha256:... | null
  policy_artifact_ref: <artifact-uuid-or-null>
  protected_resource_revisions: [<uuid>]
  identity_conditions: [...]
  network_conditions: [...]
  observed_or_effective_from: ...
  observed_or_effective_until: ...
  source_refs: [<uuid>]
  supersedes: <uuid-or-null>

control_observation:
  observation_id: <uuid>
  control_id: <uuid>
  control_revision_id: <uuid-or-null>
  policy_snapshot_hash: sha256:... | null
  resource_id: <uuid>
  resource_revision_id: <uuid>
  principal_ref: <uuid>
  authentication_session_revision: <uuid-or-null>
  network_origin: ...
  operation: { method: POST, path: /api/orders, parameter_set_hash: ... }
  outcome: observed | suspected | not_observed | inconclusive | changed
  response_layer: edge | origin | unknown
  origin_reached: true | false | unknown
  response_artifact_refs: [<uuid>]
  evidence_refs: [<uuid>]
  limitations: [...]
  observed_at: ...
  expires_at: ...

access_decision_observation:
  decision_id: <uuid>
  control_revision_refs: [<uuid>]
  policy_snapshot_hashes: [sha256:...]
  principal_ref: <uuid>
  authentication_session_revision: <uuid-or-null>
  resource_id: <uuid>
  resource_revision_id: <uuid>
  operation: ...
  context: { tenant_ref: <uuid>, network_origin: ..., condition_refs: [...] }
  decision: allow | deny | challenge | filtered | unknown
  decision_layer: edge | application | identity | origin | unknown
  origin_reached: true | false | unknown
  origin_outcome: not_reached | allow | deny | unknown
  evidence_refs: [<uuid>]
  observed_at: ...
  limitations: [...]

applicability_event:
  event_id: <uuid>
  subject_refs: [<immutable-observation-or-checkpoint-uuid>]
  changed_dependency_ref: <control-or-resource-revision-uuid>
  previous_policy_hash: sha256:... | null
  current_policy_hash: sha256:... | null
  affected_current_views: [<claim-uuid>, <coverage-cell-id>, <finding-uuid>]
  disposition: stale_for_current_use | requires_revalidation | revoked
  reason_code: policy_changed | control_changed | identity_changed | resource_changed | other
  committed_at: ...

patch_set:
  patch_id: <uuid>
  host_id: hermes
  agent_id: observe-2
  run_id: <uuid>
  base_generation: 31
  read_set: [{ entity_id: <uuid>, version: 4 }]
  write_set: [{ entity_id: <uuid>, base_version: 4, fields: [method, relations] }]
  operations: [upsert_resource, attach_observation, add_relation, revise_claim]
  source_refs: [<uuid>]
  content_hash: sha256:...
  merge_status: pending | merged | conflict
```

Artifact 的实际存储由宿主提供；authority 仅保存 Artifact 引用、哈希和必要的领域关联。Artifact 保留期限和脱敏策略由宿主应用决定。Observation 与 Evidence 的领域记录通过 Artifact 引用保持可追溯；修订产生新版本并保留 `supersedes`。

## 7. 并发写入、事务与全局唯一 ID

### 7.1 写入协议

1. Worker 生成 UUID/ULID proposal ID，可离线创建草稿；worker 不分配权威实体序号。
2. Proposal service 校验 schema 和调用身份，将 proposal 快照写入隔离区；同一 `proposal_id + content_hash` 重放应幂等。
3. 确定性守卫和 auditor 运行在 proposal 快照上，结果引用该快照哈希。
4. 通过后进入 engagement 写事务：校验基础版本/引用仍有效，分配实体 ID，在同一事务中追加事件、更新实体版本/counter/幂等表/outbox。事件 append 与 authority mutation 必须同库原子提交；不能先改 Markdown 再追加 JSONL。
5. 事务提交后，由投影器消费 outbox，生成新的完整 Markdown/index/search generation；写入 staging 目录，校验 manifest 后原子切换 current generation。投影失败可重试，不回滚已经提交的 ledger 事件。
6. 返回实体 ID、`commit_seq`、当前 `projected_seq/indexed_seq`、信任层和审核记录 ID。成功写入后提交者获得 read-your-writes；其他查询按固定快照读取。

### 7.1.1 并行读取一致性

- 每次查询在只读事务开始时固定 `read_seq`（数据库支持时使用 snapshot/read transaction），并返回 `read_seq` 与 `indexed_seq`。一个 context pack 内的实体、黑板和索引必须来自同一 generation；禁止拼接新旧状态。
- `read-your-writes`：写入 worker 可以用提交返回的 `commit_seq` 立即读到自己的提交；其他 worker 可以读到最近一个完整已发布 generation，并看到它相对 ledger 的滞后水位。
- 当索引滞后时，允许返回旧的一致快照并标记 `stale_by_seq`，或按需直接查 ledger；不能把“索引未包含”解释成实体不存在。
- worker patch/proposal 带 `base_generation`/`base_entity_version`。若状态已变化，服务返回冲突和变更引用；worker 需重建 context 或 rebase，不允许 last-write-wins。
- 多文件读通过 generation manifest 校验：`generation_id`、`ledger_seq`、各文件哈希、schema/policy 版本和实体清单。切换前保留旧 generation，reader pin 后可完成读取；回收需等 reader lease 过期。

### 7.2 ID 策略

- 所有 canonical 对象的主键用 UUIDv7；跨 Engagement、Resource/Evidence/Claim 等类型保持全局唯一，不把可读编号当主键。
- 为人类 diff、prompt 和报告可选分配 installation-wide 单调可读引用，如 `TAR-000042`。整个 authority deployment 对所有对象共用一条全局序列，不按类型或 Engagement 分段；实体类型由 schema 表达。可读引用只是 UI label，稳定引用始终使用 UUIDv7。
- SQLite 模式由唯一 Taric writer 在一个事务中 claim 全局序号、写对象/事件/outbox；PostgreSQL 模式用 sequence/唯一约束和事务。并发 adapter 只能请求该 allocator，不能本地生成可读引用。
- 数据库唯一约束覆盖 `(entity_uuid)` 与全局 `display_sequence`；每个对象另带 `engagement_id` 外键/范围引用。Taric 自己分配 display ID，不接受外部显示编号作为主键或 allocator 输入。
- 单机独立 Taric installation 之间不共享 display sequence；UUIDv7 主键仍用于跨快照识别对象。需要多个主机共用一个安装级可读序列时，它们必须连接同一个 PostgreSQL authority service，不能各自写 SQLite 后再合并。

### 7.3 后端选择与投影边界

原始 DOCX 强调 Markdown 原生起草、人类可审计和 Git diff；纯 Markdown 多 writer 直写则无法可靠实现跨对象原子事务、并发 CAS、lease 和统一事件序号。Taric 保留 agent 可读的 Markdown draft 与 projection，但 canonical state 由 Taric Core 管理；统一 adapter/CLI API 做 merge 后生成新 Markdown/Git generation。这样保留自然语言编辑体验，不把共享 Markdown 当锁服务或 canonical database。

首发推荐 SQLite WAL + `BEGIN IMMEDIATE` 做同机 authority store、全局 alias allocator、WorkRun lease、幂等键和 outbox；authority event + 对象 mutation + counter + outbox 在一个数据库事务内提交。agent 原始观察分析、LLM 调用和 Context Pack 构建可并发，短写事务由 Taric Core 原子仲裁。Markdown/Index/Search 是 outbox 重建的原子 generation。跨主机共享 authority 时换 PostgreSQL 行锁/sequence/唯一约束/lease/fencing；不共享写 SQLite 文件。

agent 私有草稿通过 Taric PatchSet 合并，不允许编辑器或宿主直接写 authority projection。Canonical projection 漂移由 `taric reconcile` 报告。Taric 原生快照只支持其自身版本化 schema。

## 8. 权威记录与审计日志

权威事实以追加事件为变更依据，当前实体状态是可重建的 materialized view。每个事务事件至少包含：

- 全局 `event_id`、authority deployment 内单调 `commit_seq`、UTC 时间、前序事件哈希、事件类型；
- host/agent/worker、dispatch/work item、proposal/review/entity UUID；
- 状态迁移、policy digest、审核者类型与 verdict；
- 输入快照哈希、证据引用、变更字段摘要、幂等键；
- 审核结果、宿主决策引用和变更字段摘要；Artifact 内容与凭据材料由宿主管理。

记录格式采用规范化 JSON（固定字段排序、明确 canonicalization 版本），计算 `hash = SHA256(prev_hash || canonical_event)`，用于检测账本内部不一致。Taric 不托管审计签名密钥。

事务通过 operation marker/outbox 记录 `pending → applied → indexed` 或 `failed/recovered`。启动时 doctor 检查未完成操作，验证账本、物化视图和 counter 一致性，提供 preview、恢复/回滚建议。不要只靠在原地覆盖文件快照回滚；回滚也应作为新的审计事件。

## 9. 幻觉治理、阴性结果与覆盖率闭环

独立审核和 schema gate 能降低误报，但不能消灭模型幻觉；只验证已提交的阳性发现，也不能发现漏测。系统把每个判断拆成原子 claim 和可复核证据，明确区分“没有观察到”与“证明不存在”。

### 9.1 Claim / Evidence 契约

每个会影响计划、finding 或动作的 claim 都要记录：精确命题、主体和适用范围；支持与反驳 evidence；验证程序/测试条件；观察时间；结果状态；置信/限制；来源与 Artifact 引用/定位。摘要只作导航，原件由宿主保存。审核器必须能够将每个 finding 语句映射回 evidence 片段，未被直接支持的描述降为假设或从报告删除。

阴性结果写成限定命题，例如：“在时间 T、账号 A、路径集合 P、方法 M 和条件 C 下，未观察到越权响应”。禁止将其简写成“该 endpoint 不存在越权”。阴性 evidence 必须记录方法、baseline/control、触发条件、coverage cell 和 limitation。假设状态在 Taric schema 中区分 `untested`、`testing`、`supported`、`contradicted`、`inconclusive`、`blocked`、`not_applicable`，不将 `inconclusive` 转成 `refuted`。

### 9.2 Coverage Matrix 与漏报控制

Taric 定义可扩展的 web/host coverage profile，将覆盖单位细化成矩阵：

```text
asset × test_category × identity/role × path/API operation/parameter × test condition
```

每个 cell 独立记录 `not_tested | queued | in_progress | tested_no_observation | positive | inconclusive | blocked | blocked_by_control | not_applicable`，并引用 WorkItem、WorkRun、Evidence 和时间。`tested_no_observation` 只表示限定条件下没有复现，不关闭其他身份、role、tenant、路径或参数的 gap。Scope、前置条件、认证主体缺失时记 blocked；WAF/RASP/ACL/challenge 阻止到达目标执行层时记 `blocked_by_control` 并指向对应 ControlObservation；确实不适用需带理由，不得用 not_applicable 掩盖未测。

Taric coverage gate 在报告/WorkItem 关闭前分别列出：未测试 cell、普通阻塞 cell、被防护控制挡住的 cell、仅有阴性结果的 cell、阳性但未独立审核的 claim、相互矛盾的 Evidence，以及外部工具任务未 ingest 的结果。被边缘控制挡住不代表源站测试完成；将漏洞结论与覆盖充分性分开：覆盖全不代表测试方法有效，观察到 WAF/RASP 也不代表应用层不存在缺陷。

冲突 evidence 或新版本观察创建 review queue 项，并把受影响 claim 降为 `inconclusive/stale`，不静默覆盖已知状态。新证据可以 supersede 旧观察，但必须保留旧值、时间和适用条件。

### 9.3 幻觉和覆盖评估

验收集需包含已知正样本、已知负样本、边界条件、身份/租户差异、过期状态、目标提示注入、伪造 evidence、反例和真实漏测案例，并按 web/host、风险类别、证据等级分层。盲测中统计 finding precision、召回率/漏报率、unsupported-claim rate、coverage-cell 漏记率和校准误差；同时报告样本量与置信区间。不能仅以 auditor 一致率当作真实性指标。

上线门槛由安全负责人按风险确定；初始建议：高/严重 finding 的 unsupported-claim rate 为 0；known-positive 漏检率不得高于既有人工基线，且不得以 coverage skip 降低；非严重类别以分层样本测量 precision/recall 并给出 95% 置信区间。评估未达标时保留 L1，不自动生成正式发现或授权动作。这些门槛是风险控制，不构成模型不会幻觉的保证。

## 10. 守卫与策略引擎

守卫分成确定性硬门和 auditor 判断两类。硬门不允许 LLM 覆盖：

1. **身份与归属**：Engagement、host、agent、WorkItem、dispatch ID 有效；当前 adapter 持有相关 WorkRun lease。
2. **范围**：目标和来源均在 scope 内；任何新发现的候选范围外资产只能进入隔离候选，禁止由记忆自动扩 scope。
3. **schema/引用**：领域字段完整；UUID/显示 alias 引用存在且类型匹配；状态迁移合法；无重复声明、悬空关系、临时 ID 泄漏。
4. **证据**：finding 引用不可变 evidence/Artifact 引用；记录 proof type、baseline/trigger、观察结果、limitations、时间和资产。evidence、raw response、LLM 输出和 proposal 默认是 `untrusted_input`，不能自动成为 authority。Artifact 原文及脱敏由宿主管理。
5. **敏感字段投影**：Taric 的 model-facing projection 按字段白名单排除原始 Artifact、SecretRef、token、私有路径、未审 proposal 和敏感草稿；Artifact 内容的脱敏和保留交给宿主应用。
6. **发现凭据的使用权**：Taric 可记录凭据发现状态和宿主提供的引用，不负责扫描、保存原值或授予使用权。宿主应用管理凭据和相关授权；记忆内容本身不能作为动作授权。
7. **污染与提示注入**：外部响应/文件文本标记为不可信数据；不得作为 policy/system instruction 执行；审核输入将来源数据与规则分隔。
8. **一致性与新鲜度**：检查矛盾记忆、过期版本、撤销记录、来源可信级别和重复观察；冲突时并列呈现或降级，不能静默覆盖。
9. **动作协作**：动作请求记录 verb、target、impact、scope 及宿主提供的授权上下文；L1 记忆不能作为事实依据。Engagement 可选择 `llm_recommend`（LLM 提供审批建议）、`authorized_autonomous`（宿主认定已充分授权并自主执行）或 `host_hitl`（宿主向用户确认后执行）。Taric 可提供建议并记录宿主决策，但不替宿主选择模式、授予权限或执行动作。

审计输出需结构化：检查项、pass/fail/defer、证据引用、规则版本、拒绝原因。Auditor A（包括模型）只输出 advisory result；L1 admission 由非 LLM policy engine 结合硬门重新计算。独立审核可提供 L2 finding 的审核结果；动作模式与最终授权由宿主应用决定。Taric 记录宿主提供的授权结果/引用，不要求人工身份系统；审计签名密钥托管不属于 Taric 范围。规则升级需要版本化与回归运行。

## 11. 检索、记忆生命周期与 Guard

- 默认召回按 engagement、资产、任务、时间、记忆类型和 trust level 过滤；结果明确显示 `machine-approved` 或 `independently-verified`，并带来源、置信、观察时间和有效期。
- L1 只能作为线索/假设输入；worker 必须重新验证后才能以 L2 语义写报告。动作建议不构成宿主授权。
- 约束型记忆通过 Link 风格的相关时机提示提供来源和适用条件；动作模式与执行仍由宿主控制。对低置信或已 stale 项显示谨慎标签。
- 引入 `review_after`/`expires_at`：动态观察（端口、认证、配置）设置短期复核；稳定知识可更长；过期不删除，改为 stale 并降低默认召回权重。
- L0 proposal/quarantine 默认不参加普通检索、brief 或 Context Pack；只有 admission/review 专用工具可读取。L1 候选默认不进入“已知事实”召回，worker 必须按任务显式请求候选线索，结果同时返回不确定性标记和 evidence refs。
- 支持 `supersede`、`retract`、`archive`，每次产生事件。被撤销的内容不参与普通召回，但审计员可按权限追踪。
- 检索记录可按需审计，但不要把每次普通查询都写进权威事件链；宿主回传的动作授权/执行结果按需记事件。

## 12. API/CLI 草案

Taric API 使用版本化 JSON Schema；MCP 只暴露给模型安全的受限工具。`writer.commit_machine_approved` 是服务内部 API，不能注册成 agent tool。CLI 面向 operator/admin 与本地开发，不要求 agent 使用 shell 命令：

```text
taric init <engagement-name> --scope <scope-file>
taric status <engagement-id>
taric context build --work-item <uuid> --budget 24000
taric query --engagement <uuid> --resource <uuid> --as-of <read-seq>
taric capture <host-artifact-ref> --mode proposal-only
taric propose list --engagement <uuid>
taric review run <proposal-uuid> --policy <policy-id>
taric admission run <proposal-uuid> --policy <policy-id>  # non-LLM policy engine
taric control list --resource <uuid>
taric control observe <control-uuid> --proposal <file>
taric access observe --resource <uuid> --proposal <file>
taric revise <entity-uuid> --base-revision <uuid> <patch-file>
taric work checkpoint <run-uuid> <checkpoint-file>
taric work resume <run-uuid> --host <adapter-id>
taric action recommend <tool-intent.json>
taric audit verify [--generation <n>]
taric snapshot export <engagement-id> --format jsonl|markdown --output <path>
```

模型可调用的 MCP tools 是按字段白名单投影的只读 `context/query/resource/evidence`、候选写入 `proposal.submit/observation.submit/checkpoint.propose`、防护观察提案和 `action.recommend`。响应仅包含白名单字段。宿主 adapter 可提交所选动作模式、宿主决策引用及执行结果；Taric 不提供工具执行或授权接口。真实 checkpoint 由 authenticated host adapter 提交，服务验证 WorkRun lease 和结果引用。

## 13. 角色权限与渗透测试安全边界

以 Taric capability 而非旧目录名定义权限，并由 store/service identity 强制，而不是只靠 prompt 约定：

| Capability | 授予对象 | 可执行操作 | 明确禁止 |
|---|---|---|---|
| `memory.read` | 当前 Engagement 内 agent | 读固定 `read_seq` 下的白名单 context、resource 和 Artifact 引用 | 不能读取未授权字段、其他 Engagement 或 未审 proposal |
| `proposal.submit` | worker/auditor | 提交 Observation/Claim/Relation/WorkItem patch 到 quarantine | 不能决定 trust tier 或写 authority |
| `checkpoint.commit` | host adapter + 当前有效 WorkRun lease | 保存经验证的动作边界、进度和 handoff 引用 | 不能覆盖其他 generation 的 run |
| `action.recommend` | agent/host adapter | 获取 Taric 的审批建议及理由 | 不是宿主授权，不执行目标工具 |
| `host.decision.record` | host adapter | 记录 `llm_recommend`、`authorized_autonomous` 或 `host_hitl` 模式及宿主返回的授权/执行状态 | Taric 不替宿主决定是否允许或执行动作 |
| `writer.commit` | Taric Core service identity | 校验后提交 machine-reviewed candidate 和 projection | 不接受模型自由文本作为准入结论 |
| `review.submit` | 独立 reviewer | 提交绑定输入版本的 L2 finding review | 不能审核自己的 proposal/执行结果；不授予动作权限 |

agent 间不直接传递 transcript；Adapter Contract、Taric Context Pack、已提交 Observation/Evidence、WorkRun checkpoint 和 handoff 是共享通道。宿主负责调度、动作模式选择、HITL 用户授权和工具执行；Taric 提供审批建议及决策/结果记录接口。Artifact 和凭据内容、保留及脱敏由宿主管理。

## 14. 实施阶段

先证明一个 Taric authority 能被多个通用 agent host 以相同安全规则接入，再扩展完整关系图、恢复和多机能力。宿主 adapter 独立发布；框架 preview API 变化不得阻塞 Taric Core。

### Phase 0：产品契约与参考版本基线

- 固定 `reference/tools/kb`、`reference/link`、PTES 文档及 `pentest-skills` 的来源版本/commit，记录需要吸收的领域规则、治理机制和测试案例；不建立旧 schema 兼容层，也不把旧格式映射作为运行时能力。
- 定稿 PTES 词汇表、Taric Versioned API/JSON Schema、Adapter Contract v1 和 framework capability matrix。
- 梳理各宿主版本、安装/信任边界、生命周期和 tool hooks；建立 adapter contract test harness。
- 确认 Adapter Contract 中的动作模式、宿主决策/结果回传及 Artifact reference 字段。
- 为 worker、auditor、host adapter、writer、operator 分配不同 capability；枚举 native plugin、MCP、CLI 的写入口，worker 的通用 remember/accept/update 只能提交 proposal。
- 准备 known-positive/negative corpus、提示注入和 memory poisoning 基线。

### Phase 1：Taric Core MVP 与 Pi Adapter

- 实现 TypeScript Core、SQLite WAL、global UUID/display ID allocator、proposal→review→guard→accept→audit 最小闭环，以及 MCP/CLI。
- 实现 Engagement/Scope/Resource/Observation/Claim/Evidence/Finding、host Artifact reference、ProtectiveControl/ControlObservation/AccessDecisionObservation 最小领域 schema 和 token-budgeted Context Pack。
- MVP 即交付最小 WorkItem/WorkRun/Attempt、lease/fencing、proposal/review、动作模式与宿主决策记录接口、writer capability 隔离和 checkpoint 提交；Taric 不实现动作执行器或 HITL 身份流程。
- Markdown projection 默认启用，按字段白名单输出；Git checkpoint 默认本地提交，远端推送按 Engagement 显式配置。
- 实现 Pi TypeScript extension：session context 注入、受限工具、proposal 提交、动作模式/宿主结果回传与 lifecycle checkpoint/handoff。
- 完成同机多进程读写、writer isolation、L0/L1 recall 和端到端审计验收后发布 MVP。

### Phase 2：框架适配器

- 实现 DeepSeek Harness Cordis adapter，锁定兼容 release 并对 session/tool/prompt/action-mode contract 做测试；agent loop 仍由 Harness 拥有。
- 实现 Hermes Python general plugin 与 MCP fallback；MemoryProvider 不作为默认集成；如宿主部署选择该类型，则遵循 Hermes 单选 provider 配置。
- 提供 adapter install/remove/config/health/version diagnostics；native adapter 不可用时降级到 MCP/CLI。
- 验证不同 host adapter 对同一 Engagement 的并行提交、上下文隔离、identity provenance、动作模式/决策回传和固定 `read_seq`。Artifact 处理和动作执行能力由各宿主负责。

### Phase 3：关系图持续演进与执行恢复

- 加入 global resource identity/revision/typed Relation/PatchSet、字段级 CAS、冲突队列和依赖影响分析。
- 增加更多 host Artifact reference 类型及其证据关联；Artifact 的扫描、脱敏和保留仍由宿主处理。
- 完成 ProtectionControl revisions、immutable observation applicability、依赖失效事件，以及 access-decision 到 `blocked_by_control` 的细粒度 coverage 传播。
- 完成 context cursor、resume delta、缓存失效和 Taric-native JSON/JSONL snapshot round-trip。

### Phase 4：信任升级、Policy Guard 与评估

- 完善 non-LLM policy engine、独立审核和 L2 verified Finding；扩展宿主动作建议/决策记录的 adapter conformance，不实现 Taric 自有动作授权策略。
- 实现 coverage matrix、negative observation、反证流程和已知正负盲测集。
- 完成提示注入、权限旁路、误报/漏报、crash recovery 和 adapter conformance benchmarks。
- 加入 hash-chained audit、event replay 和 projection rebuild；不实现审计签名密钥托管。

### Phase 5：PostgreSQL 与多机共享

- 仅在需要多主机共享 authority 时交付 PostgreSQL backend、server-side lease/fencing、备份恢复和多机 event ordering。
- SQLite/PostgreSQL 运行同一 storage conformance suite；发布 API/schema migration 与 adapter compatibility matrix。

## 15. 测试与验收标准

### 15.0 Adapter Contract 一致性

- 对每个正式支持的 host/version 运行同一组 adapter contract tests：session identity、context injection、proposal submission、checkpoint、动作模式/授权结果回传、cancellation 和 error mapping。
- Pi 和 DeepSeek Harness 原生插件与 MCP fallback 对同一操作得到一致的 Core 状态；DeepSeek Harness 每个支持的锁定版本单独验证。
- Hermes general plugin 不修改 host memory provider 时可与其他插件共存；MemoryProvider 模式安装时检测单选冲突并明确提示。
- MCP-only harness 能使用 read/context/propose 和动作建议；不支持 lifecycle hook 时暴露 integration capability 缺失，不声称自动 session capture 或可靠 resume。
- Adapter crash、host reload、session reset 和 context compression 不得丢失已提交 Proposal/Checkpoint，也不得重复提交已确认的幂等操作。

#### 15.0.1 Model-facing projection

- 使用 canary 值和路径验证 Markdown、Context Pack、查询结果及 Git checkpoint 的字段白名单会排除原始 Artifact、SecretRef、token、私有路径、未审 proposal 和敏感草稿。
- Artifact 保留、脱敏和访问策略由宿主应用验证；Taric 只验证自身投影输出及权限边界，不实现 Artifact scanner 或 vault。

#### 15.0.2 防护控制与访问决策

- 将 edge WAF challenge/block、RASP 拒绝、ACL/RBAC deny、rate limit、origin allow/deny 分别记录；响应层为 unknown 时不得归因到源站或特定控制。
- schema 测试覆盖 `origin_reached=false` 必须对应 `origin_outcome=not_reached`，edge challenge/deny 不能投影为 origin deny/negative finding；`decision_layer=unknown` 时不能标称某个具体 WAF/RASP。
- WAF/RASP/ACL 拦截的请求进入 `blocked_by_control`，不关闭 origin vulnerability coverage；不同 role/tenant/network/path/parameter 的决策不得被一个 403/429 合并概括。
- Phase 1 即实现最小 `blocked_by_control` 结果和 coverage gate，确保被拦请求不能关闭目标层测试缺口；完整 coverage matrix 与依赖传播后续扩展。
- 只凭 header/banner/template 指纹只能产生 `suspected` control；控制配置来源和重复证据可支持更高置信状态，但不得自动推导“控制已完整覆盖”。
- 修改 ProtectiveControl revision、ACL/RBAC policy 或 observed access decision 后，原 ControlObservation/AccessDecisionObservation 和事件不得改变；只将依赖的当前 claim/coverage/checkpoint applicability、Context Pack、Finding 和相关动作建议按风险标记 stale/revalidation，不覆盖历史证据。
- 所有 protection model 测试限于 Engagement Scope 内的授权观察；Taric 记录动作建议及宿主回传状态，不提供防护规避或绕过指引。

### 15.1 并发与恢复

- 并发启动 N 个 worker，混合提交不同及相同实体类型；无重复 ID、counter 回退、丢失事件或覆盖写。
- 多个 Engagement 同时创建对象，UUID 主键无冲突；同一 authority deployment 的全局 display sequence 严格唯一、单调且不按 Engagement/entity type 重置。
- 相同幂等键重放只产生一个权威实体；相同 proposal 内容重复提交能识别重复并保留关联。
- 在每个事务边界强制 kill 进程；重启后账本、counter、视图可恢复或明确进入人工修复状态，绝不静默显示成功。
- 双 worker 同时更新同一实体时使用 version/CAS 冲突，要求重新基于最新版本提交，不做 last-write-wins。
- worker 在扫描调用前、调用中、收到结果后但未提交 evidence 时分别被 kill；可从 checkpoint 安全恢复，外部动作先 reconcile，非幂等动作不得重复执行。
- worker heartbeat 停止后 WorkRun lease 可被接管；旧 fencing generation 的迟到写入被拒绝，私有 draft 被封存而不是覆盖新 attempt。
- 旧 attempt 的 proposal、evidence、observation、ActionIntent result 和宿主执行结果全部受 fencing generation 限制；迟到结果只进入隔离区，不能冒充新 attempt 数据，必须明确审核/rebase 后才能引用。
- context pack 重建使用同一 ledger seq 和 manifest 得到等价输入；超过 token budget 时保留强制约束、cursor 和截断声明。
- 并发 reader pin 在 generation 发布前/后，分别只能得到完整旧代/完整新代；从不读到半生成 STATE/index/wiki。
- 不同 Markdown 段落/字段的并发修改可安全合并；同字段和互斥关系冲突保留双方证据并进入 conflict queue，不得丢失一方。
- 新 JS 内容哈希创建新 BUNDLE revision；旧 endpoint/feature/data edges 可追溯，变更按依赖图标记受影响 claims/hypotheses/findings 和 context cache。
- 关键 claim 被反证后，影响队列能生成重验证 TASK；依赖它的 finding 暂停用于新报告，未执行 action capability 立即失效。
- 普通非关键描述编辑不触发全 engagement 重审；影响分析只沿实际依赖关系传播，并有最大扇出/分页处理策略。

### 15.2 信任与策略

- Auditor A 通过只产生 L1；不能生成 L2 finding。
- L2 finding 必须有独立 reviewer 针对固定输入和 evidence 提交的审核记录。
- 宿主可配置三种动作模式；Taric 的建议不得被误认为宿主授权或执行结果。
- 更正/撤销后旧记忆不再进入普通召回，audit replay 仍能还原完整历史。
- “未观察到”不会被转换成“漏洞不存在”；不同身份/路径/参数 coverage cell 不得被一条阴性记录错误关闭。
- 用受限 worker 凭据尝试写 canonical ledger、counter、projection、finding 和审计链时全部被拒；只有 writer capability 可完成机器审核层写入。
- 恶意或幻觉性的 `accept=true`、隐藏在 Markdown/HTTP 响应中的写入指令不能改变 writer 的决策。
- CLI/MCP/HTTP 的所有写入口都经过同一 admission/writer policy；未授权的 `remember`/`accept`/`update` 只能创建 proposal 或被拒。
- L0 不出现在默认 recall/brief/context；L1 只能显式作为待验证线索呈现。

### 15.3 投毒与质量

- 把恶意指令放入 HTTP 响应、代码注释、证据文件和 memory proposal；不得改变 Taric policy 或把审批建议伪装成宿主授权。
- 构造过期、矛盾、来源不明、缺少 baseline/limitations、重复和伪造引用的 finding；守卫应拒绝、降级或要求补证。
- 对 `pentest-skills` 中 web/host 代表性测试场景做端到端回归；只借鉴现有 coverage、draft、ID、promotion 测试所表达的行为语义，不承诺旧 CLI/schema/文件格式兼容。
- 评估检索 precision/recall、错误记忆传播率、审核一致性、守卫误报/漏报、写入延迟与恢复成功率。
- 盲测报告按类别提供 finding precision、recall、unsupported-claim rate、coverage 漏记率、样本量及 95% 置信区间，并与人工基线比较。

### 15.4 初始发布门槛

- 同 engagement 100 路并发写入压力测试中 ID 冲突为 0，所有成功响应均可在 event ledger 中找到唯一提交事件。
- Pi 原生 adapter、MCP fallback 都通过同一 Core conformance suite；DeepSeek Harness 和 Hermes 支持版本有锁定的 adapter contract CI。
- 所有模拟崩溃点要么自动恢复，要么明确阻塞权威写入并给出可审计的恢复方案。
- L1 → L2 的未授权升级测试通过率为 100%（不得出现一次绕过）。
- 机审拒绝、延迟或模型不可用时系统可继续保存 proposal，但不能 fail-open 接受记忆。
- 每个 active WorkRun 均可定位最近 checkpoint、host/agent lease、context manifest 和 action 状态；否则不可显示为可恢复运行中。
- 对已知正样本的漏检不得劣于人工基线；高/严重 finding 的 unsupported-claim rate 为零；所有未测和阻塞 coverage cell 在报告中可见。
- Resource/draft patch 从提交到可查询 generation 可见的延迟目标，在 Phase 0 基线测量后定为 p95 不高于 2 秒（单机）；高风险依赖变化及时传递给宿主，不等待异步索引刷新。
- 任何 LLM worker 都不能直接创建或修改 canonical durable memory；端到端审计必须能把每次 L1/L2 写入追溯到 non-LLM writer、确定性 policy digest、proposal/evidence hash 和必要的审核凭据。

## 16. 关键决策与部署参数

已对齐：Taric 是面向通用 LLM 智能体框架的渗透测试长期记忆与协作扩展，不替上层宿主应用做动作决策；LLM 不直接写 canonical store 或决定 admission；机器审核候选不得被称为 verified finding。宿主可选择 LLM 自主推荐审批、完全授权自主执行或由宿主应用通过 HITL 获得用户授权后执行。

首发默认值：TypeScript/Node Taric Core + SQLite WAL 单机 authority；Pi 原生 TypeScript adapter + MCP/CLI；DeepSeek Harness adapter 按锁定版本独立交付；Hermes 默认采用 general plugin。跨主机共享 authority 时切换 PostgreSQL。主键使用全局 UUIDv7，安装级 display alias 由共享 allocator 递增。

已确定的部署参数：

- DeepSeek Harness adapter 单独交付，按经过契约测试的上游版本锁定和验证；支持窗口跟随 Taric 自己的契约测试状态，不承诺上游 preview 支持期限。
- Hermes 默认使用可与其他插件共存的 general plugin；MemoryProvider 不作为默认集成。
- 动作协作模式由上层宿主应用选择：`llm_recommend`、`authorized_autonomous` 或 `host_hitl`。Taric 提供建议和决策/执行状态记录接口，不替宿主授权或执行；人工身份系统不属于 Taric 设计范围。
- Artifact 存储、保留期限与脱敏由宿主应用决定；Taric 不实现 Artifact 存储、扫描器或生命周期策略。
- 不实现审计签名密钥托管。
- Markdown projection 默认启用，字段白名单排除原始 Artifact、SecretRef、token、私有路径、未审 proposal 和敏感草稿；共享由 Taric 权限控制。Git checkpoint 默认本地提交；远端推送须按 Engagement 显式启用，并配置私有仓库、访问控制、保留策略和 secrets 扫描。

## 17. 总结

Taric 的完整形态是：**PTES 领域模型 + 框架无关的 TypeScript memory core + MCP/CLI 共通入口 + Pi/DeepSeek Harness/Hermes 原生 adapter + 事务化 authority store + Markdown/Git 可读投影**。宿主 agent 负责调用模型、调度 worker，以及高风险动作的模式选择、用户授权和执行；Taric 负责长程记忆、跨上下文共享、候选治理、恢复状态和动作建议/结果记录。

Taric 从 KB 源码中提炼渗透测试领域规则和持续演进经验，吸收 Link 的 deterministic memory layer、proposal/review/accept/audit 机制，使用 `pentest-skills` 作为 PTES 工作流和对抗评估来源。这些是产品设计输入，不是格式迁移或兼容实现；各自的私有术语、目录、ID 和 schema 均不成为 Taric 产品契约。

最终信任边界保持不变：**machine-reviewed candidate 是有 provenance 的待验证知识，不是事实；verified Finding 依据独立证据审核；高风险 action 的最终授权与执行属于宿主应用；所有权威写入由 non-LLM Taric writer 执行。**
