# 宿主接入与部署

本指南面向智能体研发人员和平台工程师，说明如何把 Taric 接入现有 agent 宿主。Taric 保存长期记忆、治理决定和运行恢复状态；宿主负责模型调用、worker 调度、工具执行、人工审批、目标网络访问和凭据管理。Taric 不执行目标动作，也不授予动作授权（`does not execute a target action or grant authorization`）。Artifact 原文、保留期限和脱敏（`Artifact bodies, retention, and redaction`）由宿主负责。

## 选择接入方式

| 接入方式 | 适用情况 | 身份边界 |
| --- | --- | --- |
| Node 进程内 Core | 宿主是 Node 服务，想减少 RPC 跳转 | 宿主通过可信代码创建 principal，并保护 Core 对象 |
| Bun 进程内驱动 | 宿主是 Bun，需要本地 SQLite | `@taric/driver-bun-sqlite` 注入 Core；治理逻辑仍由 Core 提供 |
| `taric` CLI | 人工运维、脚本、CI、简单宿主集成 | 本机配置决定 principal；默认 operator，不应把 operator 凭据交给模型 |
| `taric proxy` | Bun/Python 等本机宿主需要调用 Node Core | 一个 socket 对应固定 host 身份和 Engagement |
| MCP stdio | MCP 客户端/模型要使用 Taric 工具 | 每个进程绑定一个 principal；模型只拿到被授权的工具 |
| `taric gateway` | 多个远程宿主访问集中部署的 Core | token 固定映射到角色、principal 和可选 Engagement；网络监听必须 TLS |
| 原生 adapter | Pi、DeepSeek Harness、Hermes 等宿主 | adapter 绑定对应宿主回调；具体运行能力仍需宿主注册和有效 WorkRun binding |

SQLite 适用于单机。多个宿主需要共享同一 authority 时使用 PostgreSQL profile；不要把 SQLite 文件放到共享盘或 NFS 上实现多机协调。PostgreSQL 默认不启用，必须通过当前构建对应的 conformance evidence 和部署健康检查。

## 进程内接入

Node 宿主依赖 `@taric/core`，可用 `openRuntimeService` 按受信任配置打开运行时，或在测试/嵌入场景构造 Core service。所有公开业务操作都通过 `service.dispatch(operation, principal, request)`，不要把无身份参数的 `init()`、`status()` 等低层方法直接暴露给模型或网络客户端。

```ts
import { openRuntimeService, createPrincipal } from "@taric/core";

const service = await openRuntimeService();
const model = createPrincipal("model", "agent-worker-17", engagementId);
const result = await service.dispatch("context.query", model, {
  engagement_id: engagementId,
  budget: 6000,
});
```

宿主应保持独立的 operator、host、model、reviewer 和 writer 身份。不要让模型自行指定角色、Engagement、Review attestation 或能力 grant。服务关闭时调用 `service.close()`。

## CLI、本机 proxy 与远程 gateway

CLI 将操作和 JSON 请求转给 Core。成功响应写到 stdout，错误写到 stderr 并返回非零退出码。使用 `taric --help` 查看当前白名单；命令名对应 Core operation，例如：

```sh
taric context.query '{"engagement_id":"<uuid>","budget":6000}'
taric work.query '{"engagement_id":"<uuid>","include_active_runs":true}'
taric artifact.store.append-file '<metadata-json>' ./result.txt
```

`artifact.store.append-file` 在本机流式读取一个不超过 64 MiB 的文件。`taric proxy` 使用环境配置启动固定 host principal 的 Unix socket 服务，可供本机 Bun 或其他语言 client 调用；proxy 是本机桥，不是远程监听器。

远程部署使用 `taric gateway --config <gateway.json> --runtime-config <runtime.json>`。监听器配置和 authority runtime 配置分开管理：前者包含 socket/TLS/token 映射，后者选择数据库、content root、身份和激活上下文。网络 token 至少 32 个字符，并固定映射到 principal；网络监听需要 TLS。TLS TCP 提供连接级 JSON-RPC；HTTPS `POST /rpc` 是请求/响应模式，不提供订阅。远程请求不能用 gateway 主机路径调用文件摄取；大文件应由 gateway 主机可见的 spool 或外部 Artifact 引用承载。

把 gateway token、数据库凭据和 TLS 私钥放在宿主的秘密管理系统中。不要把这些凭据写进 prompt、Artifact 或模型工具参数。集中 gateway 可以让远程宿主无需直接接触数据库凭据；gateway 仍需按角色和 Engagement 配置不同 token。

## MCP 接入与权限

MCP 当前提供 `initialize`、`tools/list` 和 `tools/call`，使用 stdio 与协议版本 `2024-11-05`。`tools/list` 根据 Core registry 及启动 principal 的角色、能力、Engagement 绑定动态生成，并携带 operation request schema。工具输入不能切换身份或扩大授权。

为每个安全主体运行独立 MCP 进程。绑定 Engagement 的默认 model profile 提供 13 个模型工具；显式授予 model 的 `history_read` 后再提供 `history.query`、`artifact.search`、`artifact.history.read` 三个工具。未绑定 Engagement 的 model 看不到 scoped tools。Host、reviewer、writer、operator profile 使用各自的角色和 grant；reviewer 必须由可信配置提供 attestation。`content_read` 只用于 host/operator 读取原始 Artifact，不能由 model 的 `history_read` 替代。

单次调用必须按 `tools/list` 给出的完整 JSON Schema 构造。MCP 在派发前校验，Core 仍会重新检查授权、版本、Engagement、lease 和业务规则。工具响应的外层 `ok` 只说明调用是否成功；Admission 等操作还可能在 `data.ok` 表示业务拒绝，宿主需同时检查两层结果。

## 原文历史检索

只有宿主在 `artifact.store.begin` 中明确声明 `history_content_class: "execution_history"` 的 Taric 本地文本 Artifact 才能建立历史索引。内容提交并通过完整性检查后才可检索。外部引用、二进制、未分类内容和 `task_credential` 不会进入模型可读历史面。

- `history.query`：按 session、WorkRun、Attempt、事件类型分页查看执行记录。
- `artifact.search`：对指定 session 的已索引文本做搜索，返回片段、`content_ref`、字节位置、分页游标和索引完整性信息。
- `artifact.history.read`：按引用和偏移读取有限长度的原文片段；单段最多 16 KiB。

`history_read` 只能在可信配置中授给 model，默认关闭。游标绑定身份、Engagement、session、过滤条件和水位。响应若标记 `incomplete`，说明索引可能滞后或需要维护；不能把暂时没有返回结果解释成完整历史中不存在该信息。

## 宿主工作流

建议按以下顺序接入，而不是只连一个模型工具：

1. **初始化**：可信 operator 创建 Engagement、当前批准的 ScopeRevision、Resource 和 Coverage manifest。
2. **提供上下文**：模型按需调用 `context.query`，遵循固定水位和分页游标；宿主按测试计划挑选要运行的工作。
3. **收集候选和证据**：模型以 `proposal.submit` 提交候选；宿主捕获工具观察和 Evidence。候选只有经过 admission 才成为受治理状态，Finding 晋升还需要规定的独立 review。
4. **运行与恢复**：host 创建并 claim WorkRun，维护 lease、Attempt 和 generation。checkpoint/action/result 都绑定有效运行。宿主授权并执行动作，再回传决定和结果；Taric 不重试目标请求。
5. **评估与关闭**：宿主提交 Coverage 和报告 Artifact；Taric 校验其 Scope、资源修订和水位绑定，再执行 close/reopen 决策。

重启后，宿主分页查找活动 WorkRun，调用 `work.resume` 并遵循返回的 `blocked`、前提检查和 `replan_required`。如果结果不确定，应先由宿主对账，不能因重试而重复执行目标动作。

## 原生宿主适配器

- **Pi**：当前认证版本为 `@earendil-works/pi-coding-agent` `1.5.0`。支持生命周期、Context 注入，以及 proposal/checkpoint/action/result/error 回调；能力依赖扩展在实际 Pi 实例中注册、宿主提供回调和有效 WorkRun binding。认证合同不等于完整模型、调度或目标工具工作流认证。
- **DeepSeek Harness / Cordis**：锁定 `0.2.0-rc.2` / `4.0.4`，支持当前声明的 session lifecycle 范围；不提供原生 Context、checkpoint、action 或 result bridge。
- **Hermes**：插件通过 Core RPC 提供 Context、会话和工具观察；不替换 Hermes MemoryProvider，也不自动完成 proposal、checkpoint 或 result capture。

`adapter.status` 会报告 `instance_registration_state` 和 `runtime_health_state`。若进程不可观察，状态为 `not_observed`，不能把静态合同支持误读为宿主正在运行。

## 运维诊断与支持边界

所有 transport 保留 Core `{ok:false,error}` 响应。集成层应先按 `error.code` 分类，再把安全的诊断细节展示给 operator；不要依赖响应泄漏输入值、secret、SQL、bearer token 或绝对数据库路径。配置错误、authority 不兼容、Schema 不匹配和 conformance 失败都应停止启动或写入。

`storage.postgresql` 有实现，但保持默认关闭；是否启用取决于当前构建的证据和运行健康。`quality.full_statistical_evaluation` 尚未启用，缺少独立人工标注与基线证据。`snapshot.import`、通用 `migration` 和公共 `backup.restore` 不可用；恢复数据库属于 operator 隔离恢复流程，不是宿主迁移 API。remote push 需要 Engagement 授权、真实 scanner 证据和私有仓库（`remote push requires a private repository`）。

兼容矩阵中的能力 ID 与本指南对应如下：`cli.operator`（CLI）、`mcp.stdio_model_tools`（MCP stdio）、`pi_native_adapter`、`pi.session_lifecycle`、`pi.context_injection`、`pi.proposal_checkpoint_action_result_hooks`（Pi adapter）、`artifact.task_session_content`（Artifact）、`deepseek_native_adapter`、`hermes_native_adapter`、`storage.postgresql`、`git.remote_push`、`secrets.external_scanner`、`quality.full_statistical_evaluation` 和 `graph.relation_impact`。这些 ID 只是能力清单，不会绕过角色、grant、Engagement 或部署证据门槛。

详细请求字段见 [API 与 MCP 合同](taric-api.md)，存储和恢复见[运维手册](operations.md)，能力状态见 [`compatibility-matrix.json`](../compatibility-matrix.json)。
