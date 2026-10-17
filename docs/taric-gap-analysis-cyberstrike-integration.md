# Taric 差距分析与改进优化建议

> 基于 CyberStrike 集成必要性推演 · 从「被需要」到「值得被需要」

- 分析日期：2026-10-16
- 分析对象：Taric 工作区源码（`packages/core/src` 10,158 行；schema 64 `$defs`；operation registry 50 项）
- 推演宿主：[CyberStrike](https://github.com/CyberStrikeus/CyberStrike)（`main`，Bun monorepo，opencode fork，自主渗透测试 agent）
- 分析方式：宿主侧源码逐项走读（agent 循环、会话/上下文、工具系统、记忆与覆盖模块约 30 个文件）+ 与 Taric 集成方案逐节对照 + 集成必要性推演
- 配套阅读：[代码设计](taric-code-design.md)、[集成方案](Taric面向渗透测试智能体的集成方案.md)、[BreachWeave 差距分析](taric-gap-analysis-breachweave-integration.md)、[能力改进提案](taric-capability-improvement-proposal.md)

**方法论说明**：本文档与 [BreachWeave 差距分析](taric-gap-analysis-breachweave-integration.md) 是**对照组**，不是重复。两者推演的是同一问题的两个不同阶段：

| | BreachWeave 推演 | CyberStrike 推演（本文档） |
|---|---|---|
| 宿主特征 | 架构上**天然需要** Taric（多 agent、共享记忆、旁路监督） | 架构上**已自建约 60% 重叠能力**，且哲学取向相反 |
| 撞上的墙 | 跑不起来、认不出、进不去、接不上 | **答不出「接进来之后我得到什么」** |
| 差距性质 | 采用机制（adoption mechanics） | 价值主张与定位（positioning & value articulation） |
| 结论 | 一个有意愿的宿主走不通 | 一个**走通了也未必该走**的宿主 |

BreachWeave 回答「能不能接」。CyberStrike 回答「**该不该接**」——后者是更严苛的测试，因为它把 Taric 从「缺它不行」的舒适区，推到「有它更好吗」的竞争区。本文档的差距全部来自这个对照。

---

## 能力提升后的状态校正（2026-10-18）

本文保留 2026-10-16 的推演、代码基线、行号与建议，正文中的“当前”“未实现”仅指当时状态。以下表格是本轮实施后的裁决；实际接入以[接入指南](agent-integration.md)、[API 合同](taric-api.md)和[验收记录](../openspec/changes/archive/2026-10-18-taric-capability-improvement/release-report.md)为准。未重新运行或认证第三方宿主，也未重新核验文中外部项目或 MCP 工作组状态。

| 原差距 | 当前结果与边界 |
|---|---|
| 缺少采用梯度与适用条件 | A～E 闭环、宿主职责、适用/不适用条件及成本模板已写入接入文档。 |
| 缺少宿主代理 | taric proxy 与真实 Bun/Node 重启实测已交付；仍需宿主提供可信捕获和独立审核通道。 |
| 条件 fence 可由省略字段绕过 | 持久 host-session/run-bound 模式及 transport session 已实现；run-bound 不能通过省略请求字段降级，host-session 不承诺 lease 保证。 |
| 无交互时延测量 | Context、proxy、Artifact、维护和 host.state 已有版本化实测；50k Context 首屏降低 42.5%，未达 50% 候选目标，无通用 SLA。 |
| 价值与质量未量化 | 人工标注/基线样本数仍为 0，质量发布 blocked；无 ROI、等效安全比例或第三方宿主认证结论。 |

综合[技术验收](benchmarks/capability-verification-v2.json)339 项测试全部通过；PostgreSQL 12 个 live 场景通过。质量证据 pending、`release_state=blocked`。这里的实施完成不代表正文所有建议被采用，未交付方向不因归档而启用。

## 目录

1. [总体结论](#1-总体结论)
2. [推演基线与验证记录](#2-推演基线与验证记录)
3. [从必要性推演中提炼的定位问题](#3-从必要性推演中提炼的定位问题)
4. [差距分析](#4-差距分析)
5. [改进优化建议方案](#5-改进优化建议方案)
6. [应坚持的不变量](#6-应坚持的不变量)
7. [附录：证据索引](#7-附录证据索引)

---

## 1. 总体结论

**Taric 已经证明了「它能守住记忆」，但还没有证明「它是接入记忆的最优解」。**

BreachWeave 推演暴露的是接入门槛。CyberStrike 推演暴露的是**门槛之内的东西**：一个功能上高度重叠的成熟宿主，在认真评估后得出的结论是——「必要性成立的部分是具体的、分片的；不成立的部分是整体的、哲学的」。

推演产出了三条结论，分别指向三类不同的差距：

**结论一：Taric 的核心价值主张（防漏报/防误报/防错乱）在这类宿主上已被更轻的机制部分覆盖。**

CyberStrike 独立实现了：append-only 覆盖笔记（`CoverageNote`，含 wide/local 分层与自动注入防重复测试）、每凭证观察累积（`RequestObservation`，唯一索引幂等）、执行类漏洞无证据自动降级（`candidate` 门控）、triage 生命周期（`new/approved/duplicate`）、测试者 lane 约束（`vuln-scope` 结构化防越界）、方法论阶段门与验证闸。这些不是玩具——它们在一个真实产品的生产路径上运行。

**这意味着 Taric 必须回答一个 BreachWeave 从未提出的问题：当宿主的自建方案已经「够用」时，你的边际价值到底在哪一格？** 当前文档没有回答。整个集成方案（§3「结构性风险防护」共 3 页）是在论证 Taric 的机制**完整**，而不是论证相对替代方案的**增量**。

**结论二：真正无争议的缺口只有三个，但它们在 Taric 的叙事里是配角。**

CyberStrike 存在三处结构性缺口，小改造补不上，且恰是 Taric 强项：

| 缺口 | CyberStrike 现状 | Taric 对应资产 | 在 Taric 文档中的位置 |
|---|---|---|---|
| **跨会话记忆** | 全部 intel/coverage/vulnerability 以 `session_id` 作用域；`Memory` 是纯文本文件 + 行搜索，且**不自动注入** | Engagement 权威层 + Context Pack | 未单独提出；散见于「权威层」叙述 |
| **可恢复边界** | 仅靠 compaction 摘要（五段 Markdown 模板）恢复，无 checkpoint、无前提校验 | `Checkpoint` + `resume delta` + `premise_checks` | 集成方案 §6.5，2 页 |
| **证据链可审计** | `Vulnerability` 与原始请求的关联是 `message_id` + 模型手写的 `poc` 字符串；无哈希、无版本钉住 | `Artifact spool` + 哈希链审计 + `Evidence` 钉 id+version | 集成方案 §5、8；代码设计 §5 全章 |

**这三项才是 Taric 对这类宿主的真实卖点。** 但它们被埋在「完整治理栈」的叙事之下，且文档从未说明它们可以**单独采用**。

**结论三：Taric 的治理哲学对这类宿主是一笔税，而文档从未承认。**

`零模型直写` 是 Taric 的皇冠（集成方案 §3.3，代码设计 §10.1）。但对一个全部价值在于「agent 自己动手、越快越好」的产品，把 `report_vulnerability` 从一次直接 `db.insert` 改为「提案 → 准入 → 独立复核」是**净成本**。CyberStrike 的 `candidate` 门控已经用「同一次 LLM 调用内的自检」换取了 70% 的等效保护，代价接近零。

文档把零模型直写呈现为无歧义的正确。**它确实正确——但不免费。** 一份诚实的差距分析必须说出这条权衡，否则宿主会在集成到一半时才发现自己在为一个自己不需要的保证付费。

**差距总览**（按「阻断价值实现」的严重程度排序，非按技术难度）：

| 层面 | 差距性质 | 优先级 |
|---|---|---|
| **价值主张** | 文档论证「机制完整」而非「相对替代方案的增量」；无 ROI/对比框架；三处真实缺口未提升为独立产品叙事 | P0 |
| **采用梯度** | 无「单 agent / 单会话 / 单写者」的降级姿势；无能力分层图证明可摘取子集；fence 文档与实现不一致放大了感知成本 | P0 |
| **接入成本结构** | 「宿主」被假定为已存在，但成熟宿主往往**没有**非 LLM 执行层——集成等于新造一个权威层 | P1 |
| **反驳证据** | 无「什么情况下不该用 Taric」的说明；无哲学冲突的显式承认 | P1 |
| **反馈时延** | p95 ≤2s 是发布门槛，但不是交互预算；agent 同步写路径无「快车道」指标 | P2 |

---

## 2. 推演基线与验证记录

### 2.1 推演宿主画像

CyberStrike 是一个**面向攻击性安全的自主 AI 智能体**（README 自述：「首个专为攻击性安全打造的开源 AI 智能体」），opencode 的 fork，Bun monorepo。

| 维度 | 实现 |
|---|---|
| **架构血统** | `packages/cyberstrike` 是 opencode 的 fork，保留 session/loop/processor 三层与 `@gitlab/opencode-gitlab-auth` 等上游依赖 |
| **Agent 体系** | 1 个 primary（`cyberstrike`）+ 4 个领域专家（web/mobile/cloud/internal-network）+ 9 个 OWASP 类目测试者（`proxy-tester-{idor,authz,injection,authn,...}`）+ 4 个内部 hidden agent（compaction/title/summary/normalize） |
| **多 agent 形态** | `task` 工具创建子会话（`SessionTable.parent_id`），递归进入同一 `SessionPrompt.loop`；子会话是普通 session，文本结果经 `<task_result>` 返回 |
| **状态存储** | 单一 SQLite（`~/.local/share/cyberstrike/cyberstrike.db`，bun:sqlite + drizzle，WAL）；session/message/part + 领域表（vulnerability、coverage_note、request_observation、intel_entry、web_* 系列） |
| **上下文管理** | 三层：`isOverflow` → 自动 compaction（专用 hidden agent + 固定 Markdown 模板）；`filterCompacted` 裁掉摘要前历史；`prune()` 擦除 40k 保护窗口外的旧工具输出 |
| **长期记忆** | `.cyberstrike/MEMORY.md` + `.cyberstrike/memory/YYYY-MM-DD.md`；`memory_search/write/read/context` 四工具。**纯文本行搜索，不自动注入** |
| **并发模型** | session 级串行（`IngestQueue` 是 Promise chain）；subagent 可并行但受 agent 池约束 |
| **渗透专用层** | methodology engine（阶段机 + VRT 覆盖 + 攻击链检测 + agent 战绩）、http_replay 引擎（结构化/原始字节双后端 + AIMD 限流 + 熔断）、hackbrowser 自主爬虫、Bolt 远程 Kali、10 类后渗透 hook 工具、skill 系统 |

**与 Taric 目标画像的匹配度**：**高，但性质与 BreachWeave 不同。** BreachWeave 匹配的是「多 agent 共享记忆」这个**功能需求**；CyberStrike 匹配的是**同一个需求**，但它已经用一套自研的、更轻的、哲学相反的方式满足了需求的大部分。

### 2.2 重叠度实测

下表是本次推演的核心工作：逐项核对 Taric 的黑板分区（集成方案 §5.1）与 CyberStrike 的实际实现。

| Taric 能力 | CyberStrike 对应实现 | 证据 | 判断 |
|---|---|---|---|
| CoverageCell 覆盖矩阵 | `CoverageNote`（append-only，wide/local 分层，`wideBlock()` 自动注入，`INJECT_LIMIT=10`）+ VRT checklist + `Intel.computeCoverage` | `session/coverage-note.ts:1-198` | **重叠**（CyberStrike 维度更简单：asset × class × scope；无 identity/operation/condition 正交分解） |
| Observation / 阴性结果 | `RequestObservation`（`(session, key_hash, credential, value_hash)` 唯一索引，ON CONFLICT DO NOTHING，append-only 幂等） | `session/observation.ts:33-71` | **重叠**（缺「阴性结果有界保存」的显式语义与 limitations 字段） |
| Finding 治理链 | `Vulnerability.candidate` 门控（执行类漏洞无 `execution_evidence` 强制降级 ≤medium，可原地升级）+ triage 生命周期 + `vuln-scope` lane 约束 | `session/vulnerability.ts:12-19,76-127`；`tool/vuln-scope.ts:1-40` | **部分重叠**（同调用内自检 vs 独立 reviewer；防线强度不同，但都不是裸奔） |
| 任务追踪 | `Todo`（自动裁剪已完成）+ `Chain`（攻击链检测/持久化）+ methodology phase 机 | `session/todo.ts`；`methodology/chain.ts` | **弱重叠**（无跨会话、无依赖、无租约） |
| 证据原文存储 | `RequestTable.raw_request` 存原始请求字节 + 工具输出落盘（`tool/truncation.ts:10-11`，2000 行/50KB 上限） | `session/session.sql.ts:127-192` | **部分重叠**（有字节，无哈希、无完整性状态、无版本钉住、无发布标记） |
| 上下文供给 | compaction + prune + `MethodologyContext.generate()` 每轮注入系统提示 | `session/compaction.ts:32-101`；`methodology/context.ts:29-120` | **机制不同**（对话驱动 vs 状态驱动） |
| 循环防呆 | `stuck-detector` + `repeat-detector` + doom_loop 权限（连续 3 次同工具同参数触发） | `session/stuck/*`；`session/processor.ts:153-177` | **机械重叠**（机械检测 vs observer 语义纠偏） |
| 证据硬门 | 验证闸（`validateEvidenceQuality`、`runTriagerChecks`、`per_asset_coverage` 60% 阻塞阈值） | `methodology/validation.ts:278-345` | **部分重叠**（阻断的是报告发布，不是记录写入） |

**实测结论**：在 8 个可比维度上，CyberStrike 有 3 项实质重叠、4 项部分重叠、1 项机制不同但目标一致。**按覆盖面计约 60% 重叠。**

### 2.3 关键设计取向对照

重叠度只是表层。更深层的差异是**取向**，它决定了集成是「补强」还是「对冲」：

| 维度 | Taric | CyberStrike | 冲突程度 |
|---|---|---|---|
| 记忆写入者 | 仅宿主（非 LLM）；模型只有提案权 | Agent 直接 `db.insert` | **正面冲突** |
| 判断归属 | 非 LLM 策略引擎重算硬门 | 「RAW process memory — judgment stays with the agents」（`coverage-note.ts:20` 原文注释） | **正面冲突** |
| 事实分级 | L0/L1/L2 三层，L0/L1 默认不进召回 | 单层 + `candidate` 标记降级 | 取向不同 |
| 上下文来源 | 状态驱动（Context Pack + 预算 + 白名单） | 对话驱动（compaction + prune） | 取向不同 |
| 恢复依据 | Checkpoint + resume delta + premise check | 摘要文本（五段模板） | Taric 显著更强 |
| 记忆范围 | Engagement（跨会话、可跨机） | Session（`Session.root()` 只归并到根会话） | **Taric 显著更强** |
| 证据完整性 | 哈希链 + 发布标记 + 完整性状态 | 无 | **Taric 显著更强** |
| 交互时延预期 | proposal→query p95 ≤2s 为发布门槛 | 工具调用内联在 agent 循环，需亚秒级 | 无指标可依 |

**这张表是本次推演最重要的产出。** 它说明：Taric 相对 CyberStrike 的优势**不是全面的**，而是集中在右三行（恢复、范围、完整性）；在左三行（写入者、判断归属、事实分级），Taric 的设计对这类宿主是**负债而非资产**。

### 2.4 事实校正声明

本文档区分「实测」与「推断」：

- **实测**：CyberStrike 的代码事实，全部附文件行号（见 §7.2）。
- **实测**：Taric 的代码事实，附文件行号（见 §7.1）。
- **推断**：必要性分级（§3）、优先级排序（§4、§5）。这些是基于两侧事实的判断，非代码可验证。
- **一项实测到的不一致**：集成方案 §6.3 与 §8.1 均声明「Artifact 上传**必须**带 run fence（`work_run_id + attempt_id + generation` 三要素齐备）」，但实现为**条件可选**——`artifact-content-store.ts:422-425` 的 `assertFence` 在三要素**全不提供**时直接返回通过。详见 §4.4。

---

## 3. 从必要性推演中提炼的定位问题

本章是本文档的独特价值：**BreachWeave 推演无法发现的差距。** 它的前提是宿主「天然需要」Taric，因此永远不会质问价值主张本身。CyberStrike 推演把这个前提拿掉了。

### 3.1 Taric 在论证「完整」，市场在问「增量」

集成方案 §3「Taric 结构性风险防护（核心亮点）」用三张表、23 个机制论证 Taric 如何消除四类失效。代码设计 §1.2「关键能力」列出 9 条。

**这两节回答的问题是「Taric 做了什么」，不是「相对宿主已有的东西，Taric 多做了什么」。**

推演佐证：评估「只值得为跨会话记忆付费」时，无法从任何文档确认——如果只采用权威层 + Context Pack，而不采用治理链、Artifact、WorkRun，这套组合是否自洽？跳过 Part 2–3 直接读 Part 1、8、9 是否构成一个完整能力？**文档结构不支持这样的阅读路径。**

### 3.2 三处真实缺口在叙事里是配角

§2.2 的实测把 Taric 的价值切成了两块：

```
┌─────────────────────────────────────────────────────────┐
│  CyberStrike 已自建（Taric 增量小）                       │
│  覆盖笔记 · 观察累积 · candidate 降级 · triage ·          │
│  方法论阶段门 · 循环防呆 · lane 约束                      │
├─────────────────────────────────────────────────────────┤
│  CyberStrike 缺且补不动（Taric 增量大）  ← 真正的卖点      │
│  跨会话记忆 · checkpoint/resume · 证据链可审计            │
└─────────────────────────────────────────────────────────┘
```

**但在 Taric 的文档里，下半部分的内容量远小于上半部分**：

- 跨会话记忆：**没有独立章节**。它作为「权威层持久保存」的附带效果被提及（集成方案 §3.1）。
- checkpoint/resume：集成方案 §6.5「中断恢复流程」，约 20 行；代码设计 §4.5 的一段。
- 证据链：有分量（集成方案 §5、§8，代码设计 §5 全章），但定位是「Artifact 存储集成」，而非「让报告可被审计」。

对照上半部分：治理链（§3.3、§4.2、代码设计 §4.2）、五硬门、L0/L1/L2 分级——占据了文档的主要篇幅。

**结果是：Taric 把最多的篇幅给了增量最小的部分，把最少的篇幅给了增量最大的部分。**

### 3.3 零模型直写的隐性成本从未披露

推演中出现了 Taric 文档从未设想的反对意见：

> 对一个全部价值在于「agent 自己动手、越快越好」的产品，把写路径从直接落库改为提案制是净成本。

CyberStrike 的 `report_vulnerability` 在同一次工具调用内完成校验、降级、写入、返回（`tool/vulnerability.ts:78-160`），零往返。改为 Taric 路径后，同一语义需要：`proposal.submit` → 宿主 `admission.evaluate` → （高风险）`review.submit` → `admission.promote_l2`。**四次跨进程调用，且其中两次是 host-only，要求宿主新造一层。**

Taric 的辩护是充分的：「误报的代价被限制为消耗复核时间，而不是污染记忆」（集成方案 §10.2.3）。**但这个辩护成立的前提是「污染记忆的代价 > 复核的代价」。** 对 CyberStrike 而言，记忆是 session 作用域的、会随会话终结的，污染半径小得多——**辩护的前提不成立**。

**差距不在设计，在披露。** 文档需要一条这样的说明：

> 零模型直写的收益与宿主的记忆半径成正比。单会话、一次性评估的宿主，收益低而成本不变。

### 3.4 没有「不该用 Taric」的场景说明

一份可被信任的技术方案应当写明边界条件。Taric 文档有 §12「边界与注意事项」（11 条）与代码设计 §13「已知差距与假设」，但**全部是「Taric 不做什么」，没有一条是「什么时候你不该接 Taric」**。

对比：集成方案 §10.4 列出「宿主工程前提清单」8 项，措辞是「能力达成的组成部分」——即「不满足就用不好」。但缺一个更前置的判断：**「不满足的话，你也许根本不需要 Taric」。**

这个缺失有实际代价。CyberStrike 推演的结论是「单人单机、短周期、一次性评估」场景下必要性为**低**。如果 Taric 文档能自己说出这句话，会带来两个好处：

1. **可信度**：愿意承认不适用场景的方案，其适用场景的论断才值得信。
2. **资源聚焦**：把 P1 场景（团队/多机/长周期/合规交付）的宿主作为首要目标，避免在 P0 场景上消耗接入支持成本。

---

## 4. 差距分析

### 4.1 P0-1：价值主张未量化，且无对比框架

**事实**

此前的实现分析材料围绕质量：机制是否正确、是否有测试、能否被接入。当前可查阅的 [能力改进提案](taric-capability-improvement-proposal.md) 和 [BreachWeave 差距分析](taric-gap-analysis-breachweave-integration.md) 保留了这些问题的后续裁决与接入视角。

**没有一份是价值导向的**：相比宿主自建，Taric 省下了什么、多付出了什么。

**为什么是 P0**

BreachWeave 的结论是「一个有意愿的宿主走不通」，解法是降低接入门槛。CyberStrike 的结论推翻了前提：**降低门槛不解决「门槛之内是否值得」**。一个能顺利接入但算不过账的宿主，会在 POC 阶段消耗 Taric 团队的接入支持，然后在决策阶段否决——**比接不进来更贵**。

**具体缺什么**

| 缺项 | 说明 |
|---|---|
| 增量对照表 | 按能力列出「宿主自建成本 vs 集成 Taric 成本」，而不是只列 Taric 的机制 |
| 最小可摘取子集 | 明确哪些能力可单独采用、哪些成组依赖（§4.2） |
| 不适用场景 | 明确「什么时候不建议接」（§3.4） |
| 归属划分 | 哪些是 Taric 的工程，哪些转移给宿主（集成方案 §10.4 有 8 项前提，但没有汇总成「宿主侧工作量估算」） |

### 4.2 P0-2：无能力分层图，无「单 agent / 单写者」降级姿势

**事实**

Taric 的目标形态是**多 agent、多 worker、可多主机**。集成方案 §2 的架构图有 Planner + Executor×N + Observer + 宿主运行时；§7「并发执行与冲突控制」整章；§6.3 的完整执行流程包含 claim/lease/generation/checkpoint/action 三模式。

**但 CyberStrike 的主导场景是：一个 agent、一个会话、一个写者。** 推演中发现，判断「能否只取跨会话记忆」时必须自行推导最小集合，且**无法从文档确认该集合是否自洽**（这与 BreachWeave 差距分析 §4.3 的发现一致，但 CyberStrike 的诉求更基础——它连治理链都不想要）。

**代码层已部分支持，但文档不支持**

推演发现，Taric 的实现比文档**更灵活**：

| 机制 | 文档表述 | 实现实际 |
|---|---|---|
| Artifact 写入的 run fence | 集成方案 §6.3/§8.1：「必须带 run fence，三要素齐备」 | `artifact-content-store.ts:422-425`：**全不提供则直接放行**；提供任一则要求齐备 |
| `capture.observation` 的 WorkRun 绑定 | 集成方案 §6.3 流程图中 `work_run_id` 与 `generation` 并列为参数 | `service.ts:546-547`：`work_run_id` / `generation` 均为**可选** |
| Coverage/Evidence 与 WorkRun 的耦合 | 黑板分区表（§5.1）把覆盖状态区、恢复区与任务执行区并列 | `coverage.ts:12-19`：`CoverageCell` 不含任何 WorkRun 字段 |

**即：单写者、无租约的降级姿势在实现上是可行的，但文档从未这样说。** 这直接放大了感知接入成本——CyberStrike 若从文档判断，会认为必须先实现 WorkRun/lease/fencing/generation 才能获得证据存储，因而放弃。

**「文档高估了耦合」是一个独立于「代码是否该改」的差距。**

### 4.3 P1-1：把「宿主」当作既有资源，但成熟宿主往往没有它

**事实**

Taric 的全部设计建立在「非 LLM 宿主运行时」这一角色上（集成方案 §2.1 架构图、§4.1 principal 分配表中的 `pentest-host`、§6.3 中 host 代写观察与落盘）。

代码设计 §13 与集成方案 §12.7 都承认自研宿主可内嵌 Core。**但没有任何文档讨论「宿主还没有这一层」的情况。**

**推演佐证（本次最实质的发现之一）**

CyberStrike **没有**非 LLM 权威执行层——agent 直接调工具、直接写库。要接入 Taric，宿主必须在以下三条路径中选一：

| 路径 | 代价 |
|---|---|
| 在 CyberStrike 内新造非 LLM 权威执行层 | 架构级重构：改造全部写路径（vulnerability、coverage-note、observation、intel 等），并新造调度/复核组件 |
| 把核心工具改为经 Taric 提案 | 破坏产品的自主性主张；每次写多 2–4 次跨进程往返 |
| 只用 Taric 的非 host-only 能力 | 排除 Artifact、capture.observation、work.*、checkpoint.commit、action.* ——**恰好是 §3.2 认定增量最大的部分** |

**第三条路径的排除关系是关键**：Taric 增量最大的三处（跨会话记忆 / checkpoint / 证据链），其中两处（checkpoint、证据链）依赖 host-only 操作。**这意味着「低改动集成」与「高价值集成」在当前设计下是互斥的。**

**为什么是 P1 而非 P0**：这是宿主的成本，不是 Taric 的缺陷。但 Taric 应提供「宿主代理层」的参考实现（BreachWeave 差距分析 §6.5 已提出，本文档强化其必要性）——**因为对 CyberStrike 这类宿主，这一层不是可选的便利，而是集成的前置条件。**

### 4.4 P1-2：fence 语义的文档/实现不一致

**事实（实测）**

`packages/core/src/artifact-content-store.ts:422-425`：

```ts
private async assertFence(input: ArtifactBeginInput, principal: string): Promise<void> {
  const hasAny = Boolean(input.work_run_id || input.attempt_id || input.generation !== undefined);
  if (!hasAny) return;   // ← 三要素全缺 → 直接通过
  if (!input.work_run_id || !input.attempt_id || !Number.isSafeInteger(input.generation) || input.generation! < 1)
    fail("validation_error", "run-scoped Artifact writes require WorkRun, Attempt, and generation");
  ...
}
```

这是**条件校验**：三要素全不提供 → 放行；提供任意一个 → 要求全部齐备且租约有效。

文档表述为**强制**：

- 集成方案 §6.3：「**Artifact 上传必须带 run fence**：`work_run_id + attempt_id + generation` 三要素齐备，Taric 在 authority 事务中验证租约；被 reclaim 的旧代数上传被拒绝」
- 集成方案 §8.1：「每个写入声明当前 `work_run_id + attempt_id + generation`（run 作用域三要素）」

**两种解读，需 Taric 自行裁定**：

1. **实现比设计更宽松**（fence 本应强制，条件校验是缺陷）→ 需要修，因为无 fence 的写入不受 generation fencing 保护，reclaim 后的迟到写入不会被拒。
2. **设计有意允许无 fence 写入**（单写者场景不需要）→ 需要改文档，因为当前表述会让读者认为必须先有 WorkRun。

**无论哪种解读，都是一处需要消解的不一致。** 若是解读 2，修文档的收益远超成本：它直接解开 §4.2 的「感知耦合」。

### 4.5 P2-1：无交互时延预算（「快车道」指标缺失）

**事实**

代码设计 §11.1 与 §12 发布门槛定义 `proposal/CAS→查询可见 p95 ≤2s`。这是**一致性目标**（保证写后立即可见），不是**交互预算**。

**但 CyberStrike 的工具调用是内联在 agent 循环里的。** 一个 `proxy-tester-*` agent 的 `steps` 上限是 60（`agent/agent.ts:903`）。若每次写路径引入 2s，单次测试会话增加 120s。

**推演佐证**：评估「写路径能否承载 agent 同步调用」时，无任何指标可依。p95 ≤2s 读起来像是「够快」，但对一个在循环内同步等待的调用方，它可能是 60 倍的成本放大。

**这不是要求 Taric 变快**，而是要求区分两类调用方并分别给出指标：

| 调用方 | 语义 | 需要的指标 |
|---|---|---|
| 宿主（异步、可批量、可后台） | `admission.promote_l2`、`audit.doctor`、`snapshot.export` | p95 与吞吐（现状已有） |
| agent（同步、内联、用户可感知） | `proposal.submit`、`context.query`、`capture.observation` | **首字节/p50/<100ms 级响应**，或明确说明「此类调用不适用于同步路径」 |

### 4.6 差距不包含的内容（避免过度归因）

以下**不是** Taric 的差距，不应被要求解决：

| 宿主问题 | Taric 是否应解决 | 依据 |
|---|---|---|
| agent 调度、并发池、无冲突判定 | **否** | 集成方案 §12.1：Taric 不是执行器 |
| 目标资源全局互斥/限速 | **否**（仅部分） | 集成方案 §7.3：任务唯一租约 ≠ 目标资源锁 |
| 资产发现完备性 | **否** | 集成方案 §10.2.2 残余缺口 1 |
| 自动摘要、资源摘要沉淀 | **否** | 集成方案 §10.2.1 残余缺口 3 |
| 内容脱敏、凭据生命周期、保留期限 | **否**（永久非目标） | 集成方案 §5.8；`compatibility.ts` `TARIC_NON_GOALS` |
| CyberStrike 的 `session_id` 作用域设计 | **否** | 宿主自身架构选择 |
| CyberStrike 的记忆依赖模型主动调用 | **否** | 宿主实现缺陷，非 Taric 责任 |

同时应诚实指出：**本文档不主张 Taric 降低准入标准。** §4.1–4.5 的全部差距都在「表达与路径」层面，不涉及治理链、硬门、隔离语义的任何放宽。这一点在 §6 重申。

---

## 5. 改进优化建议方案

### 5.1 优先级重排

BreachWeave 分析给出了「可移植运行时 > 开放宿主契约 > 事件/订阅 > 冷启动 > 传输 > 模块化」。本文档**不推翻该排序**，但提出一个前置项：

```text
新序：价值主张与采用梯度（P0） > 可移植运行时（P0） > 开放宿主契约（P0）
      > 事件/订阅（P1） > 宿主代理参考实现（P1） > 冷启动 > 传输 > 模块化
```

理由：**BreachWeave 的排序解决「能否接入」，本文档的 P0 解决「是否值得接入」。** 如果一个宿主在算清账之后发现不值得，那么把接入修得再好也是沉没成本。两项 P0 不冲突——价值主张是**文档工作**，可移植性是**工程工作**，可并行。

### 5.2 RM-1｜价值主张与「反向差距」文档（P0）

**这是本文档最重要的建议。**

| # | 动作 | 验收 |
|---|---|---|
| 1 | 新增 `docs/taric-value-proposition.md`：按能力列出「宿主自建成本 vs 集成 Taric 成本 vs 增量价值」 | 每个能力有一行结论，含「增量大/中/小」判定 |
| 2 | 明确**三处高增量能力**（跨会话记忆、checkpoint/resume、证据链可审计），并将其从大叙事中**提升为独立可售能力** | 每项有独立章节，说明「不采用其余部分是否可用」 |
| 3 | 新增「**什么时候不建议用 Taric**」章节 | 至少给出 2 类不适用场景（如单会话一次性评估、无合规交付要求） |
| 4 | 显式披露**零模型直写的成本面**：收益与宿主记忆半径成正比；给出「记忆半径」的判断标准 | 读者能自行判断自己属于哪一侧 |
| 5 | 汇总宿主侧工作量：把集成方案 §10.4 的 8 项前提换算为「宿主需投入的工程量」 | 给出量级估算（人周级），而非定性描述 |

**第 4 项是本方案中最反直觉、也最有价值的一条。** 主动披露成本会降低短期感知吸引力，但它是唯一能让技术决策者信任其余论断的方式——**因为一个只讲收益的方案，读者会默认它隐瞒了成本，从而自行打折。**

### 5.3 RM-2｜能力分层与「降级姿势」文档（P0）

| # | 动作 | 验收 |
|---|---|---|
| 1 | 产出**能力依赖图**：明确每个 operation 的依赖闭包（哪些需要 WorkRun、哪些需要 fence、哪些独立） | 能回答「只取跨会话记忆需要哪些 operation」 |
| 2 | 定义并文档化**最小可用闭环**（与 BreachWeave 分析 §6.5 呼应，但补上「零治理」档） | 至少三档：只读 / 只读+证据 / 全治理 |
| 3 | **单写者模式**正式化：明确无租约、无 generation 的写入语义与安全边界 | 文档明确说明「单写者下哪些保证失效」 |
| 4 | Artifact 与 WorkRun 的耦合关系写成**显式矩阵**（而非散落在流程图） | 读者能判断「无 WorkRun 时哪些字段可选」 |
| 5 | 同步修正 §4.4 的 fence 文档/实现不一致 | 文档与实现语义一致，二者之一被修改 |

**背景**：`coverage.ts:12-19` 的 `CoverageCell` 不含 WorkRun 字段，`service.ts:546-547` 的 `work_run_id` 可选——**降级能力已在代码里**，只是没有文档化。这是本文档中投入产出比最高的一条。

### 5.4 RM-3｜宿主代理层参考实现（P1）

| # | 动作 | 验收 |
|---|---|---|
| 1 | 把「宿主代理」从权宜之计提升为**受支持的一等拓扑**并给参考实现 | 有可运行的骨架代码 |
| 2 | 参考实现覆盖：写路径代理（把 agent 的写提议转为 host 调用）、观察捕获、Artifact 落盘 | 至少一个非 Taric 团队能照此接入 |
| 3 | 明确该层的**最小职责**与**不得委托给模型**的部分 | 与 §6 不变量一致 |
| 4 | 提供「宿主已有一层」与「宿主需新建一层」两种接入剧本 | 两类宿主各有路径 |

**为什么优先级高**：§4.3 的实测表明，对 CyberStrike 这类「agent 直写」宿主，**宿主代理层不是便利，而是前置条件**。BreachWeave 分析已提出此项（§6.5），本文档强化论据：它同时解开「低改动 vs 高价值」的互斥（§4.3 末）。

### 5.5 RM-4｜交互时延分级指标（P2）

| # | 动作 | 验收 |
|---|---|---|
| 1 | 把操作分为「宿主异步路径」与「agent 同步路径」两类 | 注册表中带标记，或文档给出清单 |
| 2 | 为同步路径定义响应预算（p50/p95），或明确声明「不适用于同步调用」 | 调用方可据此设计，而非猜测 |
| 3 | 若同步路径确实慢，文档给出**推荐的批量/异步用法** | 例如「累积 N 个提案后批量提交」 |

### 5.6 RM-5｜与既有分析文档的整合

| # | 动作 |
|---|---|
| 1 | 本文档与 BreachWeave 分析合并阅读路径：BreachWeave 回答「能否接入」，本文档回答「是否值得」 |
| 2 | 在集成方案开头增加一段**导航**：区分「能力参考」（§3–§9）与「采用决策」（本文档 + BreachWeave 分析） |
| 3 | 保持 §2.4 的事实校正纪律：本文档的每条宿主断言附行号，供复核 |

### 5.7 建议的交付顺序

```text
第一批（文档，成本低、解开感知门槛）
  RM-1 价值主张  +  RM-2 能力分层与降级姿势
  → 直接回应 CyberStrike 推演中「答不出值得吗」「感知耦合过高」两处阻断

第二批（工程，与 BreachWeave 分析的 P0 并行）
  RM-3 宿主代理参考实现  +  BreachWeave §6.2 可移植运行时
  → 解开「低改动与高价值互斥」

第三批（收敛）
  RM-4 时延分级  +  RM-5 文档整合  +  BreachWeave §6.3 事件驱动
```

---

## 6. 应坚持的不变量

**本文档的全部建议都在表达层与路径层，不得触碰以下任何一项：**

- 零模型直写；`capture.observation` host-only；模型只有提案权
- fail closed 与结构化拒绝；证据缺失即拒绝，不放宽
- 五硬门由非 LLM 策略引擎重算；模型自报字段（`accept: true`、`trust_level`、`verified`）无效
- L1 ≠ 事实；L0/L1 默认不进普通召回
- Artifact 不解析、不脱敏、不扫描；凭据生命周期与保留策略属宿主
- 「不调度 agent、不执行目标动作、不签发授权」的边界
- Engagement 隔离；跨 Engagement 不自动共享

**特别说明**：§5.2 建议「披露零模型直写的成本面」，这是**披露**而非**削弱**。Taric 应当坚持该设计，只是需要让宿主知道自己在为什么付费。同理，§5.3 的「单写者模式」不是引入一条不安全的捷径，而是把**代码中已经存在的条件语义**如实写出，并明确标注在该模式下哪些保证不成立。

**降低接入门槛不能以放宽准入为代价。** 一旦为了让宿主「好接」而允许模型直写或跳过硬门，Taric 就退化为一套普通的共享存储——那正是成熟宿主已经拥有的东西，也就没有任何理由再接它。

---

## 7. 附录：证据索引

### 7.1 Taric 侧

| 事实 | 位置 |
|---|---|
| Core 源码 10,158 行 | `packages/core/src/**/*.ts`（实测统计） |
| schema `$defs`、operation 与模型工具合同 | `packages/schemas/schemas/v1/core.schema.json`；`packages/schemas/src/registry.ts`；`packages/mcp/src/server.ts` |
| MCP 仅 6 个模型工具，无 Artifact 原文操作 | `packages/mcp/src/server.ts:3` |
| `assertFence` 条件校验（三要素全缺则放行） | `packages/core/src/artifact-content-store.ts:422-425` |
| `capture.observation` 的 `work_run_id`/`generation` 可选 | `packages/core/src/service.ts:546-547` |
| `CoverageCell` 不含 WorkRun 字段；含 role/tenant/path/network_condition/method 正交维度 | `packages/core/src/coverage.ts:12-19` |
| `CoverageCell` 的维度隔离注释「A cell is never merged across these」 | `packages/core/src/coverage.ts:15` |
| L0/L1/L2 召回过滤实现 | `packages/core/src/store.ts:435` |
| `isRecalled` 生命周期过滤 | `packages/core/src/store.ts:1085-1106` |
| 非目标清单（12 项）与安全不变量（5 项） | `packages/core/src/compatibility.ts` `TARIC_NON_GOALS` / `TARIC_SECURITY_INVARIANTS` |
| p95 ≤2s 为发布门槛 | `docs/taric-code-design.md:430,609` |
| 集成方案声明 Artifact「必须带 run fence」 | `docs/Taric面向渗透测试智能体的集成方案.md` §6.3、§8.1 |
| 8 项宿主工程前提 | 同上 §10.4 |
| 四个模型工具之外无写入路径（MCP tools/list 白名单） | `docs/taric-code-design.md` §7.3 |

### 7.2 CyberStrike 侧（推演宿主）

| 事实 | 位置 |
|---|---|
| 覆盖笔记：append-only，wide/local，`wideBlock()` 自动注入，`INJECT_LIMIT=10` | `packages/cyberstrike/src/session/coverage-note.ts:22,37-38,179-191` |
| 设计取向原文注释「RAW process memory — append-only, cheap, judgment stays with the agents」 | `packages/cyberstrike/src/session/coverage-note.ts:17-20` |
| 观察累积：`(session,key_hash,credential,value_hash)` 唯一索引 + ON CONFLICT DO NOTHING | `packages/cyberstrike/src/session/observation.ts:33-71` |
| `candidate` 门控：执行类漏洞无 `execution_evidence` 强制降级，可原地升级 | `packages/cyberstrike/src/session/vulnerability.ts:39-42,76-127`（`candidate` 字段定义见 :41-42；`vuln-scope` 判定见 `tool/vulnerability.ts:78`） |
| triage 生命周期：new/approved/duplicate，永不删除 | `packages/cyberstrike/src/session/vulnerability.ts:16-19,129-165` |
| lane 约束：TESTER_VRT_SCOPE 结构化防越界 | `packages/cyberstrike/src/tool/vuln-scope.ts:1-40` |
| 长期记忆：项目级 MEMORY.md + 每日笔记，纯文本行搜索，**不自动注入** | `packages/cyberstrike/src/memory/index.ts:23-41,110-135,194-219` |
| 记忆注入仅在模型显式调用 `memory_context` 时发生 | `packages/cyberstrike/src/tool/memory.ts:172-178`（无自动调用点） |
| 会话作用域：`Session.root()` 仅归并到根会话，不跨会话 | `packages/cyberstrike/src/session/index.ts:547-557` |
| 三层上下文管理：isOverflow / filterCompacted / prune（40k 保护窗口） | `packages/cyberstrike/src/session/compaction.ts:32-48,58-101` |
| compaction 摘要模板（Objective/Work State/Next Move） | `packages/cyberstrike/src/session/compaction.ts:153-183` |
| 单一 SQLite + WAL | `packages/cyberstrike/src/storage/db.ts:146-148` |
| 原始请求字节存储（`raw_request`） | `packages/cyberstrike/src/session/session.sql.ts:127-192` |
| 工具输出截断：2000 行 / 50KB | `packages/cyberstrike/src/tool/truncation.ts:10-11` |
| 验证闸：per_asset_coverage 60% 阻塞阈值 | `packages/cyberstrike/src/methodology/validation.ts:278-345` |
| session 级串行（IngestQueue 为 Promise chain） | `packages/cyberstrike/src/session/ingest-queue.ts:5-60` |
| 循环防呆：doom_loop（连续 3 次同工具同参数） | `packages/cyberstrike/src/session/processor.ts:152-177` |
| tester steps 上限 60 | `packages/cyberstrike/src/agent/agent.ts:899-904` |
| agent 体系：1 primary + 4 领域 + 9 tester + 4 hidden | `packages/cyberstrike/src/agent/agent.ts:163-845` |
| 子会话机制：parent_id + 递归 SessionPrompt.loop | `packages/cyberstrike/src/tool/task.ts:46-336` |
| 方法论上下文每轮注入系统提示 | `packages/cyberstrike/src/methodology/context.ts:29-120` |

### 7.3 方法论备注

- **推演方式**：CyberStrike 侧约 30 个文件逐项走读（agent/session/tool/methodology/memory/replay），非文档对照。所有宿主断言附文件行号。
- **对照方式**：Taric 集成方案（§3 风险防护、§4 身份、§5 黑板、§6 工作流、§9 上下文、§10 能力评估、§12 边界）逐节与 CyberStrike 实现比对。
- **已知局限**：推演未执行 CyberStrike（未安装依赖、未运行测试）；其能力判断基于代码结构，非运行时行为。若要推进实际集成，建议按集成方案 §11 的 P1 阶段（只读黑板）做最小 POC 验证本文档的增量判断。
- **一处存疑**：CyberStrike 的 `Memory` 模块注释称记忆「automatically called at session start」，但全仓未找到自动调用点——这可能是宿主侧的实现缺陷或文档漂移，本文档按代码实际行为（不自动注入）计入重叠度。

---

## 8. 最终判定

### 8.1 对 CyberStrike 这个具体宿主

| 场景 | Taric 必要性 | 依据（本文档章节） |
|---|---|---|
| 单人单机、短周期、一次性评估 | **低** | §2.2 重叠度 60%；§3.3 零模型直写为净成本 |
| 团队协作 / 多机 / 长周期持续测试 | **高** | §3.2 跨会话记忆缺口（Taric 独有） |
| 合规交付 / 取证级报告 | **高** | §3.2 证据链缺口（Taric 独有） |
| 多 agent 并发攻击同一目标 | **高** | §2.2 并发原语完全缺失 |

**结论**：必要性成立的部分是**具体的、分片的**；不成立的部分是**整体的、哲学的**。这与 BreachWeave 的「整体需要但接不上」形成互补样本。

### 8.2 对 Taric 本身

**Taric 已经把它最难的部分做对了**——BreachWeave 分析的这句判断在本次推演中得到强化而非削弱。CyberStrike 推演没有发现任何一处 Taric 核心机制的实质缺陷（§4.6）。

**但本次推演发现了另一类风险：Taric 的能力越强，越容易陷入「完整性叙事」的陷阱。**

当一份方案的主要篇幅用于证明自己「消除了一切风险」，读者会本能地寻找它没说的部分——成本、适用边界、不适用场景。CyberStrike 推演正是这种寻找的结果：它不是在找 Taric 的 bug，而是在找「我为什么要为你换掉一套已经在跑的东西」。

**因此，本文档的核心建议不是让 Taric 变得更好接入，而是让 Taric 变得更好理解。** 前者是 BreachWeave 分析的任务，后者是本次推演揭示的、同样紧急的任务。
