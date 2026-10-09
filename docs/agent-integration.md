# Taric Agent 接入指南

本指南说明 agent host 如何接入 Taric Core。

Taric 当前提供 API 和 adapter 基础接口。当前版本没有可运行的 MCP server。Pi 和 DeepSeek Harness 包装器也没有真实宿主 hook 安装逻辑。请把本指南作为集成契约和当前原型说明。不要将示例视为可直接安装的生产插件。

本指南按 ASD-STE100 的简明写作原则编写。句子尽量简短。每个步骤只说明一个动作。本文是中文指南，不是 ASD-STE100 正式合规文件。

## 1. 接入边界

Taric 管理长期记忆和协作状态。宿主管理模型、agent 生命周期和工具执行。

宿主还管理以下内容：

- Artifact 原文、保存期限和脱敏。
- 凭据保存和注入。
- 高风险动作的授权。
- HITL 用户交互和审批人身份。
- 网络请求、扫描器和其他目标系统工具。

Taric 不执行目标动作。Taric 的动作建议不代表授权。

## 2. 选择接入方式

| 方式 | 可用能力 | 当前实现状态 |
|---|---|---|
| Core API | SQLite store、Proposal、Context Pack、WorkRun、投影 | 当前可通过 TypeScript workspace 使用 |
| Native adapter | session hook、context 注入、checkpoint 和结果回传 | 有 Pi 和 DeepSeek facade；没有真实宿主 hook 安装 |
| Hermes plugin | Python general plugin 生命周期事件转换 | 有基础转换函数；未连接 Taric RPC |
| MCP fallback | 跨框架查询和提案接口 | 有工具名称清单；当前没有 MCP server 实现 |
| CLI | operator 命令 | 有命令名称清单；当前没有可执行 CLI 实现 |

如果你需要可运行的网络服务或 MCP server，请先实现对应 transport。不要把 `modelTools` 数组当作 server。

## 3. 安装依赖

在仓库根目录运行：

```bash
npm ci
npm run build
```

Workspace 使用 Node.js 22 或更新版本。SQLite 使用 Node.js 的 `node:sqlite` API。

## 4. 创建 Core store

Core 默认创建内存数据库：

```ts
import { AuthorityStore } from "@taric/core";

const store = new AuthorityStore();
```

需要持久化时，传入文件路径：

```ts
const store = new AuthorityStore("./data/engagement.sqlite");
```

创建一个 `AuthorityStore` 实例，并由一个 Taric service 负责写入。多个本地 adapter 可以连接同一 service。不要让多个 host 进程各自写不同的 SQLite 文件，再尝试合并结果。

使用结束后关闭数据库：

```ts
store.close();
```

## 5. 注册 host adapter

Adapter Contract 当前版本为 `1.0`。Adapter 必须声明它支持的 capability。

```ts
import { AuthorityStore, createPiAdapter } from "@taric/core";

const store = new AuthorityStore("./data/engagement.sqlite");
const adapter = createPiAdapter(store, "host-version");
```

DeepSeek Harness 使用单独的版本参数：

```ts
import { createDeepSeekHarnessAdapter } from "@taric/core";

const adapter = createDeepSeekHarnessAdapter(store, "pinned-harness-version");
```

当前 factory 返回 Core facade。它不会注册真实宿主 hook。部署时必须对实际 host version 运行 adapter contract tests。

## 6. 提交 Proposal

模型产生的观察或修订必须先进入 Proposal。模型不得直接调用 `store.commit`。

```ts
import { uuidv7 } from "@taric/core";

const proposal = store.submitProposal({
  engagement_id: engagementId,
  subject_type: "claim",
  base_version: 0,
  content: {
    id: uuidv7(),
    engagement_id: engagementId,
    kind: "claim",
    proposition: "The observed page exposes an administrative link."
  }
});
```

Proposal 默认状态为 `pending`。Core 为内容计算 SHA-256 摘要。

非 LLM writer 可以执行 admission：

```ts
const result = store.admitProposal(proposal.id, "sha256:policy-digest", {
  validate: (content) => content.engagement_id === engagementId ? undefined : "engagement mismatch"
});
```

Admission 会检查 base version，并运行调用方提供的确定性验证函数。生产服务还必须校验 schema、scope、引用和权限。当前 Core 不提供完整的 Rules of Engagement 策略引擎。

## 7. 查询和构建 Context Pack

普通查询不会返回 L0 Proposal，也不会返回 L1 候选。显式请求时才可包含候选：

```ts
const verifiedAndOrdinary = store.list(engagementId);
const withCandidates = store.list(engagementId, { includeCandidates: true });
```

创建有预算的 Context Pack：

```ts
import { buildContextPack } from "@taric/core";

const pack = buildContextPack(store, engagementId, 12000, {
  includeCandidates: false
});
```

`budget` 当前按 JSON 序列化后的字符数估算。它不是 Token 数。超预算项会被省略。结果会包含 `omitted_as_unexamined` 和 cursor。

宿主只应传入允许共享的 Artifact 引用。不要把 Artifact 原文或凭据放入 Context Pack。

## 8. WorkRun 和 checkpoint

宿主创建并调度 worker。宿主可以向 Taric claim 一个 WorkRun：

```ts
const lease = store.claimWorkRun({
  work_item_id: workItemId,
  engagement_id: engagementId,
  host_id: "pi",
  agent_id: "worker-1",
  ttl_ms: 60_000
});
```

提交 checkpoint 时，使用当前 generation：

```ts
const checkpoint = store.commitCheckpoint(
  lease.run_id,
  lease.generation,
  "pi",
  {
    completed_steps: ["route inventory"],
    pending_steps: ["review access-control coverage"],
    evidence_refs: []
  }
);
```

旧 generation 的 checkpoint 会被拒绝。Checkpoint 只保存可恢复的工作状态。不要放入模型隐藏推理。

恢复时，host 先取得 resume packet：

```ts
const packet = store.resumePacket(lease.run_id, "pi");
```

若外部动作结果未知，Taric 会记录状态供 host 对账。Taric 不会重放目标动作。

## 9. 动作模式和宿主结果

宿主为 Engagement 选择一种模式：

- `llm_recommend`：Taric 只给建议。
- `authorized_autonomous`：宿主根据自己的策略执行。
- `host_hitl`：宿主向用户请求授权。

记录模式和状态：

```ts
store.recordActionIntent({
  run_id: lease.run_id,
  generation: lease.generation,
  mode: "host_hitl",
  status: "authorized",
  host_decision_ref: "host-approval-reference"
});
```

Taric 不验证人工身份。Taric 不签发授权。宿主必须在实际工具调用时再次检查授权和 scope。

## 10. Markdown 投影

投影函数会生成 `STATE.md` 和 `index.md`。投影使用字段白名单。

```ts
import { publishProjection, readProjection } from "@taric/core";

const projection = await publishProjection(store, {
  engagementId,
  outputDir: "./engagement-view"
});

const state = await readProjection(projection.files[0], true);
```

没有读取权限时，`readProjection` 会拒绝请求。当前投影函数不会自动创建 Git commit，也不会推送远端。`remotePushAllowed` 只报告配置条件是否齐全。调用方仍需执行实际 secret scan 和远端推送流程。

## 11. Hermes General Plugin

Hermes 插件当前只翻译以下 hook 名称：

- `pre_llm_call`
- `pre_tool_call`
- `post_tool_call`
- `on_session_end`

插件不替换 Hermes external MemoryProvider。插件也未连接 Taric RPC。宿主需实现传输、错误处理、身份映射和 lifecycle 注册。

运行插件单元测试：

```bash
cd packages/hermes-plugin
python3 -m unittest discover -s tests
```

## 12. 运行验证

在仓库根目录运行：

```bash
npm ci
npm run typecheck
npm run build
npm test
```

当前测试验证 Core API、存储状态、schema fixture 和 adapter facade。测试不证明真实 Pi、DeepSeek Harness 或 Hermes runtime 的端到端兼容性。
