# Taric

Taric 是面向多智能体安全测试的长期记忆与治理组件。它为宿主保存可审计、可恢复的项目状态，并提供受控的提案、证据、覆盖和执行协作接口。Taric作为独立插件或扩展不运行模型、不启动或调度 agent、不调用目标系统，也不替宿主授权动作。

## 当前版本

| 合同 | 当前版本 |
|---|---|
| Taric workspace 与运行组件 | `1.0.4` |
| Core API | `1.4.0` |
| Host adapter | `1.1` |
| Record schema | `1.0.0` |
| Authority storage | `authority-storage/4` |
| SQL layout | `authority-sql/4` |

API 使用精确版本配对。声明 `1.3.0` 或更早 API 的客户端不会与当前 `1.4.0` Core 配对。workspace 包标记为 private，当前不通过 npm registry 发布。完整操作、驱动与宿主版本清单见 [`compatibility-matrix.json`](compatibility-matrix.json)。

当前版本要求每个可执行 WorkRun 先绑定已批准且在有效期内的 ScopeRevision；旧 Scope 或缺少 revision 绑定的运行不能 claim、续租、推进、写 checkpoint/Action 或发布 run-bound Artifact。

## 能力

- **权威记忆与治理**：Engagement 隔离的版本化记录、提案与信任等级、Admission、独立 Review、Evidence/Finding 引用、Resource 修订、关系与影响查询。模型提交的是候选，不会直接写入已验证事实。
- **授权范围**：不可变 ScopeRevision 将规范化的目标、协议、端口、方法、DNS/redirect 限制和有效期绑定到已提交且完整性验证的 ROE Artifact。Scope 更新和失效保留历史，并通过 `scope.revise`、`scope.invalidate` 与 `scope.query` 管理。
- **覆盖评估**：Coverage manifest 固定预期测试维度及 ScopeRevision/ResourceRevision。固定水位的 `coverage.snapshot` 与 `coverage.gate` 返回域完整性、缺失项、状态缺口、可见性和截断信息。Recall 结果不能代替完整域判断。
- **工作恢复**：WorkItem、带租约的 WorkRun、Attempt、generation fencing、Checkpoint、恢复检查和幂等状态迁移。Taric 保存工作状态；宿主决定何时创建、调度、停止或恢复 worker。
- **动作审计**：模型可提交 Action 建议，可信宿主可回传授权决定、执行结果或不确定状态。`action.audit.query` 按固定水位读取追加式历史；迟到结果会被隔离。Taric 不执行或重试目标请求。
- **报告与关闭**：宿主生成并提交报告 Artifact；`report.snapshot.commit` 验证其与 Scope、manifest、ResourceRevision、Coverage、Evidence 及 Artifact 的绑定。`engagement.close` 通过版本和 authority 水位 CAS 写入 CloseDecision；`engagement.reopen` 以新决策 supersede 当前关闭事实。
- **内容与维护**：可选的任务会话 Artifact spool、外部 Artifact 引用、审计校验、doctor/reconcile、固定读取、分页 Context Pack 与可重建投影。Artifact 正文默认不进入模型视图或派生投影。

## 运行与接口支持

| 接口或部署 | 当前支持状态 | 支持范围与条件 |
|---|---|---|
| Node Core + SQLite | 默认支持 | 单主机持久 authority，使用 SQLite WAL 和 Core 共享治理逻辑。不要把 SQLite 文件放到多主机共享存储上。 |
| Bun in-process | 支持 | 使用匹配版本的 `@taric/driver-bun-sqlite` 注入 Core；已覆盖共享 authority 场景和驱动专项测试。 |
| PostgreSQL 多主机 | 有条件支持 | PostgreSQL 14–18 的实现复用同一 Core；默认关闭。启用需要当前构建匹配的 conformance evidence，以及部署端 schema、连接和 lease fencing 健康检查。本轮 `1.0.4` 未运行 live PostgreSQL 场景。 |
| CLI | 支持 | operator/host 本地 JSON 命令；当前白名单含 60 项，包括本地文件上传 helper。 |
| MCP stdio | 模型受限支持 | MCP `2024-11-05`，仅提供六个工具：`context.query`、`resource.query`、`evidence.query`、`proposal.submit`、`checkpoint.propose`、`action.recommend`。不暴露 admission、operator、原始 Artifact 读取或宿主状态操作。 |
| Unix socket proxy | 可选支持 | 单一固定 host principal 的本机 RPC。 |
| TLS TCP / HTTPS gateway | 可选支持 | TLS TCP JSON-RPC 支持连接订阅；HTTPS `POST /rpc` 是请求/响应接口，不提供订阅。远程客户端不能用 gateway 主机路径执行文件摄取。 |

Schema registry 当前包含 66 个 Core operations。CLI、MCP 与 Core registry 的权限和操作集合不同；某个接口未暴露某项操作不代表 Core 未实现该操作。

## Host adapter 状态

适配器清单只声明固定版本和已实现的 hook 范围，不表示第三方进程当前在线或已完成生产认证。真实运行能力还取决于宿主是否注册 adapter、提供对应 callback 和有效的 WorkRun binding；`adapter.status` 对无法观察的进程状态返回 `not_observed`。

Pi 1.4.0 的 proposal/checkpoint/action/result/error hooks 在 adapter contract 范围内已支持；绑定和运行能力仍由宿主实例提供。

| 宿主 | 固定版本 | 当前支持范围 |
|---|---|---|
| Pi | `1.4.0` | proposal/checkpoint/action/result/error hooks 已支持；能力依赖 adapter 注册和宿主提供有效 callback/WorkRun binding。该合同支持不表示完整 agent、调度、工具授权工作流已认证。 |
| DeepSeek Harness / Cordis | `0.2.0-rc.2` / `4.0.4` | 当前 adapter profile 为 session lifecycle；不提供 native Context、checkpoint、action 或 result bridge。 |
| Hermes | `0.19.0` | 通用插件 hook，支持声明的 Context、session 与工具观察范围；不替换 Hermes MemoryProvider，也不自动完成 proposal、checkpoint 或 result capture。 |

自定义 adapter descriptor 可用于建立集成身份，但不会自动认证新宿主或授予额外操作权限。完整 hook 对应关系见 [Agent 接入指南](docs/agent-integration.md)。

## 责任边界

Taric 负责记录宿主提交的授权范围、记忆、证据、覆盖、执行归属、动作回报和关闭决策。宿主仍负责：

- 模型调用、agent 生命周期、worker 调度和工具运行；
- 每个目标动作的授权、网络出口限制和执行结果真实性；
- 报告内容的生成及 Artifact 内容的保留、备份和访问控制；
- 目标凭据与 Taric gateway、数据库、TLS 等接入凭据的 ACL、加密、轮换、撤销和保留策略；
- 用户身份、人工审批、生产部署和灾难恢复验收。

经宿主明确授权后，Taric 可以将任务目标凭据作为 opaque Artifact 字节保存并通过独立 `content_read` grant 读回。Taric 不解密、扫描、脱敏或管理这些凭据，也不保证 Artifact payload 的保留期限。Taric 接入凭据与目标凭据属于不同信任边界，不应放进任务 Artifact 或模型视图。

## 未启用或未认证

- `quality.full_statistical_evaluation` 当前保持 disabled；虽然评估算法已实现，但尚缺满足发布门槛的人工标注和基线证据。
- PostgreSQL runtime 不会仅因配置连接串而启用；缺少当前构建的 conformance evidence 或部署健康检查时会 fail closed。
- adapter 合同测试和宿主加载 smoke 不等于完整第三方工作流、人工审批或生产环境认证。当前矩阵所列 host support 需结合上表 hook 范围理解。
- 本地测试不证明跨物理机 PostgreSQL 协调、网络分区恢复、生产 egress/凭据策略或 BreachWeave host acceptance。当前验证报告列出的 live PostgreSQL 可选测试因未配置测试数据库而跳过。
- 公共 `snapshot.import`、`migration`、`remote.push` 和 `full_quality_evaluation` 操作不受支持。authority restore 属于隔离的 operator recovery 流程，不是宿主迁移 API。

## 构建与验证

需要 Node.js 22 或更新版本；Bun in-process 部署另需 Bun。PostgreSQL 仅在启用多主机 profile 时需要。

```sh
npm ci
npm run build
npm run typecheck
npm test
npm run verify:matrix
node scripts/check-doc-links.mjs
```

当前工作树的构建、typecheck、本地 workspace 测试、兼容矩阵和 clean-consumer 检查结果见[控制面验证记录](docs/taric-103-breachweave-control-plane-verification.md)。

## 深入文档

- [Core API 与操作边界](docs/taric-api.md)
- [Agent 与宿主接入](docs/agent-integration.md)
- [存储驱动合同](docs/authority-driver-guide.md)
- [部署与集成 profile](docs/host-integration-profiles.md)
- [Taric 设计说明](docs/taric-design.md)
