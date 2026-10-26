# Taric 宿主同步适配：终审评估报告

> **版本**：v3 历史评审（2026-10-24；状态校正于 2026-10-26）
> **审查对象**：[Taric 适配设计](taric-host-sync-adaptation-design.md)、BreachWeave 宿主工作区输入文档《Taric外置记忆集成差距分析与建议方案.md》（v4，未随 Taric 仓库分发）及本工作区实现。
> **代码基线**：HEAD `73a6dfd` 加当时未提交工作区改动；下文原评审结论不代表当前代码或正式发布物。
> **范围**：Taric 侧设计与实现、所记录的容器验证和跨仓契约风险。未执行 BreachWeave 真实部署验收，不能据此宣称跨仓集成通过。

> **状态校正（2026-10-26）**：本报告第 2–7 节的缺陷与门槛是修复前审查记录，不能作为当前未完成项。分页、API 合同版本、订阅租约唤醒、单次 descriptor 读取、review pack 固定绑定和各变更的差距报告已有实现与回归测试，见 [host-sync 历史验收报告](../openspec/changes/archive/2026-10-25-close-host-sync-contract-gaps/release-report.md)。当前 `1.0.0` build、typecheck、矩阵校验和 PostgreSQL 配置下的 workspace 全量测试通过：Core 351、Schemas 10、CLI 32、MCP 12、Hermes 5、Bun driver 11，均无失败或跳过。PostgreSQL 当前源码 runtime 12/12、独立逻辑备份恢复、两个 host 容器经共享 bridge network 的 lease/reclaim、容器 bind-mounted spool 检查通过；报告保存在本机 `/tmp`。另隔离安装并启动了真实 Pi 1.4.0 RPC 进程，Taric 扩展通过其 `ExtensionAPI` 注册成功，但没有调用模型/工具。真实 BreachWeave、完整第三方宿主工作流、跨物理机/网络恢复仍未验收。可选 TLS TCP/HTTPS gateway 已实现，并有本机 loopback 端到端测试；生产网络部署及跨机故障恢复仍未验收。

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

截至 2026-10-26，修复前审核列出的 Taric 实现缺陷均已完成对应实现并通过合同/回归测试；当前 `1.0.0` build、typecheck、矩阵、workspace 测试和隔离 tarball consumer 验证通过。PostgreSQL 当前源码 live/runtime 和同机双容器 lease/reclaim 已通过；跨物理机部署与网络中断恢复仍未验证。容器 spool bind mount 已在两个顺序运行的 Node 容器间通过写入、替换和原字节读取检查；这不等于完整第三方宿主集成认证。Pi 1.4.0 真实 RPC host 已加载 Taric extension，未调用模型/工具。Bun 驱动、通知、review pack 和显式授权文件摄取是已实现的可选 profile，不是每种部署都必须启用的能力。

就 BreachWeave 的 R 路线而言，Taric 的本地插件合同、workspace 测试和 `1.0.0` tarball consumer 验证已通过；BreachWeave 的进程内集成仍需验证宿主配置、agent 调度、资源冲突协调、工具与动作授权、凭据管理、spool/外部 Artifact 选择和真实运行时行为。PostgreSQL 当前源码 runtime 与同机双 host 容器 lease 已验证，但不代表 BreachWeave 或跨物理机部署认证。包仍为 private、未发布至 npm registry。Taric 不承担宿主的模型和执行职责。

本报告不以主观百分比衡量完成度；表中的实现状态、当前工作区验证、部署 profile 认证和真实宿主集成是不同结论，不互相替代。

### 2.1 审查范围与证据

设计共列出 11 项能力：T-A/B/C/D/E/H/F/G 与 D1/D2/D4。本节保留 2026-10-24 原审核的范围；当前工作区验证摘要见本节表格，profile 认证另见下文。历史报告中的测试计数和容器结果不属于 1.0.0 运行结果。

| 验证面 | 原审核记录 | 证据强度与边界 |
|---|---|---|
| `1.0.0` 当前工作区：build/typecheck/矩阵/全量测试 | 通过；PostgreSQL 配置下 Core 351，Schemas 10、CLI 32、MCP 12、Hermes 5、Bun driver 11 全通过 | 本地实现与 PostgreSQL live 证据；不等同跨机网络恢复或第三方宿主认证 |
| 独立 `1.0.0` clean consumer | 通过；从 tarball 安装并验证包消费 | 验证本地 tarball 分发；不表示 npm registry 已发布 |
| 文档链接 | 当前检查通过 | 只验证链接目标存在，不判断外部系统当前状态 |
| PostgreSQL live / 双进程 | 12 个当前源码 runtime scenario、独立逻辑 restore 和两个 Node host 容器 lease/reclaim 均通过 | 两个容器只在一台工作站；跨机器、网络中断恢复仍未验证 |
| 第三方宿主、远程 gateway | Pi 1.4.0 真实 RPC 启动并加载 Taric 扩展；无模型/工具调用。TLS TCP/HTTPS gateway 有本机 loopback 端到端测试 | Pi 完整工作流、DeepSeek/Hermes、真实 BreachWeave 仍需宿主验收；gateway 的生产网络部署、凭据运维与跨机故障恢复仍待验证 |
| 容器 spool 挂载 | 两个顺序 Node 容器对同一临时 bind mount 完成写入、替换和 hash/原文验证 | 不覆盖第三方宿主权限模型、共享写入、存储故障或断电耐久性 |

本轮本地测试证明对应样例在当前工作区通过；它不证明完整第三方宿主工作流、跨机网络/生产容器部署或生产容量已经认证。

## 3. 能力与跨仓目标对照

| Taric 项 | 结论 | 对 BreachWeave R 路线的影响 |
|---|---|---|
| T-A 驱动可移植性与分发 | 驱动契约、exports、Bun driver 已实现；`1.0.0` clean consumer 通过 tarball 安装验证。npm registry 发布仍未完成 | Bun 本地嵌入具备本地验证资产；不等同 registry 发布，也未验证 BreachWeave 消费与真实运行 |
| T-B `resource_refs` / `work.query` | 字段、dispatch、model projection 和 keyset 分页已实现并有回归测试；资源引用仍是提示，不是资源锁/调度器 | 宿主负责 worker 生命周期、全局资源互斥、限速和动作执行 |
| T-C `coverage.gate` / `coverage.query` | dispatch、角色、投影已实现；gate 与 visibility 使用同一维护读取快照及水位 | 返回状态与关闭条件，不替宿主关闭 Engagement 或授权动作 |
| T-D 宿主订阅信号 | Core 与 authenticated adapter RPC 提供有界 best-effort 通知、重鉴权、阈值/时间驱动租约提示、背压和轮询恢复 | 信号不是事实流或调度命令；MCP resources subscription 仍未支持，生产发现延迟无 SLA |
| T-E `artifact.ingest_file` | 可选实现已做绑定根校验、单 descriptor 读取、hash、幂等发布和失败测试；当前 Node/Bun 不支持身份条件 unlink，因此即使显式要求也保留源文件 | 两个顺序 Node 容器已对同一 bind-mounted spool 完成写入、替换和原字节校验；第三方宿主、生产权限模型、共享写入和存储故障仍未验收 |
| T-H 派生证据来源门 | 来源门与 `source_kind` 治理已实现；策略需显式配置 | 源码/合同测试不等于 BreachWeave 捕获链已启用或第三方来源真实 |
| T-G `taric review` | 确定性 pack 固定 admission 证据快照/policy 并由服务端校验；CLI 只导出或转交外部结果，不运行模型/provider | reviewer 选择、人工/模型审阅、verdict 与 SLA 属于宿主/operator |
| T-F 多 principal gateway | 本地 gateway/RPC 能力已实现并有测试 | 远程网络部署、撤销与跨机重连 profile 未验证 |
| D1 / D2 / D4 | Pi 1.4.0 认证清单、开放自定义 adapter ID、兼容矩阵生成均已存在 | 未认证版本仍按降级/unsupported 处理；BreachWeave CI 的三方配对消费未验证 |

BreachWeave v4 的 A1/A2（结构化 Scope/ROE 与 WSTG/ASM 覆盖字典）是授权渗透上线的 P0 宿主要求，按通用性边界不属于 Taric core，也不在本报告的代码审查范围内。Taric 侧适配通过不能替代这两项宿主验收；在真实授权目标上运行前，必须另行证明越界拦截和覆盖字典配置有效。

**历史结论修正**：原 v2 对 T-A/T-E/T-G 缺口的范围判断过宽。当前仍须按 profile 判定：本地实现和 tarball consumer 有证据；registry 与完整真实第三方宿主工作流仍未验证。Pi 1.4.0 的 RPC 启动和扩展加载 smoke 已通过。容器 bind mount 已有本机替换测试，但未认证生产权限、跨机共享或故障恢复。T-G 已移除模型/provider 调用，只接受外部结果并校验 admission 绑定；Artifact `delete_source` 是逐次授权，但运行时无法证明安全条件删除时保留源文件。

## 4. 本轮能力集的缺陷与条件门槛

以下缺陷是 2026-10-24 审核时的发现，后续已进入实现和回归测试，不是当前待办。原复现说明保留用于解释修复动机。

### 历史缺陷：分页在扫描预算耗尽时可能跳过匹配项（已修复）

`workItemsPage` 和 `coverageCellsPage` 都把过滤放在 500 行扫描窗口之后。当前逻辑在 `more === true` 时无条件把游标锚定到最后扫描行；如果该窗口内匹配数超过 `page_size`，未返回的匹配记录会被游标越过，后续页永远不可见。原报告的 560 行、120 条命中、页长 50 的例子成立。

当前 `work.query` 和 `coverage.query` 采用有界 keyset 分页；密集、稀疏和空匹配窗口均按规则推进游标，对应 query/pagination 测试已通过。原 560 行示例只描述修复前实现。

### 历史扩展缺陷：复核 harness 没有固定实际审阅输入（已修复）

`packages/cli/src/review.ts` 通过一次普通 `query`（最多 1000 条、未跟随游标）查找被引证据，没有读取 admission 生成的 `fixed_proposal_evidence_snapshot`；`review.submit` 只提交提案 `input_hash`，未提交实际证据快照 hash。服务端因此可能按提交时的权威状态处理 review，而 harness 展示给 reviewer 的证据集合并非该次治理决定所绑定的集合。策略摘要也由 CLI 默认值或参数提供，没有证明来自该提案 admission。

当前 `review.pack` 从 admission 固定输入构建完整审阅包并绑定 proposal/evidence snapshot/policy digest；`review.submit` 在写入前校验绑定。超过 1,000 条引用和替换后陈旧拒绝已有测试。CLI 只导出材料或转交外部结果，不调用模型/provider；reviewer 生命周期仍由宿主/operator 管理。

### 历史发布缺口：分发面与 API 合同版本未兑现（合同已演进，registry 发布仍未完成）

API 合同已升至 `1.2.0`，兼容矩阵含新增操作；Core、Schemas 与 Bun driver 已提供所需 exports。`1.0.0` tarball 已在独立 consumer 安装和运行通过。包清单仍保留 private，因此这不表示 npm registry 发布，也不表示 BreachWeave 的真实进程内集成已验收。

仍需区分本地 tarball consumer 与 registry 发布，也需区分通用包消费验证与第三方宿主认证。

### 历史缺陷：`lease_expiry` 不是时间驱动信号（已修复）

当前订阅调度器按租约时间安排唤醒；fake-clock 测试验证无数据库提交时提示仍会触发，且不推进 `read_seq`。下列问题描述和修复要求仅记录修复前状态。

订阅轮询器仅在 `dataVersion()` 改变后调度投递。租约到期本身不写数据库；没有其他提交时，系统不会重新评估 `subscriptionTopicStates()`，因此静默窗口内租约可到期而没有通知。其他非 `delta` 主题在状态持续为真时也可能随每个无关提交重复发送。

**修复要求**：如果 Taric 继续公开并声明支持该主题，需定义“临近到期”提前量与“到期/被 reclaim”的独立语义，用到期时间安排唤醒或采用有上限的时间轮询，并按主题做边沿去重。验证无数据库写入、只有时间推进时仍触发；同时验证重新连接后的权威状态恢复。若不实现，应从首期已支持主题和完成声明中移除 `lease_expiry`，并明确宿主用权威查询/轮询恢复。此订阅通知仅提示宿主自行决定是否采取调度动作。

## 5. 历史安全与集成风险记录

下表是 2026-10-24 评审留下的原始问题清单，不代表当前缺陷。适用的当前边界是：Taric 不承诺资源锁、通知不调度工作、Artifact 保持 opaque；第三方宿主、远程网络与容器挂载需要各自验收。

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

本节原列的内部维护项是 2026-10-24 的观察，不是当前缺陷清单；review model/provider 路径已移除。其余关于重复实现、硬编码或帮助输出的观察未在 `1.0.0` 发布验证中逐项复核，不据此断言目前仍存在。

“10 个归档目录缺少 release-report”已过期：这些归档变更现有各自的差距/验收报告。历史报告绑定各自代码基线；不能将其视作 `1.0.0` 的验证产物。

## 7. 发布与集成验收门槛

原清单是修复前门槛。Taric 对应实现现已通过当前本地工作区测试；仍未由当前证据覆盖的部署声明须单独补证：

1. PostgreSQL 跨机验收：当前源码 live runtime、恢复和同机双容器 lease/reclaim 已通过；仍需在不同物理机覆盖共享 authority 竞争、网络分区与恢复。
2. 真实宿主：验证 principal 映射、调度、工具、动作授权和重启生命周期。
3. 远程 gateway / 生产 spool：可选 TLS TCP/HTTPS gateway 已实现并有本机 loopback 端到端测试；容器 spool bind-mount 替换检查已通过。生产网络监听、凭据轮换/撤销、跨机故障恢复与生产 spool 仍须在目标部署环境验收。
4. npm registry 发布：若要声明 registry 可用，发布包并由独立 consumer 从 registry 安装；本地 tarball 验证不替代此门槛。

以下是可选扩展或特定宿主的附加门槛，而不是独立插件基线门槛：

1. **BreachWeave Bun 进程内嵌入 profile**：本地 `1.0.0` tarball consumer 已通过；BreachWeave 自身的包消费、principal 映射、调度和重启仍需真实宿主验收。
2. **T-E opaque spool profile**：Core 文件摄取合同已有测试；容器挂载、权限和重启需要宿主环境验收。当前 Node/Bun 条件 unlink 不可用时保留源文件；也可由宿主外部管理 Artifact。
3. **T-G review profile**：确定性 pack/export/submit 已实现并测试；reviewer 模型、人审、verdict 和 SLA 仍由宿主/operator 负责。

BreachWeave 侧另需用真实宿主验收启用后的 T-H 策略、agent 调度、工具调用和动作授权、资源并发约束、外部 Artifact 或授权 spool 选择、通知丢失后的恢复，以及可选 reviewer 流程。Taric 不承担这些宿主行为。当前 PostgreSQL runtime/恢复和同机双容器 lease/reclaim 已有 live 证据；若部署到不同物理机，仍需单独验证网络分区与恢复，不能用 SQLite 容器结果代替。

**最终判定（2026-10-26）**：Taric `1.0.0` 当前工作区 build、typecheck、矩阵校验、PostgreSQL 配置下的全量测试、独立 tarball consumer、当前源码 PostgreSQL runtime/backup 与同机双容器 lease/reclaim 均通过。容器 spool bind mount 的隔离替换测试也通过。Pi 1.4.0 真实 RPC host 已成功加载 Taric extension，但未认证完整调度/工具/动作流程；真实 BreachWeave、DeepSeek/Hermes runtime、生产网络 gateway 部署和跨物理机网络恢复仍未验收。TLS TCP/HTTPS gateway 已实现并通过本机 loopback 测试。Taric 的职责边界仍是状态、记忆和治理服务，不包含模型运行、agent 启动、工具执行或目标动作决策。
