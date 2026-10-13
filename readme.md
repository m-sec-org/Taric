# Taric

Taric 是一个面向多智能体渗透测试的长期记忆与协作扩展。Core 提供版本化的 Engagement 权威状态、提案治理、证据引用、覆盖评估、任务租约、checkpoint、审计恢复、Context Pack 和可重建投影；CLI、MCP 与宿主 adapter 共享同一套 API 合同。

Taric作为独立插件或扩展，自身不运行模型，不决策启动，不启动 agent，不执行目标系统的操作。交由上层宿主应用负责 agent 调度、工具调用和动作授权。Artifact 可继续由宿主外部管理；宿主也可显式授权 Taric 在已绑定的任务会话 spool 中保存 opaque 原始内容。凭据生命周期、内容脱敏和保留期限仍由宿主/operator 负责。


## 设计边界

| Taric 负责 | 宿主应用负责 |
|---|---|
| 保存版本化的 Engagement 记忆 | 启动和调度 agent |
| 区分待审提案、机审候选和独立验证记录 | 调用渗透测试工具 |
| 记录证据引用和测试覆盖状态 | 决定高风险动作是否允许 |
| 管理 WorkRun、checkpoint 和 handoff 状态 | 选择自主执行或 HITL 流程 |
| 按授权在任务会话 spool 保存 opaque Artifact 原始字节 | 管理 Artifact 脱敏、凭据生命周期和保留策略 |
| 记录宿主回传的动作决定和结果 | 管理凭据、审批人身份和用户授权 |

Core 的权威边界是单主写入的 SQLite WAL authority；多主机 PostgreSQL profile 属于后续能力。所有 canonical 写入经过 Core service、身份校验、schema/状态机/版本检查和审计事件；Markdown、Git、Context Pack、JSON/JSONL snapshot 都是派生结果。可选 Artifact spool 的 payload 文件位于配置的内容根目录，不嵌入 authority 数据库、审计事件或模型输出。模型调用、worker 调度和目标系统请求不进入 Core。

Taric 支持三种动作协作模式：

- `llm_recommend`：Taric 提供建议。宿主决定下一步。
- `authorized_autonomous`：宿主声明已经授权。宿主负责执行和再次检查授权。
- `host_hitl`：宿主向用户请求授权。宿主回传授权结果。

这三种模式不会让 Taric 获得目标系统的执行权限。

## 核心限制

- Taric 可通过 `artifact.session.bind` 和 `artifact.store.*` 在显式绑定的任务会话 spool 中保存 opaque 文本或二进制原文；默认 model/MCP、Context、Markdown projection 和 snapshot 不返回原文。
- Artifact spool 仅按 host/operator 显式授权使用。Taric 不解析、执行、解密、扫描或脱敏 payload，也不自动删除、恢复或应用保留期限。
- Taric 不保存凭据或 Token。
- Taric 不扫描或脱敏宿主数据。
- Taric 不发起目标系统请求。
- Taric 不授权高风险动作。
- 当前 Core 使用同步 SQLite API。长时间操作会阻塞调用进程。
- 当前 Context Pack 预算使用序列化后的字符数估算。它不是模型 Token 计数。
- `packages/mcp` 当前只实现模型工具：`context.query`、`resource.query`、`evidence.query`、`proposal.submit`、`checkpoint.propose`、`action.recommend`。
- Pi 1.1.0 的 session/context 注入已支持；proposal/checkpoint/action/result 原生 hooks 仍标为 unsupported。DeepSeek 和 Hermes 仅在 compatibility manifest 声明的生命周期范围内支持，其他能力回退 CLI/MCP。
- 当前跨适配器测试验证共享 Core 行为。它不等于真实宿主环境的端到端兼容认证。

## 主要概念

- **Engagement**：一次有明确范围和规则的测试。
- **Resource**：一个目标资源，例如主机、服务、路由或接口。
- **Observation**：在特定时间、身份和条件下得到的观察。
- **Evidence**：支撑观察或 Finding 的证据记录。大对象可以保留在宿主，也可以按授权写入 Taric 任务会话 spool；领域记录只引用 Artifact，不嵌入正文。
- **Claim**：可以由证据支持或反驳的陈述。
- **Proposal**：agent 提交的候选变更。Proposal 不会直接改变权威记忆。
- **Finding**：经过独立证据审核的安全问题。
- **WorkRun**：宿主启动的一次工作运行。Taric 保存租约、checkpoint 和结果状态。
- **Context Pack**：Taric 按固定读取序号和预算生成的上下文包。

## 核心原则

- **分级信任**：Proposal、机审候选和独立验证记录分别对应 L0、L1、L2，机审通过不是事实证明。
- **零模型直写权威层**：模型只能查询、提交 proposal、提出 checkpoint 和动作建议；admission、checkpoint 提交和高风险授权由受认证的 writer/宿主完成。
- **证据与覆盖优先**：Finding 关联 evidence、来源观察、限制和覆盖维度；阴性结果也作为可审计观察保存。
- **确定性治理与可恢复性**：状态迁移、CAS 冲突、幂等键、租约 fencing、outbox、审计链和 doctor/reconcile 由代码执行。
- **最小投影**：模型上下文只返回字段白名单、Engagement 范围内的数据和宿主批准的 Artifact 引用。
- **不抹历史**：修订、撤回、冲突和影响传播追加审计事件，物化投影可从权威状态重建。

## 信任等级

| 等级 | 含义 | 普通召回 |
|---|---|---|
| L0 | 待审核 Proposal | 不显示 |
| L1 | 机审候选 | 只有显式请求时显示，并标记为待验证线索 |
| L2 | 独立验证记录 | 可按 Finding/覆盖规则进入普通召回 |

机器审核不能证明事实正确。L1 不等于已验证 Finding。高风险动作的授权由宿主应用管理。

## 仓库结构

```text
packages/
  core/          SQLite store、身份、校验、Context Pack、适配器接口
  schemas/       JSON Schema v1
  cli/           CLI 包入口和命令清单
  mcp/           可运行的 stdio MCP server；只暴露模型受限工具
  hermes-plugin/ Hermes 0.19.0 生命周期插件，通过认证 Core RPC 接入
docs/
  taric-design.md 设计说明
  taric-api.md    API 边界
  agent-integration.md Agent 接入指南
openspec/
  specs/         当前能力规格
```

`packages/cli` 提供 JSON 命令、配置发现、authority/deployment 诊断和 adapter 管理；`packages/mcp` 提供 stdio JSON-RPC server。Hermes 插件不替换 Hermes MemoryProvider，也不直接打开 authority 数据库。DeepSeek 与共享 PostgreSQL authority 的能力由 compatibility manifest 标为 partial/unsupported。

## 环境要求

- Node.js 22 或更新版本。
- npm 11 或兼容版本。
- Python 3，用于运行 Hermes 插件测试。

Node.js 22 的 `node:sqlite` API 可能显示实验性警告。确认你的运行环境接受此限制。

## 安装和验证

在仓库根目录运行：

```bash
npm ci
npm run typecheck
npm run build
npm test
```

运行 Hermes 插件测试：

```bash
cd packages/hermes-plugin
python3 -m unittest discover -s tests
```

## Core 示例

下面的示例使用公开 Core API 创建本地 authority、初始化 Engagement，并以 operator 身份提交一个 proposal。模型客户端不应直接调用 `AuthorityStore.commit`。

```ts
import { createCoreServiceForPath, createPrincipal, uuidv7 } from "@taric/core";

const engagementId = uuidv7();
const service = createCoreServiceForPath(":memory:");
const operator = createPrincipal("operator", "operator-1", engagementId);
service.init({ id: engagementId, name: "example engagement" });

const response = service.submitProposal(operator, {
  engagement_id: engagementId,
  subject_type: "resource",
  base_version: 0,
  content: { id: uuidv7(), engagement_id: engagementId, kind: "resource", name: "example.test" }
});

console.log(response);
```

`commit` 是内部 authority 写入 API；模型工具不得直接暴露。生产接入应使用 `createCoreService` 配合受认证 transport principal，或使用 CLI/MCP/adapter 契约。

要保存模型生成的内容，请先使用 `submitProposal`。再由非 LLM writer 执行 admission。生产环境仍需接入受认证的 writer service。

示例使用 `:memory:` 数据库。要保留数据，请传入数据库文件路径：

```ts
const service = createCoreServiceForPath("./data/taric.sqlite");
```

## 文档章节

- [设计说明：边界、目标、架构约束和差距评审](docs/taric-design.md)
- [API 边界：模型、宿主、恢复和投影合同](docs/taric-api.md)
- [Agent 接入指南：支持矩阵、配置、原生 adapter 和后续 release gate](docs/agent-integration.md)
- [多主机 authority runbook：仅适用于显式启用的 PostgreSQL profile](docs/multi-host-authority-runbook.md)
- [OpenSpec 规格：领域和变更的规范文档](openspec/specs/)
