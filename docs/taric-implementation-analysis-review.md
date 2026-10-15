# Taric 实现分析评审

评审日期：2026-10-14
评审对象：`docs/taric-implementation-analysis.md` 及变更前源码；后续实现状态见下方。
评审结论：原分析方向有源码依据；下文裁决是变更前的历史证据，行号固定于该基线，不应直接用于当前代码。实施后的状态以 [任务清单](../openspec/changes/harden-taric-authority-runtime/tasks.md)、[发布报告](../openspec/changes/harden-taric-authority-runtime/release-report.md) 和下列符号/测试为准。

## Hardening 后的实现状态

当前规格基线为 14 个 `openspec/specs/*/spec.md`。运行时 registry 为 50 个 operation、CLI 标准命令为 45 项、MCP 模型工具为 6 项、schema `$defs` 为 64 项。2026-10-15 独立临时检出的验证：CLI 19、Core 266、Hermes 5、MCP 12、schemas 9，共 311 项全部通过，PostgreSQL live 测试无跳过。[验证 JSON](../openspec/changes/harden-taric-authority-runtime/verification.json) 固定源码、schema、policy、fixture digest 和每项命令输出 digest；build、typecheck、文档链接通过。SQLite/PostgreSQL 共用异步 Core 完整运行时，十二个领域场景和独立恢复已验证。按 operator 在 2026-10-15 的明确决定，人工质量基线仅影响质量发布状态，不阻断 `implementation_complete`。

| 修订点 | 当前实现与可执行证据 |
|---|---|
| writer-owned identity / proposal 零状态边界 | [store.ts](../packages/core/src/store.ts) 的 `initializeEngagement` / `createRecord` / `submitProposal`；[identity-governance-hardening.test.mjs](../packages/core/test/identity-governance-hardening.test.mjs)；[proposal schema](../packages/schemas/schemas/v1/core.schema.json)。创建 canonical UUIDv7 由 Core 分配，更新显式 target/expected_version，非法 domain/envelope 不写 proposal。 |
| L1 / L2 | `admission.evaluate` 仅确定性结构/引用/归属/版本准入，返回 machine-approved phase 与 remaining L2 requirements；`admission.promote_l2` 仅 writer/operator 可用，固定 input/evidence/review 后重算 policy hard gates。见 [API](taric-api.md#identity-and-governance-phases) 与上述治理测试。 |
| 持久默认启动、typed errors 与 framing | [runtime-startup.ts](../packages/core/src/runtime-startup.ts) 被 CLI/MCP 共用；[runtime-startup.test.mjs](../packages/core/test/runtime-startup.test.mjs) 与 [adapter-rpc.test.mjs](../packages/core/test/adapter-rpc.test.mjs) 覆盖重启、配置、脱敏和多帧/partial 请求。 |
| bounded refs / keyset / maintenance | [authority-scale.test.mjs](../packages/core/test/authority-scale.test.mjs) 核对批量查询、固定 read sequence、隔离及 operator-only 无历史修改；[基准脚本](../scripts/benchmark-authority.mjs) 分开报告 10k/50k mutation、snapshot/export 和首屏/续页成本。 |
| cursor | [cursor-key.ts](../packages/core/src/cursor-key.ts) 的版本化 0600 key 与 rotation；[persistent-cursor.test.mjs](../packages/core/test/persistent-cursor.test.mjs) 证明跨重启、多实例、篡改/绑定与无重复遗漏。 |
| Artifact | [profile/fault 实现](../packages/core/src/artifact-content-store.ts) 与 [durability tests](../packages/core/test/artifact-durability.test.mjs) 覆盖 rename/manifest/catalog/restart/reconcile。保存的 [64 MiB×2 基准](benchmarks/artifact-profile-v1.json) 中 text/binary 峰值 RSS 约 801/922 MiB、端到端 p95 约 28.6/27.9 秒、发布失败为零；主机负载会显著影响结果，不作为 mutation p95 或跨机器保证。profile 明示 process-crash-only，不声明 power-loss。 |
| PostgreSQL / quality capability | [compatibility.ts](../packages/core/src/compatibility.ts) 显式拆分 implementation/runtime/evidence/follow-up。PostgreSQL 完整持久化与 Core conformance 已验证；仅显式 multi-host 配置、匹配的执行报告和当前健康检查通过后启用。统计函数 available，真实 human annotation/baseline evidence pending。缺失质量证据不阻断实现完成，也不能由归档推导质量通过。 |

PostgreSQL 17.11 已在 OrbStack 容器部署，并通过真实 CLI/MCP 启动验证。人工质量证据仍需独立 annotator/adjudicator、版本化 dataset/strata、sample digest、时间范围与盲测 baseline；合成 fixture 只能验证算法与 fail-closed 报告行为。后续历史裁决保留变更前基线，不能当作当前未完成项。

## 先修正评审基线

原文声称覆盖 `openspec/specs/` 的 13 个规格，但当前仓库实际有 14 个规格，遗漏了 `openspec/specs/taric-runtime-api/spec.md`。这个遗漏很关键，因为该规格正好定义了 Core、CLI、MCP、Artifact 操作和 deferred operation 的运行时边界。原文关于“全部规格均已逐项核对”的表述应降级为“未覆盖完整规格集”。

原文写 `packages/core` 有 8,200+ 行；评审前基线为 6,831 行。历史验证统计应修正为 CLI 19、Core 182（181 pass / 1 live skip）、Hermes 5、MCP 8、schemas 8，共 222；这些是变更前数据，不是当前测试总数。实施后统计在上节和发布报告中单独记录。

此外，目标文档当前是未被 Git 跟踪的工作区文件，因此“分析对象为 `23c6783`”不能单独保证文档本身可复现。正式评审应同时记录源码 commit、文档版本或文档 hash。

## 总体评价

原文对 Taric 的正面判断大多有依据：SQLite `BEGIN IMMEDIATE`/savepoint 事务、事件哈希链、outbox/operation marker、固定快照、proposal 持久化、WorkRun generation fencing、ActionIntent 状态机、字段白名单投影、Artifact 有界读取和对抗性测试都是真实实现，不是仅存在于设计文档中的接口。对应证据包括 `packages/core/src/store.ts:469-600`、`:613-624`、`:1001-1098`，`packages/core/src/context.ts:116-215`，`packages/core/src/artifact-content-store.ts:138-210`，以及 Core 的 atomic-failure、governance、context、artifact、release-gates 测试。

但“规格中的核心不变量均已落地”过于绝对，且原文对 admission 的描述有一处实质性夸大：`store.admitProposal`（`store.ts:1059-1098`）执行的是 pending、policy digest、base version、`validateCanonicalRecord` 和引用校验；它不会调用 `evaluateAdmission`，也不会在普通 L1 admission 中执行 evidence/freshness/independence 的完整 policy gates。后者主要位于 `evaluateAdmission`/`promoteFinding` 的 L2 finding 晋升路径。至少 canonical identity 的 writer-owned/UUIDv7 要求、proposal 写入边界校验，以及“普通 L1 admission 已完成完整治理硬门”这一说法都应明确修正。更准确的结论是：**Taric 的单机 authority 和治理骨架已经可用，绝大多数安全边界有测试支撑，但 identity、proposal boundary、L1/L2 admission 语义、MCP 默认持久化和多主机运行时仍有产品级缺口。**

## 差距逐项裁决

| 项目 | 评审裁决 | 理由与源码证据 | 是否采纳原建议 |
|---|---|---|---|
| G1 能力注册表漂移 | **部分成立，严重度应由阻断性降为重要/可信声明卫生** | `compatibility.ts:97,101-104` 已把 Pi hooks 标为 supported，但 `docs/agent-integration.md:15` 仍写 `unsupported_capability`；同一文档还保留 PostgreSQL/quality 的已归档 follow-up。可是 `shared-authority-backend` 明确允许 single-host 将 Phase 5 标为 disabled；PostgreSQL 仍未接 Core runtime，unsupported 本身并不错误。质量统计算法已实现，但真实人工基线和样本证据没有交付，unsupported 也有合理性。真正的问题是反向漂移、follow-up 指向已归档变更、detail 没有区分“算法/存储原语已交付”和“运行时/证据尚未启用”。`release-support` 测试当前还会把每个 unsupported 必须指向 archive 的规则固化下来。 | **采纳，但改为显式 capability 状态，不按归档目录自动推导 supported。** |
| G2 canonical ID | **完全成立，且是 P0 规格违约** | `store.ts:1004` 强制 caller 提供 `content.id`，`:1007` 生成的是 proposal id；`:1078` 和 `:1094` 按 `content.id` 查找/提交 canonical。普通 `engagement.init` 也把请求 `id` 直接传给 `store.commit`（`service.ts:134-135`）。`normalizeRecord` 只禁止 trust/display，不禁止 caller ID。更严重的是普通 `recordBase` 允许一般字符串，不能据此声称 schema 已强制 UUIDv7。`engagement-memory` 与 `taric-design.md:598-601` 要求 Core writer 分配 UUIDv7。 | **采纳，但必须重新设计 create/update 语义。** |
| G3 PostgreSQL 未接运行时 | **成立，但作用域需限定为 multi-host profile** | `createCoreService` 的公共类型只接同步 `AuthorityStore`（`service.ts:39,131`）；CLI 对 PostgreSQL 只做不可用守卫（`cli.ts:35-47`），没有真实 PostgreSQL service factory。`PostgresAuthorityStore` 有 commit/CAS/snapshot/lease/backup 等存储能力，但没有 SQLite Core 所用的完整 proposals、reviews、admission、checkpoint、action、Artifact catalog 面。 | **采纳 P1-2，但不要让 PostgreSQL 重复实现 Core policy。** |
| G4 全表引用/快照加载 | **成立，是规模风险，不是当前正确性 bug** | `store.ts:586-592` 的 commit、`:1085-1087` 的 admission 每次全表加载 `object_refs`/`records`；`:618-621` 和 `:693-695` 全量加载历史版本。现有 p95 gate 只验证小数据集/约 100 条记录，不能外推到 10k/50k。 | **采纳 P1-1，但验收应区分写路径和必然 O(N) 的快照物化。** |
| G5 同步 SQLite 阻塞 | **成立，是长驻进程运行风险** | `store.ts:1` 使用 `DatabaseSync`，MCP stdio 和 adapter RPC 都是长驻 Node 进程。doctor、audit verify、snapshot/export 等 O(N) 工作会占用同一事件循环。 | **采纳，先隔离 operator 维护操作，再评估 worker/异步后端。** |
| G6 proposal 提交期校验不足 | **成立，属于 P0 规格违约，且比原文描述更严重** | `engagement-memory` 要求每个写边界校验必填字段、枚举、格式、归属、引用和状态，并在非法写时零状态变化；遗漏的 `taric-runtime-api` 还要求每个 Phase 1 operation 使用 shared validation。`submitProposal`（`store.ts:1001-1056`）只检查 id、Engagement、特权字段和基础 envelope；schema、引用、kind/subject_type 一致性在 admission 才检查。服务还会把模型 provenance 写成 `source_kind='model'`（`service.ts:189`），但 schema provenance 枚举不包含 `model`；未校验的内容会先落库，再在 admission 中被改写。极简 content 甚至可能以默认 `kind='record'` 进入 L1，不能把它只描述为“错误反馈延迟”。 | **采纳 P0-3，但拆分 envelope 校验、candidate domain 校验和可排队的证据缺口。** |
| G7 MCP 默认 `:memory:` | **完全成立，是高风险部署陷阱** | `packages/mcp/src/server.ts:38` 使用 `process.env.TARIC_DB ?? ":memory:"`，CLI 默认 `~/.taric/authority.sqlite`（`cli.ts:35-47`）。MCP 进程退出即丢失 authority，与同一 authority 的部署承诺不一致。 | **采纳 P0-4，优先复用统一启动解析器。** |
| G8 cursor 密钥/体积 | **成立，是可用性和性能风险** | `context.ts:5` 每个进程随机生成密钥；`CursorState`（`:116-124`）把完整 records 放入加密 cursor。重启或多进程无法继续旧 cursor。首次构建仍需读取快照，因此“瘦 cursor”不能单独消除首屏 O(N)。 | **采纳 P1-3，密钥持久化和 cursor 瘦身分开验收。** |
| G9 Artifact 内存/耐久性 | **风险成立，但不是规格违约** | `artifact-content-store.ts:6,143-147` 使用规格允许的 64 MiB decoded chunk，JSON/base64 解码后再同步写盘；`:161-169` 无显式 fsync。现有 marker、恢复和 `reconcile` 已覆盖很多进程崩溃场景。断电耐久性和 base64 峰值需要部署基准，不能直接写成实现不安全。 | **条件采纳 P1-4；先测量并明确耐久性策略，再决定默认 chunk/fsync。** |
| G10 adapter RPC | **成立，但当前是一请求一连接契约下的限制** | `adapter-rpc.ts:20-41` 找到首个换行后清空 buffer、处理一个请求并 `socket.end()`；同一 chunk 的后续行会丢失。Hermes 当前每次新建连接，因此现有用法未坏。 | **采纳 P2-1，先补 framing/pipeline 测试再改协议。** |
| G11 message 正则错误映射 | **成立，低严重度** | `service.ts` 的 `safe()` 对非结构化异常仍按 message 匹配 stale/lease/unavailable。消息关键字可能导致错误分类，未知异常还可能把内部 message 暴露到 API。 | **采纳 P2-2，统一带 code 的异常并对未知错误使用通用 message。** |
| G12 文档/spec 滞后 | **成立** | `taric-design.md:857` 仍写“不实现 Artifact 存储”；`authority-storage` Artifact 段落仍写 doctor 不校验 spool，但当前 Artifact store 已有 marker/reconcile；PostgreSQL 矩阵也没有表达“原语交付、runtime pending”。 | **采纳 P2-3，但用显式能力锚点同步，不做简单关键词扫描。** |
| G13 质量证据缺口 | **成立，是证据缺口而非 runtime bug** | `quality.ts` 已实现分层 precision/recall、Wilson CI、ECE、kappa 和 humanBaseline 字段；测试使用确定性 fixture，没有真实人工标注集/盲测报告。 | **采纳 P2-4，增加标注 provenance、样本和人工基线报告。** |
| G14 其他项 | **需要拆分** | snapshot/export 的全量物化属于 G4 的规模问题；DeepSeek 只支持 pinned session hooks 是 manifest 明示的 fallback，不应算实现 bug；CLI alias 双份维护是低风险卫生问题。另有一处原文未指出的入口清单重复：`cli.ts:6` 的 `cliCommands` 与 `mcp/server.ts:3-12` 的 `modelTools/toolSchemas` 由入口各自维护，并非完全从 `registry.ts` 生成。 | **保留 G4 衍生项；补充入口清单一致性测试，低风险 alias/registry 清理可后置。** |
| 新增治理核对项 | **需要单独确认，可能是 P0** | `memory-governance` 要求 machine-reviewed candidate 在提交 canonical 前重验 schema、references、scope、base version、state transition、provenance 和 policy。当前公开的 `admission.evaluate` 路由进入 `store.admitProposal`，该方法没有调用 `evaluateAdmission`，也不要求 review；完整 evidence/freshness/independence hard gates 主要在 `evaluateAdmission/promoteFinding`，而 `promoteFinding` 没有对应的 CoreService/registry/CLI/MCP promotion 路由。如果 L1 admission 的设计就是“结构准入”、L2 才是 policy promotion，应修正文档和规格术语；如果它承担 machine-reviewed candidate admission，则当前运行时路径不完整。 | **采纳为 P0 规格/路由澄清项；不要在没有明确语义前扩大亮点结论。** |

原文第 3.2 节还应把“L1 基础准入”和“L2 finding 晋升”分开写。当前测试确实覆盖 proposal/review、L2 promotion 和 policy hard gates，但不能据此断言每个 `admitProposal` 都执行了完整的 scope/evidence/freshness/independence 重算；这会影响对 `memory-governance` 的符合度评级，也应成为单独的 P0 治理核对项。第 3.7 节的“CLI、MCP 全部从同一注册表生成、没有第二套策略实现”也应收窄为“Core 策略集中，入口白名单仍有重复维护”。

## 对优化方案的采纳决定

### P0-1：采纳目标，否决“从 Markdown 自动生成 manifest”的实现方式

规格名称、归档状态和 capability id 不是一一对应关系，直接解析 Markdown 很容易把“存储原语已实现”“运行时 enabled”“证据已达标”误判为同一状态。建议保留显式 capability metadata，增加一致性检查：每个 capability 记录 `implementation_state`、`runtime_state`、`evidence_state` 和 `follow_up`，禁止 follow-up 指向已归档且未说明剩余工作的 change。同步修改 `release-support.test.mjs`/schemas registry 测试，避免“所有 unsupported 必须有 archive follow-up”继续掩盖状态漂移。PostgreSQL 可保持 `unsupported/disabled`，但 detail 应写清 runtime integration pending；质量评估可保持 unsupported/evidence-pending，而不是因为统计函数存在就改成 supported。

### P0-2：采纳方向，重写数据模型

不能简单把 admission 时的 `content.id` 换成 `uuidv7()`。当前同一个字段同时承担“新建实体 ID”和“更新目标查找”，还参与 `base_version` 比较。建议明确：新建 proposal 不接受 canonical `id`，由 Core 在 proposal/candidate 建立时或 admission 时分配 UUIDv7；更新 proposal 使用独立的 `target_id`/`subject_ref`，由 Core 校验 Engagement、kind 和 expected version；`proposal_id`/`client_request_id` 放在 proposal envelope 中，`source_ref` 只有在它确实是既有 authority object 引用时才使用，不能把任意请求号塞进 `source_ref`（该字段会参与引用校验）。同步更新 schema、README、snapshot/import 和全部更新测试。

### P0-3：采纳，但不要把所有证据缺失都变成提交失败

提交边界至少应验证 proposal envelope、subject type、candidate kind、schema version、Engagement、特权字段、provenance 枚举和字段格式；非法 domain candidate 应返回结构化 `validation_error` 且不落库。合法但引用尚未产生、需要后续审核或证据补齐的 proposal 仍可作为 pending/quarantine 保存，但状态和审计语义必须显式定义。admission 必须再次做完整校验，防止提交后发生撤回或 TOCTOU，并明确 L1 admission 是否需要完整 policy gates。需要新增测试证明：`subject_type` 与 `kind` 不一致不能被默认成 generic `record` 并准入；当前最小复现实验中，仅含 `id` 和 `engagement_id` 的 content 就能以 `subject_type=claim` 成功写入 L1 generic `record`。

### P0-4：采纳，优先统一 authority 解析

不要在 MCP 中复制一份路径逻辑。抽取 CLI/MCP 共用的 authority resolver，默认使用同一持久路径，或在缺少显式配置时 fail closed 并给出启动诊断。若选择磁盘默认值，要同时处理目录权限、测试隔离、进程并发和 `TARIC_CONTENT_ROOT`；initialize 响应不应泄漏任意本地路径，诊断可写 stderr。

### P1-1：采纳并收窄验收承诺

引用校验应按引用集合批量查询，补齐 SQLite 的 `object_refs(engagement_id)`、`records(engagement_id, kind)` 和 `record_versions(engagement_id, commit_seq)` 索引。`list` 可改为 keyset 分页。snapshot/export 仍需要输出一个固定快照，不能承诺完全与库大小无关；验收应分别量化 commit/admission p95、context p95、snapshot/export 内存和耗时，并以 10k/50k fixture 建立基线。

### P1-2：采纳，但按“后端适配层”实施

shared-authority 规格要求 PostgreSQL 与 SQLite 的外部 storage semantics 一致，并不要求 PostgreSQL 复制 Core 的治理代码。应先抽象同步/异步 `AuthorityBackend` 或 service facade，把 Core 的 proposal/review/admission/checkpoint/action/artifact 逻辑保留在一处；再补齐 PostgreSQL 所需的持久化原语和 conformance suite。multi-host profile 健康检查通过后才接线，失败必须 blocked，不能回落 SQLite。完成前 capability 必须明确为“backend primitives available, runtime profile disabled”。

### P1-3：采纳

cursor key 应绑定 authority/content root 的 0600 keyfile，并带版本和轮换策略；cursor 改为 snapshot/read sequence/filter/offset/delivered ids，续页时从固定 as-of source 重建。测试需覆盖重启、多进程、篡改、跨 principal 和无重复/遗漏；首次快照的大数据成本另列基准。

### P1-4：条件采纳

64 MiB 是当前契约上限，不应未经基准就降低。应先测量并发上传时 base64 字符串、Buffer 和文件写入的峰值，再决定默认 chunk。fsync 是断电耐久性选项，需定义部署 profile、代价和恢复语义；marker/reconcile 已存在，新增测试应覆盖 rename 前后和持久化失败，而不是把现有恢复能力描述为缺失。

### P1-5：分阶段采纳

先把 doctor、verify、reconcile、snapshot export 作为 operator-only 维护操作，并建议单次 CLI/独立子进程执行；只有量化证明长驻进程受影响后，才引入 worker thread 或异步数据库。worker 化不能绕过 SQLite 写锁，必须使用独立连接并保留单写者事务语义。

### P2-1 至 P2-4：总体采纳，实施细节需收敛

RPC 先修复分帧和多行处理，再决定长连接协议；错误处理去掉 message 推断并隐藏未知内部 message；文档同步依赖 capability anchors 和人工复核；质量证据除了 fixture 还要包含标注者、数据集、版本和 digest，避免“把调用方传入的 humanBaseline 字段”误当成真实基线。

## 建议的执行顺序

1. **立即修正评审和能力声明**：补上 `taric-runtime-api`，修正行数/测试统计，重写 G1/G3/G13 的状态描述，更新过期 Artifact/authority 文档。
2. **下一版本前完成 P0**：canonical identity 数据模型、proposal envelope/domain 校验、L1/L2 admission 语义与路由、MCP/CLI authority resolver。它们分别影响规格正确性、错误数据进入 canonical 的可能性、治理硬门是否真正生效和部署数据持久性。
3. **扩大数据规模前完成 P1-1/P1-3**：索引化引用校验、cursor 持久密钥和规模基准。
4. **启用 multi-host 或 100 GiB Artifact 场景前完成 P1-2/P1-4/P1-5**：后端 conformance、Artifact 耐久性/内存基准和长驻进程维护隔离。
5. **持续完成 P2**：RPC framing、结构化错误、文档锚点和真实质量证据。

最终应采纳的判断不是“原分析全部正确”或“全部推测”，而是：**源码证据足以支持大部分差距，但原文对规格覆盖范围、G1 严重度、G2 ID 格式、G6 提交语义、G9 风险边界和若干 P0/P1 实施方式需要修订后，才能作为正式 roadmap 或发布决策依据。**
