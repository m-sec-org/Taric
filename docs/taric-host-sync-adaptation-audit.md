# Taric 宿主同步适配：终审评估报告

> **版本**：v3（2026-10-24）
> **审查对象**：[Taric 适配设计](taric-host-sync-adaptation-design.md)、BreachWeave 宿主工作区输入文档《Taric外置记忆集成差距分析与建议方案.md》（v4，未随 Taric 仓库分发）及本工作区实现。
> **代码基线**：HEAD `73a6dfd` 加当前未提交工作区改动；本报告不代表已提交版本或正式发布物。
> **范围**：Taric 侧设计与实现、所记录的容器验证和跨仓契约风险。未执行 BreachWeave 真实部署验收，不能据此宣称跨仓集成通过。

> **后续状态（2026-10-25）**：本文是 2026-10-24 修复前的历史评审。其关于 Work/Coverage 分页、API 版本、lease 订阅唤醒、Artifact 单次读取、review pack 绑定及发布证据的阻断结论，已由 [host-sync contract change](../openspec/changes/archive/2026-10-25-close-host-sync-contract-gaps/release-report.md) 和 [当前候选发布报告](../openspec/changes/harden-taric-authority-runtime/release-report.md)更新。真实第三方宿主、容器挂载、远程 gateway 与双进程多主机仍按 profile 保持未验证；不要把本文原结论当作当前源码状态。

---

## 1. 独立插件边界与责任归属

Taric 的产品边界是独立的外置记忆、权威状态和治理插件。Taric 不运行模型、不选择或启动 agent、不调度工具、不执行目标系统操作，也不替宿主/operator 决定动作是否授权。模型调用、agent 生命周期、目标与工具选择、Scope/ROE 执行、HITL 和动作授权均属于上层宿主职责。

Taric 负责的是可验证的状态与治理契约：记录和查询权威实体、执行非 LLM admission/hard-gate、维护 host-only capture 与 provenance、提供 WorkItem/WorkRun 的任务状态接口、计算覆盖状态、提供无内容的状态提示，以及在明确授权时对绑定任务会话 spool 中的 opaque 原始字节做完整性保护和持久化。`resource_refs` 是调度提示，不是目标资源锁；通知是提示，不是 agent 启动命令；`coverage.gate` 是状态判断，不是关闭 Engagement 的决策。

Artifact 可以完全由宿主外部管理。只有宿主显式选择 Taric 的文件摄取或 spool 存储扩展时，Taric 才需要验证绑定会话、路径/对象边界、字节完整性、幂等和失败恢复。Taric 不解析、不脱敏、不扫描 opaque 内容，也不负责凭据生命周期、内容保留期限、删除策略或宿主侧秘密管理；这些由宿主/operator 负责。

因此本报告采用两个验收 profile。它们用于判断某一发布声明是否成立，不表示每个宿主必须启用所有扩展：

| Profile | 结论含义 | 必须验证的内容 |
|---|---|---|
| Taric 独立插件基线 | 判断通用插件本身及其公开合同是否可发布 | 对外公开的 API、治理和状态语义正确，版本可识别；订阅通知、Bun 嵌入、文件摄取、review CLI 等分别作为可选能力，不因存在于方案中就成为每个宿主的必选项 |
| 宿主嵌入扩展（BreachWeave R 路线） | 判断特定宿主是否可选择进程内嵌入 | T-A Bun 驱动与可安装分发、D4 三方版本矩阵、宿主 principal 映射、可选 T-E/T-G/T-F，以及真实宿主的调度、工具、凭据和 spool 验收 |

## 2. 终审结论

Taric 已实现大部分计划中的接口和能力，但当前工作区不能被认定为“本轮宿主同步适配能力集全部完成”，也不具备可复核的发布候选证据。对本轮公开的状态/API 能力，WorkItem/覆盖分页漏项和新增操作未推进 API 合同版本是发布阻断项；T-D 订阅若继续作为已支持公开能力，也必须修复时间驱动租约通知。T-A Bun 分发、T-E 文件摄取和 T-G review harness 是宿主选择启用的扩展，其缺口只阻断相应扩展的发布/启用声明，不应被表述为所有 Taric 部署都必须具备的能力。

就 BreachWeave 的 R 路线而言，Taric 的进程内集成前置条件尚未闭合。即使修完 Taric 问题，BreachWeave 仍需验证宿主配置、agent 调度、资源冲突协调、工具与动作授权、凭据管理、spool/外部 Artifact 选择和真实运行时行为。当前比较准确的状态是：**独立插件基线尚未完成收口；BreachWeave 嵌入扩展不可宣称通过；Taric 不承担宿主的模型和执行职责。**

本报告不以主观百分比衡量完成度；“已实现”只表示实现存在，不等于设计验收、发布契约或真实宿主集成已经通过。

### 2.1 审查范围与证据

设计共列出 11 项能力：T-A/B/C/D/E/H/F/G 与 D1/D2/D4。本次将它们区分为核心插件能力和宿主嵌入扩展。代码核对覆盖 dispatch、持久化、授权、文件传输、订阅、包清单及对应测试。原审核记录的测试结果如下；凡未保存命令、完整日志或环境摘要的项目，应视为该工作区报告的结果，而非可独立复跑的审计工件。

| 验证面 | 原审核记录 | 证据强度与边界 |
|---|---|---|
| macOS `npm test` | exit 0；核心 317 项中 308 通过、9 项因未设置 `TARIC_TEST_DATABASE_URL` 跳过 | 未覆盖实时 PostgreSQL；需保留完整命令和日志以便复核 |
| Node Linux 容器全量测试 | Node 24.22.1，`node:24-alpine`，exit 0 | 镜像使用可变 tag；报告未给出 digest 和逐包摘要 |
| Bun 驱动 conformance / 专项 / 嵌入冒烟 | Bun 1.3.14，10 pass / 0 fail；12 场景 conformance 报告已归档 | benchmark 文件可追溯；仍是驱动与嵌入验证，不等同 BreachWeave 真实集成 |
| Unix socket 端到端冒烟 | 18/18 通过，覆盖文件摄取、查询、覆盖、通知和多 principal | 未标出脚本路径、容器 digest、完整输出；目前无法从报告单独复现 |
| PostgreSQL、多主机运行时 | 未执行，9 项数据库测试跳过 | 不能据 SQLite 结果宣称 PostgreSQL 或多主机认证通过 |
| BreachWeave 真实宿主验收 | 未执行 | 权限、包安装、重启恢复、跨进程协作及挂载路径均未验证 |

测试通过只能说明相应样例通过，不能抵消下文确认的代码路径缺陷或尚未验证的契约。

## 3. 能力与跨仓目标对照

| Taric 项 | 结论 | 对 BreachWeave R 路线的影响 |
|---|---|---|
| T-A 驱动可移植性与发布面 | **嵌入扩展部分完成**：驱动契约、exports 和 Bun 驱动已在工作区；`@taric/core`、`@taric/schemas`、`@taric/driver-bun-sqlite` 仍为 private，未验证干净跨仓安装 | 不影响 Taric 通过 RPC/宿主自管存储作为独立插件运行；若 BreachWeave 选择 C1 进程内嵌入，则必须完成正式分发和安装验证，或保留可复现桥接回退 |
| T-B `resource_refs` / `work.query` | **核心接口存在，正确性未通过**：分页存在跳项；该接口只表达任务资源关联和查询提示，不提供调度、agent 启动或跨 WorkItem 资源锁 | Taric 保持状态服务边界。BreachWeave 自己负责单写者/串行调度或其他原子协调；多调度器并发时不能把 query + claim 当成资源互斥保证 |
| T-C `coverage.gate` / `coverage.query` | **核心接口部分完成**：dispatch、角色限制和投影已实现；gate 判定与 visibility 摘要来自两次读取 | Taric 提供覆盖状态和可关闭条件的计算结果；operator/宿主决定是否关闭或继续执行。并发更新时应统一快照或声明独立读取水位 |
| T-D 宿主订阅信号 | **核心提示能力部分完成**：`delta` 水位通知、去抖、重鉴权和 RPC 通知帧存在；时间驱动租约主题不可靠，其他主题边沿/重复语义未闭合；`l1_backlog` 当前是“存在任意 L1”，不是设计所说的“越阈值” | Taric 只发送无内容状态提示，不启动 agent、不调度任务。宿主仍需通过权威查询/轮询恢复状态，不能把信号当作状态事实 |
| T-E `artifact.ingest_file` | **可选 Artifact 扩展部分完成**：一次性流入库流程存在；路径检查与后续打开/删除之间有竞态，源文件读两遍，真实进程中断恢复未验证 | 宿主完全外部管理 Artifact 时，T-E 不构成独立插件基线门槛。启用时 Taric 只负责绑定 spool 边界、opaque 字节完整性、幂等和失败语义；`delete_source` 只执行宿主/operator 对本次操作的明确授权。凭据、脱敏、保留期限和删除策略由宿主/operator 负责 |
| T-H 派生证据来源门 | **核心治理能力已实现，宿主启用未验证**：默认关闭；`operator` 来源通过 `source_kind: host` 表达 | Taric 以非 LLM 策略检查来源，不运行模型、不生成归纳结论。BreachWeave 必须显式配置策略并验证捕获链保留可信来源 |
| T-G `taric review` | **参考扩展部分完成，模型模式越界**：CLI 可生成审阅包和提交 review，但证据快照及策略摘要未与实际审阅输入绑定；`--model` 路径会从 Taric CLI 调用外部 provider | admission 与 `review.submit` 可作为 Taric 治理接口；模型调用必须由宿主/operator 驱动。Taric 可提供确定性审阅材料与提交契约，不应承担 reviewer 模型调用、模型池或 verdict 决策 |
| T-F 多 principal 网关 | **可选传输扩展已实现并有测试** | 主要服务多进程/远程或桥接回退；不属于 Taric 独立插件基线，也不是进程内嵌入的必要条件 |
| D1 / D2 / D4 | **宿主适配扩展已核对**：Pi 认证版本、未认证降级和 Taric 版本矩阵存在 | Taric 不要求所有宿主使用 Pi；D4 的 BreachWeave CI 消费端和宿主/容器/Taric 三方配对尚未验收 |

BreachWeave v4 的 A1/A2（结构化 Scope/ROE 与 WSTG/ASM 覆盖字典）是授权渗透上线的 P0 宿主要求，按通用性边界不属于 Taric core，也不在本报告的代码审查范围内。Taric 侧适配通过不能替代这两项宿主验收；在真实授权目标上运行前，必须另行证明越界拦截和覆盖字典配置有效。

**对 v2 审核结论的边界修正**：原报告把 T-A 包发布、T-E Artifact 文件直取、T-G review harness 等扩展缺口并入统一的“Taric 未完成/不可发布”结论，范围过宽；这些应按是否纳入某个部署 profile 分别判定。更重要的是，T-G 的 `--model` provider 调用虽在 CLI 层实现、模型可能运行于远端服务，但调用编排仍由 Taric 发起，和“Taric 自身不运行模型”的产品边界不符。应将模型调用移交宿主；Taric 保留 admission 固定输入读取、审阅材料导出和 `review.submit` 等确定性契约。Human review CLI 是否保留属于可选的人工作业界面，不应被描述为 Taric 必需职责。`artifact.ingest_file` 的 `delete_source` 也只能表示宿主/operator 对本次搬运的明确授权清理，不得演变为 Taric 自行决定的内容删除或保留策略。

## 4. 本轮能力集的缺陷与条件门槛

### P1：分页在扫描预算耗尽时可能跳过匹配项

`workItemsPage` 和 `coverageCellsPage` 都把过滤放在 500 行扫描窗口之后。当前逻辑在 `more === true` 时无条件把游标锚定到最后扫描行；如果该窗口内匹配数超过 `page_size`，未返回的匹配记录会被游标越过，后续页永远不可见。原报告的 560 行、120 条命中、页长 50 的例子成立。

**修复要求**：若当前扫描窗口包含超过页长的匹配项，锚定最后一个已返回匹配项；否则锚定最后扫描项，以便稀疏或零命中页仍向前推进。不能简单地在所有预算耗尽场景都锚定最后返回项，否则空结果页可能没有游标，或反复扫描同一批未命中行。回归用例应同时覆盖“单窗口内超页长命中”“稀疏匹配跨多个窗口”“空匹配但仍有后续行”，并断言完整遍历无重复、无遗漏。

### 扩展项：复核 harness 没有固定实际审阅输入

`packages/cli/src/review.ts` 通过一次普通 `query`（最多 1000 条、未跟随游标）查找被引证据，没有读取 admission 生成的 `fixed_proposal_evidence_snapshot`；`review.submit` 只提交提案 `input_hash`，未提交实际证据快照 hash。服务端因此可能按提交时的权威状态处理 review，而 harness 展示给 reviewer 的证据集合并非该次治理决定所绑定的集合。策略摘要也由 CLI 默认值或参数提供，没有证明来自该提案 admission。

**修复要求**：这不是 Taric 独立插件基线的阻断项。若发布或采用 `taric review` 参考扩展，应从对应 admission 结果读取固定快照，完整解析其中引用及版本，审阅包标出并绑定 snapshot hash 与 admission policy digest，提交时由服务端校验。证据在生成审阅包后变化时必须拒绝提交或要求重新生成审阅包。覆盖超 1000 条引用和策略变更窗口。reviewer 的模型、人审和最终 verdict 仍由宿主/operator 提供。

### P1（公开合同）/扩展门槛（T-A）：分发面与 API 合同版本未兑现

`private: true` 阻止包按 registry 正式发布；core 的运行依赖 `@taric/schemas` 也为 private，Bun 驱动包同样如此。exports map 和 workspace 测试并不能证明 BreachWeave 可以通过设计所说的包依赖完成进程内嵌入。公开 npm 并非唯一选择，但必须确定一种可安装、可复现的分发方式并在干净项目验证完整依赖闭包。这里是进程内嵌入 profile 的阻断项，不是 Taric 通过 RPC 或由宿主源码集成时的独立插件基线阻断项。

同时，新增的 `work.query`、`coverage.gate/query`、`artifact.ingest_file` 等合同仍对应 `API_CONTRACT_VERSION = 1.0.0`，与设计 §1 的 minor 版本演进要求冲突。需更新版本及 compatibility matrix，并验证旧/新合同协商行为。若决定暂不发布包，应把设计改为明确的源码集成或 Node 桥回退，并重新界定 T-A 验收，不能保留“跨仓嵌入已解锁”的结论。

### 条件性 P1：`lease_expiry` 不是时间驱动信号

订阅轮询器仅在 `dataVersion()` 改变后调度投递。租约到期本身不写数据库；没有其他提交时，系统不会重新评估 `subscriptionTopicStates()`，因此静默窗口内租约可到期而没有通知。其他非 `delta` 主题在状态持续为真时也可能随每个无关提交重复发送。

**修复要求**：如果 Taric 继续公开并声明支持该主题，需定义“临近到期”提前量与“到期/被 reclaim”的独立语义，用到期时间安排唤醒或采用有上限的时间轮询，并按主题做边沿去重。验证无数据库写入、只有时间推进时仍触发；同时验证重新连接后的权威状态恢复。若不实现，应从首期已支持主题和完成声明中移除 `lease_expiry`，并明确宿主用权威查询/轮询恢复。此订阅通知仅提示宿主自行决定是否采取调度动作。

## 5. 安全、接口和集成残余风险

| 级别 | 问题 | 影响与处理要求 |
|---|---|---|
| 条件性安全门（仅启用 T-E） | `artifact.ingest_file` 先 `realpath/stat`，后按路径重新打开并可按路径删除 | 若宿主授权 Taric 读取绑定任务会话 spool，session root 被另一主体并发写入时，符号链接/路径替换可能使读取越出绑定目录，也可能删除替换后的目标。采用受信 staging 目录和受控文件描述符读取；仅用 `O_NOFOLLOW` 不能保护可变父目录或后续按路径删除。同步读取一次、在实际上传字节流上累计 hash，并在提交时校验；若需“快照”语义，限制写入者或先生成不可变文件。宿主外部管理 Artifact 时，该项不构成 Taric 基线发布门。Taric 不负责凭据、脱敏、保留或删除策略。 |
| P2 | `work.query` 对 model 角色返回原始 WorkItem | 与 `query` 的 `sanitizeModelRecord` 策略不一致。检查 WorkItem 内容中可能含 URL、摘要或其他不应直接暴露给模型的字段，复用/定义明确的模型投影，并加字段级断言。 |
| P2 | `coverage.gate` visibility 摘要第二次读取 | gate 和摘要可能对应不同数据库水位。改成同一快照返回，或为二者返回明确的独立 `read_seq`，避免宿主据拼接结果作关闭判断。 |
| P2 | review policy digest 来源未绑定 | harness 可用默认或 CLI 值填摘要；应从提案 admission 固定结果读取并验证。与 R1 的证据快照绑定一起修复。 |
| P2 | RPC 通知写入没有显式背压处理 | 慢订阅者可能长期积累 socket 写缓冲。增加 drain/队列上限、超限断开并依赖重连补读；验证队列有界。 |
| P2 | `since_read_seq` 订阅参数未使用；权限失效退订无可审计结果 | 明确注册时是否补发 delta，以及 `since_read_seq` 的行为；“退订被记录”是设计验收项，当前只停止通知。记录不含敏感实体的投递/退订元数据或修订验收承诺。 |
| P2，需复现 | SQL 驱动初始化与关闭并发、初始化失败后的连接清理 | 当前报告指出连接可能泄漏或实例不可重试；应给 Node 与 Bun 驱动添加确定性生命周期测试，确认后再作为已证缺陷或关闭项。Bun 与 Node 的并行机制复制会扩大修复漂移面。 |
| 集成前置 | `resource_refs` 不是资源锁 | Taric 设计明确不承诺目标资源锁。BreachWeave 单个串行调度器可用“查询 + claim + 本地互斥”实现其调度策略；若允许多个调度器并发，必须由宿主提供原子协调，否则不同 WorkItem 可同时 claim 并操作同一资源。需要针对真实调度拓扑做并发验收。 |
| 集成前置 | T-H 默认关闭，T-G 仅提供可选 harness | BreachWeave 必须配置来源门并验证 `host/operator` 捕获最终记为 `source_kind: host`；reviewer 池、审批流程、模型调用和 SLA 另行设计，Taric 不运行 reviewer 模型。 |
| 集成前置（仅启用 T-E） | T-E 只允许 session binding root 内的路径 | 若宿主显式授权 Taric 保存 opaque 原始内容，需在 Bun 宿主和容器挂载卷上验证同一物理路径映射、文件可见性、权限及容器写入后的竞态行为。若 Artifact 由宿主外部管理，则不需要这条 Taric 存储路径；当前 Taric 冒烟不能代替启用该扩展后的验收。 |

## 6. 低优先级维护项与审计材料

以下项目不应与独立插件基线的阻断正确性问题混为一谈，但需排入后续维护或对应扩展发布：`activeWorkRuns` 的未使用接口与重复查询实现；Bun/Node 驱动并发逻辑复制；work/coverage 校验规则双份维护；principal role 和 Pi 版本的多处硬编码；`coverage.gate` 仍引用泛化 `apiSuccess` 而未使用已注册的专用结果契约；CLI 帮助未列 `gateway`/review harness；启用 T-E 时 `TARIC_INGEST_MAX_BYTES` 对 `0`/负值的配置报错语义；`review.ts` 未使用变量和 model 模式忽略 `--verdict` 等细节。每项应先确认真实调用与预期契约，再决定删除或统一来源。

本批次 10 个归档变更目录均有 `specs/` delta，但均缺少设计要求的 `release-report.md`；任务勾选完成仍未形成逐项发布审计闭环。补齐每项实际合同变化、版本、测试环境、失败注入、已知偏差及发布结论，并核对现有 spec delta 与实现一致。不要只为满足目录形式复制通用文本，应让报告能追溯对应任务和测试工件。

## 7. 发布与集成验收门槛

若要声明本轮设计列出的宿主同步适配能力集已经完成，至少需要：

1. 修复分页漏项，并通过稀疏/密集/空页的完整遍历回归。
2. 决定并推进 API 合同版本及矩阵，使新增操作可被宿主识别。
3. 若保留 `lease_expiry` 订阅主题，修复时间触发并明确状态边沿和宿主恢复语义；否则从本轮交付能力中移除并明确权威轮询路径。
4. 修正 `work.query` 模型面投影、coverage 快照一致性和通知背压；对驱动关闭生命周期风险完成可重复测试。
5. 为 10 个归档变更补齐 `release-report.md`，核对已有 spec delta 与实现一致；保存 Node、Bun、端到端测试的命令、镜像 digest、日志和跳过项。

以下是可选扩展或特定宿主的附加门槛，而不是独立插件基线门槛：

1. **BreachWeave Bun 进程内嵌入 profile**：确定可复现的 registry/内部包分发，完成 `@taric/core`、`@taric/schemas` 和 Bun 驱动的干净项目安装；验证 driver 初始化、principal 映射、D4 三方版本矩阵和真实宿主重启行为。
2. **T-E opaque spool profile**：仅在宿主显式授权时启用；验证 session binding root、受控文件读取、字节 hash、幂等、失败恢复和源文件处理。Taric 不解析、不脱敏、不扫描，不接管凭据或保留期限；宿主也可选择完全外部管理 Artifact。
3. **T-G review profile**：将 `--model` provider 调用移至宿主；Taric 提供 admission 固定证据快照、policy digest 和确定性审阅材料，review 提交由服务端校验其绑定。reviewer 模型、人审、verdict、SLA 由宿主/operator 负责。

BreachWeave 侧另需用真实宿主验收启用后的 T-H 策略、agent 调度、工具调用和动作授权、资源并发约束、外部 Artifact 或授权 spool 选择、通知丢失后的恢复，以及可选 reviewer 流程。Taric 不承担这些宿主行为。若声明 PostgreSQL/多主机支持，再补实时 PostgreSQL 场景；SQLite 容器结果不外推为该能力认证。

**最终判定**：本工作区的 Taric 独立插件实现处于“主要能力已形成、若干核心合同和正确性门槛未通过”状态；BreachWeave 的 Bun 嵌入、Artifact spool 和 review harness 处于各自扩展未闭合状态。未满足对应 profile 的门槛前，不应对外宣称该 profile 已完成；未完成真实 BreachWeave 宿主验收前，不应宣称 R 路线集成通过。Taric 的职责边界保持为状态、记忆和治理服务，不包含模型运行、agent 启动、工具执行或目标动作决策。
