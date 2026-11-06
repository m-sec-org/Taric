# 运维手册

本文面向 Taric 系统运行维护人员，覆盖单机 SQLite、共享 PostgreSQL、Artifact 内容根、游标密钥、审计和恢复。当前存储合同为 `authority-storage/5`、SQL layout `authority-sql/5`。不要把不同合同版本的运行时混接到同一 authority；运行诊断和部署能力以 `capability.status` 为准。

## 单机 SQLite

SQLite WAL 是默认的单机 authority。CLI、MCP、proxy 和维护进程可分别打开同一台机器上的数据库文件，由数据库协调进程间事务；SQLite 文件不能放到 NFS 或共享盘上承担多主机协调。多主机共享状态请使用 PostgreSQL。

常用配置：

| 配置 | 作用 |
| --- | --- |
| `TARIC_DB` | SQLite authority 文件路径 |
| `TARIC_CONTENT_ROOT` | Artifact payload、派生内容和游标密钥所在目录 |
| `TARIC_PRINCIPAL_ROLE` / `TARIC_PRINCIPAL_ID` | 进程级身份；只能由可信运行环境设置 |
| `TARIC_ENGAGEMENT_ID` | 进程级 Engagement 绑定 |
| `TARIC_CONTENT_READ_ENABLED=true` | 给 host/operator 额外开启原始 Artifact 读取；不得给 model 使用 |
| `TARIC_HISTORY_READ_ENABLED=true` | 给 MCP model 开启窄范围 execution history 读取，默认关闭 |

配置文件可使用 `db_path`、`content_root`、`principal_role`、`principal_id`、`engagement_id`、`content_read_enabled` 和 `history_read_enabled`。显式 `--runtime-config` 是完整部署单元，不会静默合并环境变量选择的 authority。普通发现模式选择第一个可用来源，配置文件不会互相合并；部署应检查 CLI/gateway 状态报告中的配置来源和非秘密摘要。

维护前先确认 authority 和 content root 指向正确部署：

```sh
node packages/cli/dist/bin.js capability.status
node packages/cli/dist/bin.js audit.doctor '{}'
```

SQLite 默认位置为 `$HOME/.taric/authority.sqlite`，content root 通常在数据库旁的 `content/`。建议显式配置生产路径，避免运行目录变化影响默认值。

## 游标与 Context 恢复

`context.query` 和分页查询会固定读取水位，并返回绑定 principal、Engagement、过滤条件和排序参数的 cursor。继续读取时必须原样保留这些参数和 cursor。cursor 不能跨 principal、authority、content root 或查询绑定复用。遇到 `invalid_cursor` 时启动新的第一页查询，不要篡改或猜测 cursor 内容。

Core 在 content root 下维护 `.taric-context-cursor-key.v1`。密钥文件权限必须为 `0600`，并绑定真实 content root 与 authority ID；复制到另一 authority/root 的密钥会被拒绝。数据库、content root 和该密钥应在同一备份/恢复操作中配套保存。丢失密钥会使旧 cursor 失效，但不影响已提交记录；恢复后重新查询即可。

密钥轮换由可信 operator 在已初始化的 Core/store 上显式执行。轮换会让旧 Context/list cursor 失效，之后的查询使用新密钥；应协调所有持有分页状态的客户端。不要通过手工编辑密钥文件来轮换。

## Artifact 内容与 execution history

Taric 本地 Artifact 正文是 opaque bytes。上传经过 begin、append、commit；commit 和完整性校验通过前，内容不会出现在可用目录中。run-bound Artifact 还必须匹配当前 owner、Attempt 和 generation。外部存储模式只记录 host reference，Taric 不替宿主取回或验证外部内容。

执行历史索引仅适用于宿主明确分类为 `history_content_class: "execution_history"` 的 Taric 本地文本。外部引用、二进制、未分类内容和 `task_credential` 不可搜索或通过模型 history API 读取。索引数据是可重建投影；落后或维护失败时，查询会说明 `incomplete` 及 source/index watermark，不能把空结果解释为完整历史不存在。

模型历史权限 `history_read` 默认关闭且只可授予 model MCP identity；它只覆盖 `history.query`、`artifact.search`、`artifact.history.read`。模型原文读取每段最多 16 KiB。宿主/运维读取一般原文需要独立 `content_read`，仅适用于 host/operator。宿主负责 Artifact 的授权、扫描、脱敏、保留、备份和访问控制。

## 运维检查与修复

先运行只读检查：

```sh
taric capability.status '{}'
taric audit.doctor '{}'
taric audit.verify '{}'
taric audit.reconcile '{"action":"preview"}'
taric snapshot.export '{"engagement_id":"<uuid>"}'
```

`audit.doctor` 检查 authority 一致性及 Artifact 发布状态；`audit.verify` 检查审计链；`audit.reconcile` 的 `preview` 只报告问题，显式 `replay`、`rebuild` 或 `reconcile` 才会修复相应派生状态。省略 action 不是 preview。Operator 应审阅 preview 结果后再执行修复。reconcile 不会创造 canonical 事实、恢复缺失 payload、修改保留策略或重放目标动作。

authority 漂移、审计链错误、Schema 不兼容或缺失 Artifact 内容应按故障处理。保持写入停止，核对报告指出的数据库、content root、密钥、版本和文件完整性；完成恢复后再重复 doctor/verify 和相关 Artifact 检查。

## 备份、恢复和迁移边界

单机备份应一致地保存 SQLite 文件、整个配置的 content root 和 `.taric-context-cursor-key.v1`。仅备份数据库会丢失本地 Artifact 正文和旧 cursor 能力。恢复时先在隔离位置验证数据库与 spool，再切换流量。

多主机备份需要同时覆盖共享 PostgreSQL authority 和每台宿主各自的 content root。PostgreSQL 不复制 Artifact payload，也不使多个宿主的 spool 自动安全共享。数据库恢复后把所有 WorkRun lease 视为失效，宿主必须重新 claim；任何状态未知的目标动作都由宿主人工或策略对账，不自动重试。

`snapshot.export` 是供检查/投影使用的有界导出，不是完整数据库备份。公共 `snapshot.import`、通用 migration 和 `backup.restore` operation 不可用。SQLite 到 PostgreSQL 的切换不是把连接字符串换掉：需要为新 authority 做隔离部署、版本/schema 准备、当前 build 的 conformance evidence 和健康检查，然后按受治理流程重新提交历史材料。不要假设存在保留完整审计、lease 和 Artifact 的公开迁移命令。

## PostgreSQL 多主机

SQLite 与 PostgreSQL 共用异步 Core 治理逻辑。PostgreSQL 使用数据库事务、约束、序列、服务端时间和 fencing 进行跨宿主协调；只有选择 `multi_host_authority` profile 时才启用。运行时默认关闭，即使连接串和表结构看似正常，也必须提供与当前 Core、Schema、policy 和部署匹配的完整 conformance report。缺少报告、报告摘要不匹配或运行健康检查失败时，启动/写入会失败关闭，不会回退到 SQLite。

生产环境启用前需要完成：

1. 在可信网络部署 PostgreSQL，并使用最小权限服务账户和受管凭据。
2. 对当前构建使用隔离数据库运行 storage/Core runtime conformance，确认所需场景和备份恢复检查通过。
3. 将通过的 digest-bound report 作为 operator 管理的只读输入配置给运行时。
4. 设置 `TARIC_AUTHORITY_PROFILE=multi_host_authority`、`TARIC_DATABASE_URL`、稳定 `TARIC_HOST_ID`、`TARIC_LEASE_MODE=server_side`、`TARIC_RUNTIME_CONFORMANCE` 和明确的宿主本地 `TARIC_CONTENT_ROOT`。
5. 启动前后检查 `capability.status` / gateway status，确认 backend、schema、runtime_state、evidence 和 fencing 状态符合预期。
6. 每个宿主单独备份其 spool 和 authority cursor key；PG 备份与 spool 备份需协调恢复。

可用 `PostgresAuthorityStore.runtimeReadiness(report?)` 只读检查实际部署的 Schema、sequence、lease/Attempt 绑定及表列。它不运行 conformance、不执行 migration，也不能单独激活运行时。

### 本地 PostgreSQL 测试环境

仓库提供一个仅绑定本机回环地址的 PostgreSQL 17.11 Compose 配置，用于开发和 live conformance。其密码是公开测试值，只可用于本地测试：

```sh
docker compose -f compose.postgres.yaml config --quiet
docker compose -f compose.postgres.yaml up -d --wait --wait-timeout 90
docker compose -f compose.postgres.yaml ps

npm run build
TARIC_TEST_DATABASE_URL=postgresql://taric:taric-local-only@127.0.0.1:55432/taric \
  node --test packages/core/test/postgres-live.test.mjs packages/core/test/runtime-conformance.test.mjs
TARIC_TEST_DATABASE_URL=postgresql://taric:taric-local-only@127.0.0.1:55432/taric \
  TARIC_TEST_POSTGRES_CONTAINER=taric-authority-postgres-1 \
  node scripts/verify-postgres-runtime.mjs --output /tmp/taric-postgres-runtime-current.json
```

测试 URL 必须指向可丢弃的测试数据库；脚本会创建隔离 schema/database 并进行清理。跳过的 live 测试不是通过证据。只有 report 对应当前 build 和目标部署时，才可作为 runtime activation 输入。开发容器健康不等于多主机生产验收，也不证明跨物理机器故障恢复。

更多实现背景见 [架构说明](taric-design.md)；操作字段和授权要求见 [API 合同](taric-api.md)。
