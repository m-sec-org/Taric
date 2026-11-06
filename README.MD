# Taric

Taric 是面向攻防智能体的长期记忆与治理组件。它把 Engagement、目标范围、资源、证据、Finding、覆盖情况、执行进度和审计记录保存为可追溯的权威状态，让多个智能体或多个宿主可以在明确的身份、授权和版本边界内协作。

Taric 不运行模型，不调度 agent，不直接访问目标系统，也不替宿主批准动作。宿主负责模型调用、worker 生命周期、工具执行、人工审批、网络出口和凭据生命周期；Taric 负责保存事实、约束状态迁移、提供恢复信息并记录每次治理决定。

## 本次更新

- **执行历史查询与原文检索**：宿主可以把执行日志或任务输出以 `execution_history` 分类写入 Taric 的文本 Artifact。获得独立 `history_read` 授权的模型可以使用 `history.query`、`artifact.search` 和 `artifact.history.read` 查询事件、搜索片段并分段读取原文。结果带有分页游标、字节偏移和索引水位，能明确区分“没有命中”和“索引尚未完成”。
- **MCP 能力扩展**：MCP 不再固定为少量手工工具，而是根据 Core 的操作注册表，按启动时绑定的身份、角色、能力和 Engagement 自动生成工具目录。绑定 Engagement 的默认 model profile 有 13 个工具，额外授予 `history_read` 后增加 3 个历史工具；host、reviewer、writer、operator 也可用各自授权的固定目录。
- **更严格的权限隔离**：MCP 进程只绑定一个固定 principal，工具参数不能换身份、越权选择 Engagement 或获得 `content_read`。原文历史读取与宿主读取凭据所需的 `content_read` 完全分离，任务凭据和未分类 Artifact 不会进入模型检索面。
- **网关与宿主接入完善**：CLI 下提供固定身份的本机 proxy，以及 token 映射到 principal 的 TLS TCP/HTTPS gateway；Pi、DeepSeek Harness、Hermes 适配器可以把会话、上下文和工具观察接入同一套 Core 治理。
- **运行恢复与审计增强**：ScopeRevision、覆盖快照、WorkRun/Attempt 租约、generation fencing、checkpoint、Action 审计、报告关闭和 reopen 均使用版本或水位校验，异常或过期写入会失败关闭。

当前 workspace 版本为 `1.1.0`，Core API 为 `1.5.0`，adapter 合同为 `1.1`，记录 Schema 为 `1.0.0`，authority storage 为 `authority-storage/5`，SQL 格式为 `authority-sql/5`。workspace 包目前为 private，不代表已发布到 npm。

## 模块与宿主分工

| 模块 | 作用 | 适合的宿主场景 |
| --- | --- | --- |
| `packages/cli`（CLI） | 本机 JSON 命令入口；把命令解析、配置发现、退出码和诊断统一转给 Core。也提供 `taric proxy` 本机 Unix socket、`taric gateway` 远程网关和本地文件流式上传。 | 运行维护、CI、人工复核、脚本化批处理，或不方便直接嵌入 Node 的 agent 宿主。 |
| `packages/core`（Core） | 权威业务层和策略边界：身份/能力授权、Engagement 隔离、版本化记录、Admission、Coverage、WorkRun 恢复、Action 审计、Artifact 和 SQLite/PostgreSQL 存储。 | Node 宿主进程内嵌；需要多主机共享 authority 时使用 PostgreSQL profile。 |
| `packages/mcp`（MCP） | MCP `2024-11-05` stdio server。根据 Core registry 生成 `tools/list`，校验输入后调用 `service.dispatch`；stdout 只输出协议 JSON。 | 把 Taric 作为模型可调用的受控记忆、提案、上下文和历史检索工具。 |
| `packages/schemas`（Schemas） | 领域记录、操作请求/响应 JSON Schema、版本号、角色/能力/是否写入等注册表。它是 Core、CLI、MCP 和 RPC 共用的合同来源。 | 宿主生成类型、校验请求、展示工具目录或做合同测试。不要把它当成可绕过 Core 授权的写入接口。 |
| `packages/cli` 中的 gateway | CLI 的多身份传输层，不是独立 workspace 包。支持 Unix socket、TLS TCP JSON-RPC 和 HTTPS `/rpc`；token 固定映射到 principal。 | 集中部署 Core、隔离数据库凭据、让远程宿主通过受控网络访问 Taric。 |

宿主可以选择以下连接方式：Node 直接调用 `openRuntimeService`；Bun 注入 `@taric/driver-bun-sqlite`；本机进程使用 `taric proxy`；模型使用 MCP stdio；远程宿主使用 TLS gateway。无论哪种方式，Core 都会再次执行角色、能力、Engagement、版本、幂等和租约检查。

## 常见使用方式

### 攻防人员：让测试过程可追溯、可恢复

先由可信 operator 建立 Engagement、ScopeRevision 和资源清单。模型通过 `context.query` 读取已授权上下文，用 `proposal.submit` 提交候选观察或假设；宿主采集真实工具输出并通过 `capture.observation`、Evidence 和 Coverage 接口回传。Admission 和独立 Review 通过后，Finding 才能晋升为更高信任等级。

执行任务时，宿主创建 WorkItem、claim WorkRun 并维护 lease/generation。每次 checkpoint 和 Action 建议都带当前 generation；宿主自行决定是否执行目标动作，再把授权决定和结果回写 Taric。进程重启后按固定水位查询活动 WorkRun，调用 `work.resume`，依据 `blocked`、`premise_checks` 和 `replan_required` 恢复，避免重复执行或把过期结果写入当前运行。

### 智能体研发：给模型一套可控的长期记忆

使用 MCP 时，为每个安全边界启动独立进程并绑定一个 principal。默认 model profile 只看到允许模型使用的上下文、资源、证据、提案、工作查询和动作建议；需要检索历史文本时，在可信启动配置中为 model 单独打开 `history_read`。

历史原文必须在 `artifact.store.begin` 时明确声明 `history_content_class: "execution_history"`，只对 Taric 实际保存且已完成完整性校验的文本建立索引。模型通过 `artifact.search` 得到命中片段和 `content_ref`，再用 `artifact.history.read` 按偏移读取小段原文。外部引用、二进制、未分类内容和 `task_credential` 永远不进入这条模型读取路径；索引落后时响应会带 `incomplete`、`source_watermark` 和 `index_watermark`。

在可信的 MCP 运行环境中显式打开该 grant，并为进程绑定 Engagement；不要把这些变量交给模型自行修改：

```sh
export TARIC_PRINCIPAL_ROLE=model
export TARIC_PRINCIPAL_ID=history-model
export TARIC_ENGAGEMENT_ID=<engagement-uuid>
export TARIC_HISTORY_READ_ENABLED=true
node packages/mcp/dist/bin.js
```

### 系统运维：单机优先，按证据启用共享部署

单机默认使用 SQLite WAL。CLI、MCP、proxy 可以打开同一个本地 authority 文件，但不能把 SQLite 文件放在 NFS 或共享盘上做多主机协调。多主机部署才选择 PostgreSQL：每个宿主连接同一数据库，使用同一 SQL/storage 版本、server-side lease fencing 和当前构建的 runtime conformance evidence；健康或证据不满足时启动会 fail closed，不会偷偷回退到 SQLite。

运维备份必须把 authority 数据库、配置的 content root 和 cursor key 作为一个整体处理。维护使用 `audit.verify`、`audit.doctor`、`audit.reconcile` 和 `snapshot.export`；先 preview，再由 operator 明确执行 replay/rebuild。数据库恢复后所有 lease 都视为过期，宿主必须重新 claim，不能自动重放目标动作。

## 快速开始

环境要求：Node.js 22 或更新版本；使用 Bun 进程内驱动时另需 Bun。

```sh
npm ci
npm run build
npm test

# 查看 CLI 帮助和完整操作名
node packages/cli/dist/bin.js --help

# 以 JSON 调用一个操作（示例）
node packages/cli/dist/bin.js capability.status '{}'

# 启动 MCP stdio；数据库、角色和 Engagement 从可信运行时配置读取
node packages/mcp/dist/bin.js

# 启动远程 gateway；监听器/token 配置与 authority runtime 配置分开
node packages/cli/dist/bin.js gateway --config /secure/taric-gateway.json --runtime-config /secure/taric-runtime.json
```

建议先阅读 [文档索引](docs/README.md)，再按角色选择文档：

- [架构与模块说明](docs/taric-design.md)：模块边界、数据流、攻防和智能体研发场景。
- [宿主接入与部署](docs/agent-integration.md)：CLI、MCP、proxy、gateway、Pi/DeepSeek/Hermes 适配和配置示例。
- [API 与 MCP 合同](docs/taric-api.md)：操作目录、请求校验、授权模型、历史检索和错误处理。
- [运维手册](docs/operations.md)：SQLite、PostgreSQL、Artifact、游标、备份恢复和故障排查。
- [自定义 Authority 驱动](docs/authority-driver-guide.md)：实现和验收存储驱动的高级指南。

## 责任边界

Taric 保存宿主提交的状态和证据，不替宿主证明目标系统事实。宿主必须自己管理模型和 worker、目标请求授权、人工审批、网络出口、凭据 ACL/加密/轮换/撤销/保留，以及 Artifact 内容的扫描、脱敏和备份。Taric 对目标凭据只提供经授权的 opaque 字节存取；Taric 的 gateway token、数据库连接和 TLS 私钥属于另一组宿主配置秘密。

当前未启用的能力包括统计质量评估（缺少独立人工标注基线）、公共 snapshot 导入/迁移和自动目标执行。完整兼容性状态以 [`compatibility-matrix.json`](compatibility-matrix.json) 及运行时 `capability.status` 为准。
