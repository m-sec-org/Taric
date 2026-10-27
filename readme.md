# Taric

Taric 是一个面向多智能体渗透测试的长期记忆与协作扩展。Core 提供版本化的 Engagement 权威状态、提案治理、证据引用、覆盖评估、任务租约、checkpoint、审计恢复、Context Pack 和可重建投影；CLI、MCP 与宿主 adapter 共享同一套 API 合同。

Taric 作为独立插件或扩展，自身不运行模型，不决定启动时机，不启动或调度 agent，不执行目标系统操作。宿主应用负责 agent 调度、工具调用和动作授权。Artifact 可由宿主外部管理；宿主也可显式授权 Taric 在已绑定的任务会话 spool 中保存 opaque 原始内容。凭据生命周期、内容脱敏和保留期限仍由宿主/operator 负责。

Taric 不能消除模型错误、观测遗漏或目标执行风险；它将权威记忆变更、证据绑定、覆盖状态和执行归属保存在可审计状态中，并为冲突、过期租约和恢复提供确定性检查。

## 当前合同与验证状态

- CLI、Core、Bun SQLite driver、MCP 和 Schemas runtime components 为 `1.0.1`；root workspace 和 Hermes plugin 仍为 `1.0.0`。API contract `1.2.0`，schema `1.0.0`，authority storage contract `authority-storage/3`。
- Schema registry 暴露 57 个 operations；CLI 白名单为 49 项（包括本地 `artifact.store.append-file` helper），MCP 仅暴露 6 个模型工具。这些入口的权限和操作集合不同，不能互相推导。
- 本轮 `1.0.1` 验证（2026-10-27）：build、typecheck、兼容矩阵和 PostgreSQL 配置下的全 workspace 测试通过；Core 356/356（无 PostgreSQL 跳过），Schemas 10、CLI 37、MCP 12、Hermes 5、Bun driver 11 全部通过。PostgreSQL runtime、独立备份恢复、双容器租约回收和容器 spool 检查均通过。
- 当前源码在 OrbStack PostgreSQL 17.11 上通过 12/12 runtime scenarios、`enabled/ready` readiness 和独立 `pg_dump`/`pg_restore`；两个独立 host 容器通过共享 PostgreSQL bridge 网络验证并发单 owner lease、容器结束后 reclaim 和旧 generation fencing；两个 Node 22 容器通过同一 bind-mounted spool 的写入、替换与原字节校验。`1.0.1` 专项报告为 `/tmp/taric-postgres-runtime-current-20261027-1.0.1.json`、`/tmp/taric-multihost-current-20261027-1.0.1.json` 和 `/tmp/taric-container-spool-current-20261027-1.0.1.json`。容器运行在同一工作站，未验证跨物理机或网络中断恢复。
- Pi/DeepSeek/Hermes adapter 合同、Bun driver、Hermes plugin 和 gateway 测试均通过；另在 `/tmp` 隔离安装并启动真实 Pi 1.4.0 RPC 进程，Taric 扩展成功通过其 `ExtensionAPI` 注册。本机 smoke 未调用模型或工具；DeepSeek/Hermes 真实宿主及完整 Pi 工作流仍未认证。Gateway 保留本机 Unix socket，并支持可选 TLS TCP 长连接 JSON-RPC 和 HTTPS `POST /rpc`；loopback TLS 端到端测试通过。HTTPS 不提供连接订阅；远程文件路径摄取拒绝，Artifact session root 由 gateway 在其配置的 content root 内派生。多机生产部署仍须单独验收证书、网络、凭据轮换和服务可用性。PostgreSQL runtime 仍要求当前构建匹配的 activation evidence 及目标 schema/lease health；npm registry 分发未支持，workspace 包保留 `private: true`。
- 质量评估算法已实现；pinned fixture 为 30 条 synthetic samples，人工标注样本为 0。`quality.full_statistical_evaluation` 的运行状态保持 disabled，尚无代表性人工基线证据；旧候选报告中的质量发布结论不等于本次 `1.0.1` 的 release report。

此前候选报告及其 profile 状态见[发布验证记录](openspec/changes/harden-taric-authority-runtime/release-report.md)和[机器报告](openspec/changes/harden-taric-authority-runtime/release-report.json)；二者均绑定旧工作树。


## 设计边界

| Taric 负责 | 宿主应用负责 |
|---|---|
| 保存版本化的 Engagement 记忆 | 启动和调度 agent |
| 区分待审提案、机审候选和独立验证记录 | 调用渗透测试工具 |
| 记录证据引用和测试覆盖状态 | 决定高风险动作是否允许 |
| 管理 WorkRun、checkpoint 和 handoff 状态 | 选择自主执行或 HITL 流程 |
| 按授权在任务会话 spool 保存 opaque Artifact 原始字节 | 管理 Artifact 脱敏、凭据生命周期和保留策略 |
| 记录宿主回传的动作决定和结果 | 管理凭据、审批人身份和用户授权 |

Core 的默认权威边界是单主写入的 SQLite WAL authority；多主机使用显式的 `multi_host_authority` PostgreSQL profile。SQLite 和 PostgreSQL 共用 Core 治理逻辑，但 PostgreSQL runtime 默认关闭，只有当前构建匹配的 conformance report、schema 和 lease health 全部通过才会启用。所有 canonical 写入经过 Core service、身份校验、schema/状态机/版本检查和审计事件；Markdown、Git、Context Pack、JSON/JSONL snapshot 都是派生结果。可选 Artifact spool 的 payload 文件位于配置的内容根目录，不嵌入 authority 数据库、审计事件或模型输出。模型调用、worker 调度和目标系统请求不进入 Core。

远程 gateway 是可选 API 传输拓扑，不提供共享状态正确性；多主机事务、租约和 fencing 仍由各 Core 共用的 PostgreSQL authority 协调。各 host 可直连 PostgreSQL，也可通过 TLS TCP/HTTPS gateway 访问 Core API，由 gateway 集中持有数据库凭据。远程 host 的文件系统不与 gateway 共享：path-based Artifact ingestion 不接受远程路径，Artifact bytes 通过受限 JSON-RPC operations 传输（每帧最多 1 MiB）或由宿主外部管理。

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
- 默认 Node SQLite driver 使用同步 `node:sqlite`。Core 方法返回 Promise，但底层 SQL 和部分文件阶段仍同步，长时间操作会阻塞调用进程；注入 Bun SQLite driver 不会加载 Node SQLite driver。
- 当前 Context Pack 预算使用序列化后的字符数估算。它不是模型 Token 计数。
- `packages/mcp` 当前只实现模型工具：`context.query`、`resource.query`、`evidence.query`、`proposal.submit`、`checkpoint.propose`、`action.recommend`。
- Pi 1.4.0 的 proposal/checkpoint/action/result/error hooks 在受测 native adapter contract 范围内已支持；实际可用能力取决于该 adapter 实例完成注册，其中 checkpoint 和 host result 还要求对应 callback 与有效 WorkRun binding。此合同测试不等于外部宿主进程或生产环境认证。DeepSeek Harness 0.2.0-rc.2 / Cordis 4.0.4 和 Hermes 0.19.0 仅在 compatibility manifest 声明的生命周期范围内支持，未覆盖的能力回退 CLI/MCP。
- `capability.status` 从统一兼容清单生成状态，并可依据通过校验的 PostgreSQL readiness 与 digest-pinned quality release report 动态更新相应 capability；它不代表 adapter 实例已注册。Core 的 `adapter.status` 比较已配置版本与清单，并将外部实例注册/健康标为 `not_observed`。合同测试不等于真实第三方宿主环境认证。

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
  core/          SQLite/PostgreSQL authority、治理、Context、Artifact、adapter/runtime
  schemas/       JSON Schema v1
  driver-bun-sqlite/ Bun 进程内 SQLite reference driver
  cli/           CLI 包入口和命令清单
  mcp/           可运行的 stdio MCP server；只暴露模型受限工具
  hermes-plugin/ Hermes 0.19.0 生命周期插件，通过认证 Core RPC 接入
docs/
  taric-design.md 设计说明
  taric-api.md    API 边界
  agent-integration.md Agent 接入指南
openspec/         活动变更、归档变更与候选发布证据
```

`packages/cli` 提供 JSON 命令、配置发现、authority/deployment 诊断和 adapter 管理；`packages/mcp` 提供 stdio JSON-RPC server。Hermes 插件不替换 Hermes MemoryProvider，也不直接打开 authority 数据库。DeepSeek、Hermes 和共享 PostgreSQL authority 的实际覆盖范围由 compatibility manifest 和运行时 readiness 报告决定。

版本和 operation 清单以 [`compatibility-matrix.json`](compatibility-matrix.json) 与 [`packages/schemas/src/registry.ts`](packages/schemas/src/registry.ts) 为准。Core 常用入口为 `createCoreServiceForPath`、`createCoreService`、`openRuntimeService` 和 `CoreService.dispatch`；分页、coverage snapshot、WorkRun transition、订阅与 Artifact 的函数索引见[代码设计](docs/taric-design.md)及[API 边界](docs/taric-api.md)。

## 环境要求

- Node.js 22（当前验证版本为 22.21.1）或更新版本。
- npm 11 或兼容版本。
- Python 3，用于运行 Hermes 插件测试。
- PostgreSQL 14–18，仅在启用 `multi_host_authority` profile 时需要；该 profile 还要求匹配当前构建的 activation evidence 和健康的 schema/lease 状态。

Node SQLite driver 在 Node 22.21.1 上经过验证，`node:sqlite` 可能显示实验性警告。Core 延迟加载该 driver；Bun 进程内接入可注入 `@taric/driver-bun-sqlite`。

## 安装和验证

在仓库根目录运行：

```bash
npm ci
npm run build
npm run typecheck
npm run verify:matrix
npm test
node scripts/check-doc-links.mjs
node --test scripts/test/profile-verification.test.mjs
```

生成一份新的完整候选验证报告（需本机 OrbStack PostgreSQL 已启动）可运行：

```bash
TARIC_TEST_DATABASE_URL=postgresql://taric:taric-local-only@127.0.0.1:55432/taric \
TARIC_TEST_POSTGRES_CONTAINER=taric-authority-postgres-1 \
node scripts/verify-release.mjs --output /tmp/taric-release-report-1.0.1.json
```

`npm test` 会运行各 workspace 的 Node 测试和 Hermes 插件的 Python 测试。单独运行 Hermes 插件测试：

```bash
python3 -m unittest discover -s packages/hermes-plugin/tests
```

构建后可直接查看 CLI 清单并检查本地 authority：

```bash
node packages/cli/dist/bin.js --help
node packages/cli/dist/bin.js capability.status
```

CLI 形式为 `taric <operation> [json]`；成功响应写 stdout，失败响应写 stderr。默认数据库路径为 `~/.taric/authority.sqlite`，可用 `TARIC_DB` 和 `TARIC_CONTENT_ROOT` 显式指定。

Gateway 的 transport 配置和 authority runtime 配置是两个文件：`--config <gateway.json>` 只选择 listener、TLS material 和固定 token 表，`--runtime-config <runtime.json>` 选择 authority、content root 和 process principal。显式 runtime 文件不存在、JSON 无效或 authority 不兼容时，gateway 会在绑定 listener 前失败，不会退回 workspace 或 home 配置，也不会把 `TARIC_DB`、`TARIC_CONTENT_ROOT` 等 ambient 值合并进这次启动。省略 `--runtime-config` 时保留兼容发现顺序：`TARIC_CONFIG` → 当前工作目录 `.taric/config.json` → `$HOME/.taric/config.json`，只使用第一个存在的文件；没有文件时使用默认 SQLite 路径。启动诊断记录 `explicit`、`environment`、`workspace`、`home` 或 `default` 来源和不含秘密的 SHA-256 digest，远程状态只应返回来源类别和 digest，不返回路径、连接串或 token。authority、content root 和 principal policy 在 gateway 进程生命周期内固定；切换配置应停止并重新启动进程。回滚显式部署时，先恢复旧 runtime 文件并重启，再移除 `--runtime-config` 回到上述兼容发现顺序。

## Core 示例

下面的示例使用公开 Core API 创建本地 authority、初始化 Engagement，并以 operator 身份提交一个 proposal。模型客户端不应直接调用 `AuthorityStore.commit`。

```ts
import { createCoreServiceForPath, createPrincipal } from "@taric/core";

const service = await createCoreServiceForPath("./data/taric.sqlite");
const init = await service.init({
  name: "example engagement",
  scope: {
    allowed_targets: ["https://example.test"],
    excluded_targets: [],
    rules_of_engagement_ref: "roe:example"
  }
});
if (!init.ok) throw new Error(init.error.message);
const engagementId = String(init.data.id);
const operator = createPrincipal("operator", "operator-1", engagementId);

const response = await service.submitProposal(operator, {
  engagement_id: engagementId,
  subject_type: "claim",
  expected_version: 0,
  content: {
    schema_version: "1.0.0",
    engagement_id: engagementId,
    kind: "claim",
    proposition: "example.test is in scope",
    status: "proposed",
    evidence_refs: [],
    limitations: ["awaiting verification"]
  }
});

console.log(response);
await service.close();
```

`commit` 是内部 authority 写入 API；模型工具不得直接暴露。生产接入应使用 `createCoreService` 配合受认证 transport principal，或使用 CLI/MCP/adapter 契约。

要保存模型生成的内容，请先使用 `submitProposal`。再由非 LLM writer 执行 admission。生产环境仍需接入受认证的 writer service。

测试时可以使用 `:memory:` 数据库；要保留数据，请传入数据库文件路径：

```ts
const service = await createCoreServiceForPath("./data/taric.sqlite");
```

## 文档章节

- [代码设计：架构、数据模型、接口函数与测试索引、Artifact 和发布门槛](docs/taric-design.md)
- [API 边界：模型、宿主、恢复和投影合同](docs/taric-api.md)
- [Agent 接入指南：CLI、MCP、Pi、Hermes 和 DeepSeek](docs/agent-integration.md)
- [authority 存储 runbook：单机维护、doctor 和基准](docs/authority-storage-runbook.md)
- [Context recovery：游标密钥、resume 和性能约束](docs/context-recovery.md)
- [PostgreSQL 本地部署](docs/postgres-local-deployment.md)
- [PostgreSQL runtime readiness](docs/postgres-runtime-readiness.md)
- [多主机 authority runbook：仅适用于显式启用的 PostgreSQL profile](docs/multi-host-authority-runbook.md)
- [OpenSpec 变更与规格文档](openspec/changes/)
