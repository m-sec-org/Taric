# Taric

Taric 是一个面向多智能体渗透测试的长期记忆扩展。

Taric 保存测试范围、资源、观察、证据引用、Finding 和任务状态。它帮助多个 agent 在不同会话中共享已审核的信息。

Taric 不运行模型。Taric 不启动 agent。Taric 不执行目标系统的操作。

宿主应用负责 agent 调度、工具调用和动作授权。宿主也负责 Artifact 内容、凭据、保留期限和脱敏。

本文使用 ASD-STE100 的简明写作原则。文档使用短句。每个段落说明一个主题。技术名词保持固定。本文是中文说明，不是 ASD-STE100 英文合规文件。ASD-STE100 将写作规则和受控词典作为标准的一部分。[官方说明](https://www.asd-ste100.org/STE_faq.html)


## 设计边界

| Taric 负责 | 宿主应用负责 |
|---|---|
| 保存版本化的 Engagement 记忆 | 启动和调度 agent |
| 区分待审提案、机审候选和独立验证记录 | 调用渗透测试工具 |
| 记录证据引用和测试覆盖状态 | 决定高风险动作是否允许 |
| 管理 WorkRun、checkpoint 和 handoff 状态 | 选择自主执行或 HITL 流程 |
| 生成受字段白名单控制的 Markdown 投影 | 保存、脱敏和删除 Artifact 内容 |
| 记录宿主回传的动作决定和结果 | 管理凭据、审批人身份和用户授权 |

Taric 支持三种动作协作模式：

- `llm_recommend`：Taric 提供建议。宿主决定下一步。
- `authorized_autonomous`：宿主声明已经授权。宿主负责执行和再次检查授权。
- `host_hitl`：宿主向用户请求授权。宿主回传授权结果。

这三种模式不会让 Taric 获得目标系统的执行权限。

## 主要概念

- **Engagement**：一次有明确范围和规则的测试。
- **Resource**：一个目标资源，例如主机、服务、路由或接口。
- **Observation**：在特定时间、身份和条件下得到的观察。
- **Evidence**：支撑观察或 Finding 的证据记录。大对象保存在宿主中。Taric 保存引用。
- **Claim**：可以由证据支持或反驳的陈述。
- **Proposal**：agent 提交的候选变更。Proposal 不会直接改变权威记忆。
- **Finding**：经过独立证据审核的安全问题。
- **WorkRun**：宿主启动的一次工作运行。Taric 保存租约、checkpoint 和结果状态。
- **Context Pack**：Taric 按固定读取序号和预算生成的上下文包。

## 信任等级

| 等级 | 含义 | 普通召回 |
|---|---|---|
| L0 | 待审核 Proposal | 不显示 |
| L1 | 机审候选 | 只有显式请求时显示，并标记为待验证线索 |
| L2 | 独立验证记录 | 可按 Finding 规则使用 |

机器审核不能证明事实正确。L1 不等于已验证 Finding。高风险动作的授权由宿主应用管理。

## 仓库结构

```text
packages/
  core/          SQLite store、身份、校验、Context Pack、适配器接口
  schemas/       JSON Schema v1
  cli/           CLI 包入口和命令清单
  mcp/           当前支持的模型工具清单
  hermes-plugin/ Hermes general plugin 基础包
docs/
  taric-design.md 设计说明
  taric-api.md    API 边界
  agent-integration.md Agent 接入指南
openspec/
  specs/         当前能力规格
```

`packages/cli` 和 `packages/mcp` 当前没有可执行 server。仓库中的命令和工具清单说明设计边界，不表示已经提供完整运行时。

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

下面的示例创建一个内存数据库，并写入一个 Core 记录：

```ts
import { AuthorityStore, uuidv7 } from "@taric/core";

const store = new AuthorityStore();
const engagementId = uuidv7();

const record = store.commit(
  {
    id: uuidv7(),
    engagement_id: engagementId,
    kind: "resource",
    name: "example.test"
  },
  "L2"
);

console.log(record.display_id);
store.close();
```

`commit` 是 Core 写入 API。模型工具不得直接暴露该方法。

要保存模型生成的内容，请先使用 `submitProposal`。再由非 LLM writer 执行 admission。生产环境仍需接入受认证的 writer service。

示例使用 `:memory:` 数据库。要保留数据，请传入数据库文件路径：

```ts
const store = new AuthorityStore("./data/taric.sqlite");
```

## 核心限制

- Taric 不保存 Artifact 原文。
- Taric 不保存凭据或 Token。
- Taric 不扫描或脱敏宿主数据。
- Taric 不发起目标系统请求。
- Taric 不授权高风险动作。
- 当前 Core 使用同步 SQLite API。长时间操作会阻塞调用进程。
- 当前 Context Pack 预算使用序列化后的字符数估算。它不是模型 Token 计数。
- 当前跨适配器测试验证共享 Core 行为。它不等于真实宿主环境的端到端兼容认证。

## 文档

- [设计说明](docs/taric-design.md)
- [API 边界](docs/taric-api.md)
- [Agent 接入指南](docs/agent-integration.md)
- [OpenSpec 规格](openspec/specs/)
