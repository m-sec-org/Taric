# Taric 差距分析与改进优化建议

> 基于 BreachWeave 集成推演 · 结合 MCP 事件驱动机制演进

- 分析日期：2026-10-16
- 分析对象：Taric `c3db857`（历史 HEAD 工作区源码；本文不是当前实现基线）
- 推演宿主：[BreachWeave](https://github.com/m-sec-org/BreachWeave)（`pentest` 分支，Bun monorepo，多角色渗透测试协作平台）
- 分析方式：宿主侧集成可行性推演（非纸面评审） + Taric 源码逐项走读 + MCP 现行规范与工作组章程核对
- 配套阅读：[当前设计](taric-design.md)、[集成方案](Taric面向渗透测试智能体的集成方案.md)、[接入指南](agent-integration.md)、[历史硬化变更](../openspec/changes/harden-taric-authority-runtime/)

**方法论说明**：本报告的差距不是通过规格对照发现的，而是通过**尝试把 Taric 接入一个真实存在、且未参与 Taric 设计的宿主**发现的。这决定了差距的性质——它们绝大多数不在 Taric 的能力内部，而在「一个有意愿接入的团队能否走通」。

---

## 能力提升后的状态校正（2026-10-27）

本文保留 2026-10-16 的推演、代码基线、行号与建议。原正文中的“当前”“未实现”“不支持”均限定为当时状态，不作为当前待办或当前实现判断；§1–8 是历史分析和建议，不是实施路线。当前状态以[接入指南](agent-integration.md)、[API 合同](taric-api.md)、源码与测试为准。2026-10-27 的 `1.0.1` build/typecheck/matrix、PG 配置 workspace tests（Core 356、Schemas 10、CLI 37、MCP 12、Hermes 5、Bun 11）及当前 runtime/backup/restore、同机双容器 lease/reclaim、容器 spool bind-mount 检查均通过。Pi 1.4.0 真实 RPC host 已加载 Taric 扩展。没有认证完整第三方宿主工作流、跨物理机网络恢复或 BreachWeave 集成；可选 TLS TCP/HTTPS gateway 已实现并通过本机 loopback 端到端测试，但生产网络部署与跨机故障恢复尚未验证。文中外部项目与 MCP 工作组快照未重新核验。

| 原差距 | 当前结果与边界 |
|---|---|
| 运行时不可移植 | 本机 Node proxy/真实 Bun client 已完成重启验证；`@taric/driver-bun-sqlite@1.0.1` 进程内驱动已通过当前构建和驱动测试。Pi 1.4.0 RPC host 已实际加载 Taric extension；尚未认证完整 Pi 工作流、BreachWeave 或其他宿主。包仍标记 private，registry 发布和完整第三方宿主认证不在此验证范围。 |
| 宿主 ID 封闭 | 自定义 adapter ID 已开放，认证仍按 package/distribution/version/commit 与实际实例绑定判断。 |
| 无最小接入路径 | A～E 依赖闭环与独立 Node 治理示例已交付。 |
| 无状态通知 | Core in-process 与 authenticated adapter RPC 已实现 bounded best-effort host subscription，并使用 query/read_seq 恢复；MCP resources subscription 与 Tasks 仍未支持。本机轮询 fixture 满足 1000ms 预算，不要求所有部署启用通知。 |
| 存量导入 | 公开 snapshot.import 明确 unsupported；旧材料走正常 proposal/evidence，不提供通用历史迁移。 |
| 共享 authority 与 transport | 当前源码 PostgreSQL live report、同机双 host 容器 lease/reclaim 已通过；Unix socket 与 TLS TCP/HTTPS gateway 有本机测试。跨物理机部署、生产网络故障恢复未验证；多主机正确性由 PostgreSQL 提供，gateway 不参与协调。 |

历史综合[技术验收](benchmarks/capability-verification-v2.json)和候选 release report 绑定旧源码基线，均不作为本轮 `1.0.1` PostgreSQL runtime 证据。当前本地验证计数见本节开头；质量统计能力因人工标注样本和人类基线缺失仍为 unsupported/pending。本文原始代码行号、Bun/推送/宿主差距保留为历史推演，不等于当前未完成项。

## 目录

1. [总体结论](#1-总体结论)
2. [推演基线与验证记录](#2-推演基线与验证记录)
3. [经推演验证的亮点](#3-经推演验证的亮点)
4. [差距分析](#4-差距分析)
5. [专项：事件驱动能力与 MCP 机制](#5-专项事件驱动能力与-mcp-机制)
6. [改进优化建议方案](#6-改进优化建议方案)
7. [附录：证据索引](#7-附录证据索引)

---

## 1. 总体结论

**Taric 已经把它最难的部分做对了，但在「被接入」这件事上投入严重不足。**

BreachWeave 推演提供了一个高信息量的测试用例：一个架构上**天然需要 Taric**（多 agent 共享记忆、报告驱动、旁路监督、长周期状态）的宿主，在没有任何先验倾向的情况下尝试接入，结果会依次撞上四堵墙——**跑不起来、认不出、进不去、接不上**。

这四堵墙没有一处涉及 Taric 的核心价值（治理链、覆盖矩阵、证据硬门、零模型直写），但任何一堵都足以让接入评估在早期被否决。这构成一个结构性风险：**Taric 的差异化能力越强，越容易因为接入门槛而被跳过**——因为需要这些能力的宿主，往往也是最不可能接受「fork 你的存储驱动」这一前提的宿主。

差距集中在四个层面：

| 层面 | 差距性质 | 优先级 |
|---|---|---|
| **运行时可移植性** | 硬依赖 `node:sqlite`，非 Node 运行时无法嵌入；驱动注入点已存在但未公开 | P0 |
| **宿主接入契约** | `AdapterHostId` 封闭枚举、Pi 版本严格相等、Pi 包命名空间锁定；无最小可用接入路径 | P0 |
| **状态推送能力** | MCP 层只有 tools、无 resources，无任何 server-initiated notification；事件驱动能力为零 | P1 |
| **采用路径** | 存量状态无导入路径、传输拓扑集中于 stdio/Unix socket、模块边界未文档化 | P1–P2 |

需要明确的是：**本报告不主张降低 Taric 的安全标准**。零模型直写、host-only `capture.observation`、fail closed、Artifact 不解析不脱敏——这些是不变量，任何可接入性改进都不得触碰。下面所有建议都在这条红线之内。

---

## 2. 推演基线与验证记录

### 2.1 推演宿主画像

BreachWeave 是一个 CTF/渗透测试多 Agent 协作平台（腾讯云黑客松智能渗透挑战赛线上初赛及决赛第一名），架构为 `Manager / Planner / Solver / Observer`：

- **Planner**：LLM 驱动的持续调度循环（30s tick），读取资产状态、共享知识、过往报告、Solver 表现后决定启动哪些 Solver。
- **Solver**：Docker 容器内运行的 `pi-coding-agent` 会话，通过 stdin/stdout JSONL RPC 与宿主通信。
- **Observer**：容器内旁路扩展，每 6 轮或 `agent_end` 时由 LLM 审阅执行轨迹，维护 memory/idea 看板。
- **共享知识**：项目级 Memory（fact/evidence/failure/note/hint）与 Idea（pending/testing/verified/failed/skipped）。

**该宿主与 Taric 目标画像的匹配度**：高。多 agent、共享记忆、长周期任务、需要状态同步、产生大量原始证据——理论上正是 Taric 集成方案的目标场景。

### 2.2 本地验证记录

| 验证项 | 命令/方法 | 结果 |
|---|---|---|
| Taric 源码规模 | `wc -l packages/core/src/*.ts` | 10,158 行（`store.ts` 3,335 行） |
| Taric 测试规模 | 各包 `test/*.mjs` 计数 | core 47、cli 2、mcp 2、schemas 1、hermes 1 |
| 规格基线 | `openspec/specs/` | 14 个规格 |
| Bun 运行时兼容性 | Bun 1.3.13 实测 `import("node:sqlite")` | **失败**：`No such built-in module: node:sqlite` |
| MCP 推送能力 | `grep -c notification packages/mcp/src/server.ts` | **0** |
| Adapter RPC 推送能力 | `grep -c "notification\|push" packages/core/src/adapter-rpc.ts` | **0** |
| Resources capability | `grep -rn "resources/subscribe" packages/` | **无匹配** |
| 宿主既有 Taric 引用 | BreachWeave 全仓 `grep -i taric` | **无匹配** |

### 2.3 事实校正声明

推演过程中发现 Taric 现有文档间存在**反方向漂移**（文档低估实现）：

历史基线中的 `README.MD` 曾声明 Pi 1.1.0 hooks unsupported；当前仓库实际文件为 [`readme.md`](../readme.md)，认证版本为 Pi 1.4.0，能力状态以 `packages/core/src/compatibility.ts` 与 adapter 实例状态为准。

先前的实现分析评审（`taric-implementation-analysis-review.md` G1）只捕获了「文档说 supported、实现 unsupported」这一侧。**反向漂移同样有害**：它会误导集成方放弃本可用的能力。以 `compatibility.ts` 为唯一源同步一次。

---

## 3. 经推演验证的亮点

以下亮点是**通过集成推演确认具备真实价值**的——即它们是宿主确实缺失、且确实需要的能力。这比规格符合度更有说服力。

### 3.1 零模型直写：真正的差异化，且推演给出了反证

BreachWeave 提供了一个近乎完美的对照组：

- **BreachWeave 的做法**：Observer（LLM）通过 `host bridge` 直接调用 `challenge_memory_add` 写入项目级共享记忆。宿主侧只做**非空校验与枚举校验**（`host-bridge-handler.ts:161-171`、`manager.ts:1345-1350`），无准入、无信任分级、无证据强制。
- **Taric 的做法**：模型对权威记忆只有提案权；`capture.observation` 为 host-only；L1 结构与引用准入与 L2 五硬门分离；模型自报的 `accept: true` / `trust_level` / `verified` 全部无效。

推演结论：BreachWeave 中「幻觉型误报污染共享记忆」的传播半径**是开放的**——一条无证据支撑的 memory 进入项目共享层后会广播给全部活跃 Solver，并写入后续每个新 Solver 的初始上下文。Taric 的 L0/L1 隔离区设计正是为此存在，且这套设计在推演中未被证明存在替代方案。

**这是 Taric 最不可替代的能力，应当作为对外定位的第一句话。**

### 3.2 覆盖矩阵：与真实宿主的落差最大

BreachWeave 的资产状态是单一布尔值 `{ asset, asset_hash, scanned: boolean }`（`store.ts:29-33`）。报告提交即 `scanned = true`，全部 `scanned` 即项目完成（`manager.ts:1261-1281`、`store.ts:479-483`）。

结构性后果：

- 「测过什么/没测什么」是布尔值，无法表达「未测 / 阻断 / 阴性 / 不确定」。
- `coverage_gaps` 字段存在，但在 `ingest-sub-agent-output.ts:127-136` 被折叠为标量分数 `min(100, assets*8 + hypotheses*6 + findings*4 - gaps*12)`，**不是可查询的持久状态**。
- 阴性结果无处存放：测试失败信息只以「记忆条目」形态存在，会因体积压力被 Observer 合并/删除。

Taric 的 `CoverageCell`（资源版本 × 测试类别 × 身份 × 操作 × 条件）与「阴性结果有界保存」「未测/blocked 在白名单投影中强制可见」直接命中这一落差。这是 Taric 能力与真实宿主缺口**距离最大**的一项。

### 3.3 `resume delta` 与 `read_seq`：被低估的架构资产（本次推演的核心新发现）

`packages/core/src/context.ts:446-461` 的 `ResumeContextDelta` 定义了：

```ts
{
  from_read_seq, to_read_seq,
  added: CanonicalRecord[], updated: CanonicalRecord[], removed: string[],
  events: Array<{ commit_seq, event_id, event_type, subject_id, hash }>,
  scope_changes, dependency_changes, pending_actions,
  context_manifest, blocked, replan_required
}
```

这在语义上**已经是一个完整的事件增量流**：有序（`commit_seq`）、可验证（`hash`）、可恢复（`from_read_seq` 锚点）、且携带语义分类（scope/dependency 变化、待决动作、前提失效标记）。

配合 `commit_seq` 严格有序提交序列、watermarks（catalog/index/projected）与哈希链审计，Taric 实际上具备了一个事件驱动系统所需的**全部底层原语**。

**但 Taric 目前只把它暴露为「需要主动调用的查询」。** 详见 §5。

### 3.4 治理链与运维面的完整度

- **五硬门**（schema/scope/evidence/freshness/independence）由非 LLM 策略引擎重算，模型 payload 中的任何自报字段无法改变结果。
- **哈希链审计**：`prev_hash`/`hash` 串联，`verifyAudit()` 整链校验，事件携带完整归属元数据（actor/host/worker/dispatch、WorkRun/Attempt、proposal/review、policy digest、input/evidence hash）。
- **doctor/reconcile + write-blocking**：权威漂移**阻塞写入**而非带病运行，恢复动作显式分为 preview/replay/rebuild，不静默改写历史。
- **幂等键绑定** principal + engagement + operation + 规范化 payload hash。

推演佐证：BreachWeave 的对应面是文件系统 JSON + `mkdir` 目录锁（`store.ts:139-172`），60s 陈旧锁**强删**，无版本、无哈希链、无漂移检测。timeline 是每次请求现算的派生视图，底层文件可任意修改。

### 3.5 自省文化本身是资产

`docs/taric-implementation-analysis-review.md` 是一份高质量的自我批评：明确承认早期文档将 L1 admission 描述为「已执行完整治理硬门」是**实质性夸大**，逐条裁决 14 项差距，并区分「算法已交付」与「运行时/证据已启用」。

这种自省质量在同类项目中罕见。**但它也意味着：引用 Taric 能力时必须回到代码，不能只看设计文档的表格。** 本报告的 §2.3 正是该纪律的一次应用。

---

## 4. 差距分析

差距按「阻断采用的严重程度」排序，而非按技术难度。

### 4.1 P0-1：运行时不可移植（硬阻断）

**事实**

`packages/core/src/sql-driver.ts:2` 硬依赖：

```ts
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
```

Bun 1.3.13 实测：

```
ResolveMessage: No such built-in module: node:sqlite
```

BreachWeave 是端到端 Bun monorepo（`bun run web`、`Bun.serve`、`bun build --compile` 产出容器内 Linux 二进制）。这意味着 `@taric/core` **无法进程内嵌入**。

**关键发现：扩展点已存在，只是未公开。**

`packages/core/src/store.ts:323-324`：

```ts
constructor(filename: string | AuthoritySqlDriver = ":memory:") {
    this.sql = typeof filename === "string" ? new SqliteAuthorityDriver(filename) : filename;
}
```

驱动是可注入的（`AuthoritySqlDriver` 接口位于 `sql-driver.ts:14-33`）。但 `sql-driver.ts` **未从 `packages/core/src/index.ts` 导出**，且 `packages/core/package.json` 没有 `exports` map（仅有 `main`/`types`）。第三方运行时无法实现第二个驱动——**这个扩展点是死代码**。

**影响范围**：不限于 BreachWeave。任何非 Node 运行时（Bun、Deno、边缘环境）均被同一堵墙挡住，而 Node 之外的 JS 生态正在快速增长。Taric 已知限制「同步 SQLite API 会阻塞调用进程」在异步运行时中反而更容易被接受。

**为什么是 P0**：这是唯一一个**无法通过文档或适配层绕过**的阻断。宿主必须在以下三者中选一：fork 存储驱动、引入 Node sidecar 进程、或放弃接入。

### 4.2 P0-2：宿主接入契约封闭

三处具体障碍：

| 位置 | 问题 | 后果 |
|---|---|---|
| `packages/core/src/adapter.ts:10` | `AdapterHostId = "pi" \| "deepseek-harness" \| "hermes"` | 自研宿主在**类型系统中无法被表示** |
| `packages/core/src/pi-adapter.ts:19` | `isSupportedPiVersion` 为严格相等（`=== "1.1.0"`） | 差一个 patch 版本也返回 `capabilities: []` |
| `packages/core/src/pi-adapter.ts:10-12` | 锁定 `@earendil-works/pi-coding-agent` | BreachWeave 使用 `@mariozechner/pi-coding-agent@0.65.2`——**不同包命名空间**，永远不可能相等 |

第三条尤其值得注意：这不是版本滞后问题，而是**生态分化**。`@earendil-works/pi` 与 `@mariozechner/pi-coding-agent` 是两条独立演进线。锁定单一命名空间意味着适配器的有效覆盖范围被限定在一个具体分叉上。

**当前设计的隐含假设**是「宿主会使用 Taric 已认证的框架」。但对于自研宿主（Taric 集成方案 §4.4 明确承认的接入形态：「自主开发的渗透测试宿主可直接内嵌 Core」），适配器层完全不可用——它们只剩 MCP/CLI 回退。而由于 `AdapterHostId` 是封闭联合，**连注册一个自定义宿主身份都做不到**。

**为什么是 P0**：Taric 的核心定位是「扩展」（README 首句），但当前契约只能服务三个已知宿主。**「扩展」实际等于「Pi 的插件 + 两个受限回退」。**

### 4.3 P0-3：无最小可用接入路径

集成方案第 11 节将接入定义为 P1–P5 五阶段，但那是**Taric 的能力路线图**，不是「宿主最少要做什么」。

一个只想获得治理能力（L0/L1/L2 + 证据硬门）的宿主，需要同时理解并落实：`WorkItem/WorkRun/Attempt`、`lease/heartbeat/reclaim`、`generation fencing`、`Checkpoint`、`ActionIntent` 三模式、`Artifact` 三段上传、`Context Pack` cursor 与 resume。这些能力在文档中高度耦合呈现，无法判断哪些是独立的、哪些成组依赖。

推演佐证：在评估「只拿治理能力」时，必须自行推导出最小集合，且无法从文档确认该集合是否自洽。

### 4.4 P1-1：MCP 层无 resources，架构性不可订阅

`packages/mcp/src/server.ts:19`：

```ts
capabilities: { tools: {} }
```

无 `resources` capability，整个 MCP server 不实现资源。三个查询操作（`context.query` / `resource.query` / `evidence.query`）语义上均为纯读，却全部塞进 tools。

MCP 的设计意图是 **tools 承载有副作用的动作、resources 承载数据**。Taric 这么做的理由充分（tools 的参数白名单是受控面，`additionalProperties: false` 严格校验），但结果是一个**架构性副作用：不可订阅**。

`grep -rn "resources/subscribe" packages/` 无任何匹配——Taric 全仓没有事件订阅的任何痕迹。

### 4.5 P1-2：无任何 server-initiated 推送能力

| 通道 | 推送能力 |
|---|---|
| MCP stdio（`packages/mcp/src/server.ts`） | notification 出现 **0** 次 |
| Adapter RPC（`packages/core/src/adapter-rpc.ts`） | notification/push 出现 **0** 次；`node:net` Unix socket，一连接一请求模型 |

**当前所有状态感知都必须是主动拉取**：

- 宿主想知 WorkRun 是否被 reclaim → 轮询
- planner 想知是否产生新 Conflict / ImpactEvent → 下轮查询
- observer 想知 L1 是否积压 → **完全不可见**，除非有人主动查
- 想知证据 freshness 是否临近过期 → 无任何提示

这与 Taric 自评文档承认的残余缺口直接对应：

- §10.2.1 残余缺口 2：「`omitted_ranges` 只可见、不强制消费」→ 缓解责任推给宿主（前提 2：调度器把「消费完 omitted_ranges」作为规划完成验收条件）
- §10.2.2 残余缺口 2：「L1 积压 = 隐性漏报」→ 缓解责任推给宿主（前提 5：复核 SLA 与观察者巡查周期匹配）

**这些「前提」的本质是要求宿主自建轮询机制。** 事件驱动可以把它们从「宿主必须自行实现并持续守护」降为「协议层自然发生」。

### 4.6 P1-3：存量状态无导入路径（冷启动空窗）

`snapshot.import` 只接受 Taric-native JSON（`packages/core/src/service.ts:911`）。一个有既存状态的宿主想让 Taric 接管，没有路径把已有记录转为 Taric 记录。

推演佐证：BreachWeave 有资产表、memory entries（一条一 JSON 文件）、ideas index。迁移到 Taric 意味着**在获得任何价值之前先支付全部迁移成本**——这是采用阻力的典型形态。

### 4.7 P2-1：传输拓扑受限

- MCP：仅 stdio。
- Adapter RPC：`packages/core/src/adapter-rpc.ts:1,17` 使用 `node:net` `createServer`，仅 Unix socket，无 TCP 选项。
- 全仓无 `node:http` 服务。

推演佐证：BreachWeave 的 Solver 运行在 Docker 容器内，容器的 stdin/stdout 已被宿主自己的 JSONL RPC 占用——**MCP stdio 用不了**；Unix socket 跨容器需额外挂载。只剩「宿主代理」一条路。

值得肯定的是，Taric 对「宿主代理」这种拓扑的**安全模型是正确的**（零模型直写本就要求宿主代写），但它没有被定位为受支持模式并给出参考实现，读起来像是权宜之计。

### 4.8 P2-2：模块边界未文档化

`store.ts` 3,335 行，`AUTHORITY_BACKEND_METHODS`（`storage-contract.ts:46-60`）列出 80+ 方法。想只要覆盖矩阵的宿主也必须整包接受。不必立即重构，但缺少「能力分区」的文档化描述。

### 4.9 差距不包含的内容（避免过度归因）

以下问题**不是** Taric 的差距，不应被要求解决：

| 宿主问题 | Taric 是否应解决 | 依据 |
|---|---|---|
| agent 调度、并发池、无冲突判定 | 否 | §12.1：Taric 不是执行器 |
| 目标资源全局互斥/限速 | 否（仅部分） | §7.3：任务唯一租约 ≠ 目标资源锁 |
| 资产发现完备性 | 否 | §10.2.2 残余缺口 1 |
| 自动摘要、资源摘要沉淀 | 否 | §10.2.1 残余缺口 3 |
| 内容脱敏、凭据生命周期、保留期限 | 否（且是永久非目标） | §5.8 |

同时应诚实指出：**采纳 Taric 会新增暴露面**——Artifact spool 可能包含凭据/Token/Cookie 字节，而 Taric 明确不脱敏、不扫描、不自动删除。这是宿主的责任，但应在采用决策中被显式计入。

---

## 5. 专项：事件驱动能力与 MCP 机制

本节是 §4.5 差距的深化。事件驱动是 Taric 治理链**唯一缺失的一环**，且它需要的底层原语已全部就位——这使它成为投入产出比最高的一项改进。

### 5.1 MCP 机制成熟度分层（必须先分清）

| 机制 | 状态 | 对 Taric 的含义 |
|---|---|---|
| `resources/subscribe` + `notifications/resources/updated` | **已在规范内**（2025-06-18 版） | **现在就能做**，无外部依赖 |
| SEP-1686 Tasks | **已 Final**（2025-11-14 合并入 PR #1732），TS/Python SDK 有参考实现 | 可做，但注意客户端支持有限 |
| Triggers & Events WG 的 webhook 回调 | **Ideating**，孵化仓无代码，charter 于 2026-03-24 建立 | **不要押注**，观察即可 |

**校正一个常见误判**：MCP 的 Triggers & Events 工作组（联合 lead：AWS Clare Liguori、Anthropic Peter Alexander）目标确实是「让服务器主动通知客户端状态变化」，但其活跃工作项「SEP: Events in MCP v1 RFC」仍标记为 **Ideating**，孵化仓库 `modelcontextprotocol/experimental-ext-triggers-events` 明确声明「Contents are exploratory and do not represent official MCP specifications」，且尚无 SEP 草案或代码。

因此：**webhook 回调机制在标准层面尚不存在，不应作为实现依据**；而资源订阅早在规范内，没有理由等待。

### 5.2 核心设计原则：推送的终点是宿主，不是模型

这是整个专项的地基，因为它解决了「Taric 需要推送」与「Taric 必须限制模型上下文」这对表面矛盾。

Taric 的安全不变量是**零模型直写 + 字段白名单 + 最小投影**。推送看似在对抗这一点——往模型上下文里塞东西，正是 Taric 存在要防止的「上下文溢出 → 幻觉」。

**解法：推送在宿主终止，不下沉到模型。**

```text
Taric Core ──notification（无内容）──▶ 宿主 ──宿主决定──▶ 是否唤醒模型 / 如何注入
```

三个关键性质：

1. **通知不携带内容，只携带信号。** MCP 的 `notifications/resources/updated` 原始设计只传 URI，不带 payload。这不是限制，是恰好正确——通知一旦携带数据，就绕过了 Context Pack 的预算与字段白名单，成为新的外泄通道。
2. **模型永远收不到未经请求的上下文。** 这是读侧的「零模型直推」，是写侧零模型直写的自然对偶。宿主收到信号后，仍走 `context.query` 这条有预算、有白名单、有 `read_seq` 钉住的路径。
3. **6 个模型工具不需要改。** `context.query`/`resource.query`/`evidence.query` 保持纯拉取，安全模型不变。新增的是**宿主面**能力。

### 5.3 机制映射：几乎零阻抗的契合

Taric 已经把最难的部分做完了，只是没意识到它离事件驱动只差一层封装：

| Taric 已有 | 事件驱动需要 | 差距 |
|---|---|---|
| `commit_seq`（严格有序提交序列） | 事件排序保证 | **无**——Taric 可提供强于 MCP 通用要求的保证 |
| `read_seq` 钉住快照 | 订阅起点 | **无** |
| `resume delta`（added/updated/removed since read_seq） | 「上次之后变了什么」 | **无**——这就是 delta 的定义 |
| watermarks（catalog/index/projected） | 订阅游标 | **无** |
| 哈希链审计 | 事件可验证、可重放 | **无** |
| `doctor()` 漂移检测 | 健康事件源 | **无** |

`resume delta`（`context.ts:478`）本质就是「自 `read_seq` 以来的增量」。把它挂到可订阅 URI：

```text
taric://engagement/<id>/delta?since=<read_seq>
taric://engagement/<id>/coverage/gaps
taric://engagement/<id>/candidates/pending      # L1 积压
```

通知说「你的 delta 现在非空了」，客户端读到的是现成的增量包。**没有一处新机制，只是把已有能力暴露为可订阅形态。**

同理，`WorkRun` 的生命周期（`queued → claimed → checkpointed → completed/failed/blocked/lost`）与 SEP-1686 Tasks 的五状态机（`working`/`input_required`/`completed`/`failed`/`cancelled`）高度同构；`tasks/result` 的阻塞语义可直接承载 `action.host_hitl` 的审批等待。

### 5.4 事件清单：按「宿主是否需要立刻知道」筛选

不是所有状态变更都该产生通知——这决定事件的信噪比：

| 事件 | 现状 | 价值 | 依据 |
|---|---|---|---|
| `ImpactEvent` 产生（claim 撤回致依赖 stale） | 宿主下轮查询才发现 | **高** | §3.2 前提失效检测的推送化 |
| `Conflict` 进入队列 | planner「下一轮规划」才消解 | **高** | §7.2：长存留 Conflict 是协作异常信号 |
| `resume` 返回 `blocked/replan_required` | 下次 resume 才知道 | **高** | §6.5：错误前提上的续跑必须立刻叫停 |
| `ActionIntent` 进入 `unknown` | 需宿主周期对账 | **高** | §12.10：未对账外部动作是风险敞口 |
| L1 积压超阈值 / Finding 待复核超 SLA | **完全不可见** | **高** | §10.2.2 残余缺口 2 |
| 证据 freshness 临近过期 | 无任何提示 | **中** | 180/90/30/14 天阈值本就有时间语义 |
| `CoverageCell` 回退 | 无提示 | **中** | §10.2.2 |
| WorkRun 租约将过期 / 被 reclaim / generation 递增 | 需轮询 | **中** | §7.1 |
| 新的 L2 记录可召回 | 需重新查询 | **中** | planner「发现覆盖缺口」的触发信号 |
| Artifact 发布完成 / `integrity_failed` | 需查 | **低–中** | §8.3 observer 审计路径 |

**关键观察**：最上面几项恰好是 Taric 自评文档承认的残余缺口。事件机制没有推翻原结论，但显著降低了宿主的落实门槛——把「可见的遗漏」从**被动可查**变为**主动告知**。

### 5.5 四项工程硬约束

缺任何一项都会让该功能变成负债。

**（1）合并与背压（最重要）**

100 worker 的活跃 Engagement 每分钟产生数千次状态变更。逐变更推送会**亲手制造 Taric 存在要防止的上下文溢出**。

必须做每订阅者去抖/聚合：N 秒内至多一次通知，触发时 delta 覆盖自上次 `read_seq` 的全部变更。**因为通知无内容且指向 delta，合并零信息损失，只节流信号。**

同域先例：BreachWeave 的 `shouldSendEfficiencyReminder`（`observer-loop.ts`）已有「6 轮冷却 + 12 轮重复指纹抑制」——同类问题的同类解法。

**（2）投递时重新鉴权**

订阅是新的授权面。**必须在投递时重算 principal × capability × Engagement**，而非仅在订阅时校验。否则「订阅时有权限 → 被降权/换 Engagement → 继续收」会成为真实的越权通道。

这也天然解决「不同 principal 看到不同事件」：model 只收 L2 相关信号，observer 收审计类信号。

**（3）至少一次 + 可恢复，事件永不成为正确性依赖**

连接会断、通知会丢。**必须保持「漏掉通知 = 退化为轮询」**：客户端凭最后已知 `read_seq` 重读 delta 即可补齐。

该原则同时守住 Taric 边界——**它不需要、也不应该变成消息总线**。Events WG 明确将「通用 pub/sub 基础设施」排除在范围外，与 Taric 的自我定位一致。事件是**优化**，权威状态才是**事实**。

**（4）通知不进审计链正文**

Taric 审计事件「永不包含 Artifact 内容或凭据物料」。通知作为派生信号不应成为新敏感面；审计链记录「通知已投递」的元数据即可。

### 5.6 明确不做的反模式

| 反模式 | 后果 |
|---|---|
| 通知里带 payload | 绕过字段白名单与预算，安全模型回归 |
| 让模型直接订阅 | 引入未请求上下文，正是要防的失效模式 |
| 把事件当权威 | 需要消息总线语义、重放保证、持久队列——全部超出边界 |
| 自建通用 pub/sub | Events WG 已明确排除；且与定位不符 |
| 现在就实现 webhook 回调 | SEP 未定、孵化仓无代码，会造成返工 |
| **等待标准而什么都不做** | 资源订阅**已在规范内**，无理由等待 |

---

## 6. 改进优化建议方案

### 6.1 优先级重排

事件维度的分析**强化**了「接入面投入不足」这一核心判断，并改变了排序：

```text
原序：可移植运行时 > 开放宿主契约 > 冷启动路径 > 传输拓扑 > 模块化
新序：可移植运行时 > 开放宿主契约 > 事件/订阅（宿主面）> 冷启动路径 > 传输拓扑 > 模块化
```

理由：**事件能力是治理链唯一缺失的一环，且底层原语已全部就位。** 相比冷启动导入（让采用更容易），事件驱动是让已采用的价值放大——对存量宿主的增益更直接。

同时，事件维度给「传输拓扑」带来新紧迫性：stdio 本身支持服务端推送（`notifications/*` 走 stdout），故最近一步不需要 HTTP；但跨容器/跨机场景仍会撞上 §4.7 的拓扑墙。

### 6.2 RM-1｜运行时可移植性（P0）

| # | 动作 | 验收 |
|---|---|---|
| 1 | 从 `packages/core/src/index.ts` 导出 `AuthoritySqlDriver` 接口与 `SqliteAuthorityDriver` | 第三方可 import 并实现 |
| 2 | 为 `packages/core/package.json` 补 `exports` map（subpath exports） | 宿主可按需 import |
| 3 | 将 `AUTHORITY_RUNTIME_SCENARIOS`（12 场景）与 `runAuthorityRuntimeConformance` 正式发布为**第三方驱动一致性验收套件** | 文档化「实现驱动 → 跑验收」路径 |
| 4 | 提供 `bun:sqlite` 驱动参考实现（约 275 行，API 高度接近） | 至少一个非 Node 运行时跑通全量测试 |

**第 3 项是本方案中投入产出比最高的一条**：一致性套件已经写好并导出了（`storage-contract.ts`），只差把它作为公开契约发布。它把「移植成本」从「理解 3,335 行 store + 80 个后端方法」降为「实现一个接口 + 跑一遍验收」。

### 6.3 RM-2｜宿主接入契约开放化（P0）

| # | 动作 | 验收 |
|---|---|---|
| 1 | `AdapterHostId` 改为开放 string + **能力协商**：宿主声明支持哪些能力，Taric 校验并按交集工作 | 自研宿主可注册 |
| 2 | 版本门从「严格相等否则零」改为**兼容区间 + 能力降级**：未知版本 = 未认证的最小能力集，而非零能力 | 差一个 patch 版本仍可用已认证能力 |
| 3 | 抽出 **framework-neutral 宿主事件契约**，泛化 `PiHostEvent` / `PiLifecycleEventName` / `PiRuntimeBinding` | 契约不含框架专有名词 |
| 4 | 支持多 Pi 命名空间或多分发（`@earendil-works` 与 `@mariozechner`） | 至少一个非锁定分叉被声明支持 |

**背景**：`agent-integration.md` 已说明 Pi 只支持 2 个能力（`session_lifecycle`、`context_injection`），适配层本就薄——正因如此，契约更该做成宿主无关。

### 6.4 RM-3｜事件驱动能力（P1，本次新增）

**阶段 A（现在，无外部依赖）**

| # | 动作 |
|---|---|
| 1 | 实现 MCP `resources` capability（`subscribe: true`） |
| 2 | 暴露可订阅资源：`delta`、`coverage/gaps`、`candidates/pending`、`workruns` |
| 3 | 通知**只到宿主、无内容**（仅 URI + `read_seq`） |
| 4 | 合并节流：N 秒内至多一次，delta 覆盖全部变更 |
| 5 | 投递时重新鉴权（principal × capability × Engagement） |
| 6 | 保持「漏通知 = 退化为轮询」语义，事件不进审计正文 |

**阶段 B（SDK 已就绪）**

| # | 动作 |
|---|---|
| 7 | 宿主面接入 SEP-1686 Tasks：WorkRun 长操作、HITL 审批的 `input_required` |
| 8 | **明确边界**：这是 host 面（adapter RPC / CLI），不是 model 面。模型面 6 个工具大多很快，不需要 Tasks——避免过度投入 |

**阶段 C（观察，不实现）**

| # | 动作 |
|---|---|
| 9 | 跟踪 Triggers & Events WG 的 SEP 进展 |
| 10 | 若 webhook 回调定型，Taric 的 delta 语义是理想载荷载体 |
| 11 | **在 SEP 被接受前不实现** |

### 6.5 RM-4｜最小可用接入路径（P1）

定义并文档化**最小可用闭环**：

```text
只读：context.query
写入：proposal.submit → admission.evaluate → review.submit → admission.promote_l2
宿主：capture.observation
```

这 5–6 个 operation 即可提供「零模型直写 + 信任分级」的核心价值，与调度、租约、Artifact 完全解耦。

配套产出：
- **能力分层图**：明确哪些 operation 独立、哪些成组依赖（例如 `fencing` 仅在使用 WorkRun 时需要）。
- **拓扑参考**：把「宿主代理」写成受支持模式并给参考实现——这本就是 Taric 安全模型的正确形态（零模型直写要求宿主代写），不应读起来像 workaround。
- **同类先例**：参考 `add-artifact-content-storage` 变更的组织方式，把「最小闭环」作为一个可验收的 openspec 变更交付。

### 6.6 RM-5｜冷启动导入路径（P1）

| # | 动作 |
|---|---|
| 1 | 提供 **host-native bootstrap 导入**：接受宿主既有资产清单/历史记录，映射为 `Resource` + 带明确 provenance 的 `Observation` |
| 2 | **保持诚实**：导入记录必须带 `source_kind: "import"` 与相应较低信任级，不得伪装成新观察（字段语义已支持，仅缺路径） |
| 3 | 最低限度：文档给出「存量状态迁移食谱」，用现有 operation 组合出可行路径 |

### 6.7 RM-6｜传输拓扑（P2）

| # | 动作 |
|---|---|
| 1 | 为 adapter RPC 增加 TCP/HTTP 选项（复用同一 token 鉴权与 host principal 绑定） |
| 2 | **保留现有的显式启用门控风格**——不要为便利丢失 |
| 3 | 文档化 stdio 场景下 `notifications/*` 已可用（走 stdout），降低对 HTTP 的紧急依赖 |

### 6.8 RM-7｜模块化与一致性（P2）

| # | 动作 |
|---|---|
| 1 | 文档化「能力分区」（各分区的代码/表/操作边界），不必立即重构 |
| 2 | 长期可考虑将治理、覆盖、Artifact 拆为可选包，core 保留最小编排层 |
| 3 | **修正 §2.3 的反向漂移**：以 `compatibility.ts` 为唯一源同步 README |

### 6.9 应坚持的不变量

以下不得因「可接入性」而调整：

- 零模型直写；`capture.observation` host-only
- fail closed 与结构化拒绝
- 五硬门由非 LLM 策略引擎重算；模型自报字段无效
- Artifact 不解析、不脱敏、不扫描
- 「不调度 agent、不执行目标动作」的边界
- L1 ≠ 事实；L0/L1 默认不进普通召回

**降低接入门槛不能以放宽准入为代价。** 一旦为了让宿主「好接」而允许模型直写或跳过硬门，Taric 就退化为一个普通的共享存储——那正是成熟宿主已经拥有的东西，也就没有任何理由再接它。

---

## 7. 附录：证据索引

### 7.1 Taric 侧

| 主题 | 位置 |
|---|---|
| SQLite 驱动硬依赖 | `packages/core/src/sql-driver.ts:2` |
| 驱动注入点（未导出） | `packages/core/src/store.ts:323-324` |
| 驱动接口定义 | `packages/core/src/sql-driver.ts:14-33` |
| 后端方法清单（80+） | `packages/core/src/storage-contract.ts:46-60` |
| 一致性场景（12 项） | `packages/core/src/storage-contract.ts`（`AUTHORITY_RUNTIME_SCENARIOS`） |
| 宿主 ID 封闭枚举 | `packages/core/src/adapter.ts:10` |
| Pi 版本严格相等 | `packages/core/src/pi-adapter.ts:19` |
| Pi 包命名空间锁定 | `packages/core/src/pi-adapter.ts:10-12` |
| MCP capabilities 仅 tools | `packages/mcp/src/server.ts:19` |
| MCP 模型工具白名单（6 项） | `packages/mcp/src/server.ts:3` |
| resume delta 定义 | `packages/core/src/context.ts:446-461` |
| resumeContextDelta 导出 | `packages/core/src/context.ts:478` |
| snapshot.import 仅 Taric-native | `packages/core/src/service.ts:911` |
| Adapter RPC Unix socket | `packages/core/src/adapter-rpc.ts:1,17` |
| 能力清单（唯一源） | `packages/core/src/compatibility.ts` |
| Pi hooks 状态（与 README 冲突） | `packages/core/src/compatibility.ts:103` |
| README 反向漂移 | `README.MD:42` |
| 自我批评文档 | `docs/taric-implementation-analysis-review.md` |
| 事件/订阅缺失验证 | `grep -rn "resources/subscribe" packages/` → 无匹配 |

### 7.2 BreachWeave 侧（推演宿主）

| 主题 | 位置 |
|---|---|
| 资产状态单一布尔 | `packages/core/src/challenge/store.ts:29-33` |
| 报告即 scanned 翻转 | `packages/core/src/challenge/manager.ts:1261-1281` |
| 项目完成判据 | `packages/core/src/challenge/store.ts:479-483` |
| 共享记忆写入（仅非空校验） | `packages/core/src/challenge/host-bridge-handler.ts:161-171` |
| `appendMemory` 无准入 | `packages/core/src/challenge/manager.ts:1345-1350` |
| coverage_gaps 折叠为标量 | `packages/core/src/config/tools/ingest-sub-agent-output.ts:127-136` |
| Observer 直写共享记忆 | `packages/core/src/solver/extension/challenge-observer/tools.ts:285-321` |
| 主 Solver 无 memory_add（分工断言） | `packages/core/src/config/index.test.ts:884` |
| 待启用治理脚手架 | `packages/core/src/config/tools/index.ts:29-31` |
| 目录锁（60s 强删） | `packages/core/src/challenge/store.ts:139-172` |
| Solver 容器化与 JSONL RPC | `packages/core/src/runtime/runtime.ts:566-589` |
| 运行态仅内存 Map | `packages/core/src/runtime/runtime.ts:204` |
| Observer 冷却与指纹抑制 | `packages/core/src/solver/extension/challenge-observer/observer-loop.ts` |

### 7.3 MCP 规范与工作组

| 主题 | 来源 |
|---|---|
| Triggers and Events WG 章程 | https://modelcontextprotocol.io/community/working-groups/triggers-events |
| 孵化仓库（声明为 exploratory） | https://github.com/modelcontextprotocol/experimental-ext-triggers-events |
| SEP-1686 Tasks（已 Final） | https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1686 |
| Resources 与订阅（现行规范） | https://modelcontextprotocol.io/specification/2025-06-18/server/resources |

---

## 8. 最终判定

### 8.1 对 BreachWeave 这个具体宿主

即使本方案全部落地，推演结论仍是**短期不建议集成，优先自建轻量版**——用约 500–1000 行实现资产级认领、报告独立闸门、`scanned` 布尔升格为轻量矩阵，可覆盖当前痛点的大部分，成本约为 Taric 集成的 5%。

**但方向判断需要分开说**：BreachWeave 的架构是**天然记忆中心**的（多 Solver 共享知识板、报告驱动、Observer 维护状态），它已经走在 Taric 的思路上，只是用文件系统与提示词纪律代替了治理层。问题从来不是「需不需要记忆与状态同步」——它已经有了——而是**「需不需要一个带信任分级与证据硬门的记忆」**。当它需要向客户交付一份可辩护的报告时，答案会一夜之间从「不必要」变为「必须」。

### 8.2 对 Taric 本身

Taric 自称「面向多智能体渗透测试的长期记忆与协作扩展」，但从推演看，它实际交付的是一个**面向 Node 单机、Pi 生态、自建宿主的垂直方案**。

不是能力问题，是接入面问题。

不做 RM-1 与 RM-2，Taric 只能服务一个宿主，**「扩展」就等于「Pi 的插件」**；做了这两项，其治理链与覆盖矩阵才有可能成为多智能体渗透测试的公共基础设施——那才是它真正值钱、也最难被复制的那部分。

而 RM-3（事件驱动）是最省力的一步：Taric 把自己的记忆设计成了「可按序列位点重放的版本化状态」——**这恰好是事件驱动系统梦寐以求的底层**。它缺的不是能力，是把 `resume delta` 与 `read_seq` 从「需要主动查询的接口」变成「可以被动告知的信号」，而这个转换在 MCP 现有规范内即可完成，无须等待任何标准。

**对记忆系统而言，能被订阅比能被查询更接近「活的记忆」。** 这是 Taric 从「状态存储」走向「协作伙伴」最近的一步。
