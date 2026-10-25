# Taric 同步适配未完成项与落地计划

> 版本：v3（2026-10-25）
> 源码基线：当前工作区实现，基于 `5808a09f5d9c548fd1acd01cc277eaf63264611b`
> 文档性质：基于当前源码、测试和发布脚本的差距盘点；宿主特定结论必须在对应 profile 中复验

## 1. 结论

当前 Taric 已经有一条可运行的 Core、Bun SQLite driver、RPC/CLI adapter 和版本矩阵链路。源码和测试直接证明的事实包括：公共 operation registry 有 57 个操作，API contract 为 `1.2.0`，schema 为 `1.0.0`，Core 为 `0.1.0`，存储合同为 `authority-storage/3`；`work.transition`、`coverage.record`、`work.query`、`coverage.gate/query`、订阅、Artifact ingest、review pack、Pi adapter 和 gateway 均已有实现。

仍然存在三类不同性质的问题，不能合并成一个“Taric 尚未完成”的结论：

1. **公共合同已落地**：`work.transition` 和 `coverage.record` 已进入 registry、schema、Core dispatch、CLI operation 清单和兼容矩阵。WorkRun transition 具备 host fencing、Attempt 同步、审计和请求幂等；coverage record 具备 L1 create、版本 CAS、稳定维度保护、principal-attributed audit 和请求幂等。
2. **实现已存在、发布证据未闭合**：PostgreSQL live、多主机、clean consumer、真实容器挂载、远程 gateway 和真实宿主重启仍需要当前提交的可复现报告。没有这些报告，结论只能是 `implemented` 或 `not_verified`，不能写成“真实宿主已支持”。
3. **历史文档与当前源码不一致**：旧 audit 中关于分页跳过、gate 双水位读取、lease 没有时间唤醒、Artifact 双重路径读取、review CLI 调模型、Pi 严格支持 1.1.0 的结论，已被当前源码或测试改变。它们应保留为历史背景，不能继续列为当前实现缺口。

Taric 的边界不变：Taric 提供通用的 authority、work/lease/generation、evidence、artifact、coverage、review 和可恢复查询；宿主负责 scheduler、agent/tool 执行、Scope/ROE、凭据、竞赛平台业务、模型调用和人工复核编排。

## 2. 基线和证据口径

### 2.1 当前源码直接可确认的事实

- `packages/schemas/src/registry.ts` 定义 `API_CONTRACT_VERSION = "1.2.0"`、`ADAPTER_CONTRACT_VERSION = "1.0"`，并注册 57 个操作；`work.transition` 与 `coverage.record` 分别引用 `workTransitionRequest` 和 `coverageRecordRequest`。
- `packages/core/src/service.ts` 的 dispatch alias、授权路径和 schema validation 已覆盖这两个操作；CLI operation 清单也已包含它们。host identity 从认证 principal 取得，请求体中的 `host_id`/`owner` 会被拒绝。
- `packages/core/src/store.ts` 的 `transitionWorkRun()` 已执行 owner、generation、lease 和状态迁移约束；现在公共 service 会把 WorkRun、Attempt、审计事件和 idempotency 结果放在同一事务中。
- `packages/core/src/coverage.ts` 的 `createCoverageCell()` 已完成 L1 coverage commit；公共 `coverage.record` 增加了 create、版本 CAS update、稳定维度保护、principal-attributed audit 和 idempotency。CoverageCell 仍不携带 WorkRun/generation 字段，run attribution 不是本次合同的一部分。
- `coverageGateSnapshot()` 在一次 `maintenanceRead` 中生成 gate、visibility 和 `read_seq`；`coverage-dispatch.test.mjs` 覆盖一致水位、并发 writer、权限和分页恢复。
- `artifact.ingest_file` 使用已打开的 descriptor 读取并在读取前后核对身份；当前返回 `source_deleted: false`，源文件保留给宿主或 operator 清理。相关替换、中断、幂等测试已经存在。
- admission review pack 持久化 evidence snapshot binding；`review.submit` 校验 binding；CLI 明确拒绝 `--model`、`--provider-url` 等 provider/model 参数。
- Pi 当前认证集合是 `1.4.0`（host commit `4a08025`）；同 major 未认证版本只给安全只读子集，更远 major 给最小只读能力。
- `compatibility-matrix.json` 是机器可读矩阵，但它描述的是当前合同和构建产物，不是第三方宿主验收报告。

### 2.2 只能写成“未验证”或“按 profile 验收”的内容

- `packages/core/test/postgres-live.test.mjs` 和完整 runtime conformance 在没有 `TARIC_TEST_DATABASE_URL` 时会跳过；SQLite/Bun 通过不能替代 PostgreSQL live 证据。
- workspace packages 当前标记为 `private`；本地 tarball clean consumer 已验证安装、导入、Core migration/close/restart、CLI 持久化和 Bun driver query。该结果不代表 registry 发布或第三方宿主认证。
- 订阅是 best-effort hint，丢通知时依靠 query/read_seq 恢复，不是持久消息队列。
- 单元测试和本地 RPC bridge 不能证明真实宿主、容器挂载、跨进程 token 撤权或多 host 部署已经通过。
- `scripts/verify-release.mjs` 当前会记录 commit、source/build/schema/policy/profile digest、测试、profile 状态和 PostgreSQL readiness；旧 benchmark 仍保留为历史测量，不作为当前 release report。
- 当前候选 release gate 已在 OrbStack PostgreSQL 上完整通过：Schemas 10/10、Core 350/350、CLI 29/29、MCP 12/12、Hermes 5/5、Bun driver 11/11，零 skip、零失败；clean consumer、profile manifest、26 次跨 CLI/RPC 调用的 proxy restart/replay、PostgreSQL 12 个 runtime conformance 场景及独立备份恢复均通过。详见[候选 release report](../openspec/changes/harden-taric-authority-runtime/release-report.json)。报告绑定 dirty worktree，因此不是 clean Git release。

### 2.3 本文不采信的基线声明

原文中的 `66ea5ed` 不是当前 `main` HEAD 的祖先，当前 HEAD 是 `5808a09f...`。本地也没有可供核验的 BreachWeave `6957a55` 对象，因此不再把该宿主分支或 commit 写成 Taric 已验证的事实。

## 3. 未完成项总表

| ID | 证据分类 | 客观状态 | 当前行动和门槛 | 优先级 |
|---|---|---|---|---|
| TARIC-01 | 已实现，待发布证据 | `work.transition` 已进入 57-operation registry、schema、dispatch、CLI 和 matrix；store 事务覆盖 WorkRun/Attempt/审计/idempotency。 | 用当前 commit 复验跨 transport、重启和真实 host profile；继续保持 principal 绑定，不允许请求体覆盖 host identity。 | 实现完成；profile 证据 P1 |
| TARIC-02 | 已实现，待发布证据 | `coverage.record` 已进入 registry/schema/dispatch，支持 L1 create、返回 cell identity、版本 CAS update、稳定维度和 idempotency；未引入 WorkRun/generation 字段。 | 用当前 commit 复验 gate 同一 `read_seq`、跨 transport 和真实宿主写入边界；若宿主需要 run attribution，另立合同变更。 | 实现完成；profile 证据 P1 |
| TARIC-03 | 已实现并复验 | API `1.2.0`、schema `coverageRecordRequest`/`workTransitionRequest`、registry、dispatch、CLI 和 matrix 同步；旧 API `1.1.0` descriptor 明确 exact-match 拒绝。 | 如发布新 API 再执行对应 transport consumer 验收。 | 当前开发完成 |
| TARIC-04 | 本地 tarball consumer 已验证 | 五个 package 从 dist 打包，隔离临时目录安装，无 workspace link；Core startup/migration/close/restart、CLI persistent DB、Bun driver import/query 均通过。 | registry 发布、外部 consumer 和第三方宿主仍按发布目标验收；当前包保留 `private`。 | 本机适配 profile 完成；跨仓发布另验 |
| TARIC-05 | 当前候选发布门禁通过 | 当前候选 release gate 包含 clean build/typecheck、全 workspace 测试、matrix/docs、clean consumer、proxy restart/replay 与 PostgreSQL runtime；0 skip/0 fail。 | 需要 clean Git release 时在授权的干净提交上重新运行；当前 dirty 候选报告不可冒充 clean commit。 | 候选技术门通过 |
| TARIC-06 | PostgreSQL 单 authority profile 已验证 | OrbStack PostgreSQL live 运行 12 个 conformance 场景及独立备份恢复；当前 authority service host_count=1。 | 双宿主并行进程、网络断连重连、真实多 host 部署仍为 `not_verified`，只在选用 multi-host 发布 profile 时验收。 | 单 authority 完成；双 host profile 待选 |
| TARIC-07 | 已实现，仍需 profile 验收 | subscription delta、debounce、重鉴权、有限队列和 lease expiry timer 已在 service 中实现，并有测试。 | 补当前 release report 中的丢失/重复/乱序/慢消费者/断线场景；保留 query/read_seq polling recovery 语义，不把通知当事实队列。 | P2；远程 profile 可升 P1 |
| TARIC-08 | 已实现，仍需环境验收 | Artifact 已做 descriptor、单次 fd 读取、哈希、身份核对和幂等；当前语义是源文件不由 Taric 删除。 | 在 Bun、容器挂载和真实 spool 复验替换、增长/缩短、中断、权限、max-size、重启；把 `source_deleted=false` 写入宿主运行手册。 | P2 |
| TARIC-09 | Taric 实现已完成，外部流程未证实 | review pack 绑定 admission snapshot，submit 校验 digest；CLI 不运行 provider/model。 | 只补外部 reviewer transport、attestation、错误脱敏和大引用 profile 证据，不再把模型调用列为 Taric 缺口。 | P2 |
| TARIC-10 | 本地 host→Taric restart/replay 已验证 | 当前候选 proxy restart report 覆盖 Node CLI + Bun RPC、Core SQLite 持久重启、重复请求、read_seq 恢复、CAS、过期 lease quarantine、旧 generation 拒绝及 late retry。 | 真实第三方宿主 crash、migration 中断和远程传输仍属独立 profile。 | 本地 adapter E2E 完成 |
| TARIC-11 | 当前候选 profile manifest 已完成 | release report 内含 source digest 绑定的 `profile_verification` 清单，并用独立 digest 固定；每项显式标注 `verified`、`not_verified` 或 `unsupported`，测试要求本地/Core、PG 单 authority 和未验证远程 profile 都有明确状态。 | 实际宿主或部署选择变化时重跑 release verifier 更新各 profile 状态。 | 本机适配 profile 完成 |
| TARIC-12 | 实现已有，真实桥接未证实 | gateway、token→principal、RPC subscription 有代码和测试；没有当前远程桥接部署报告。 | 只有选择 remote/bridge profile 时，才验收 token 撤权、Engagement 绑定、重连、慢连接、跨租户拒绝和错误脱敏。 | P2；该 profile 发布时升 P1 |

## 4. 落地顺序

### S0：先锁定支持 profile

形成一份选择记录，至少区分：

- **Bun 进程内嵌入**：需要 clean consumer、Bun driver、生命周期和宿主重启证据。
- **独立 RPC/plugin**：需要版本握手、transport、恢复和权限证据，不以 workspace link 作为安装方式。
- **PostgreSQL/multi-host**：额外需要 live DB URL、两 host fencing、迁移和断线重连证据。
- **remote/bridge、review、Artifact、subscription**：按实际启用情况加入发布门。

未选择的 profile 标记 `unsupported` 或 `not_verified`，不能用 SQLite 单测替代。

### S1：只为已确认的宿主合同补公共写面

1. 已冻结 `work.transition` 的最小合同：`engagement_id`、`work_run_id`、`generation`、目标状态和可选 `idempotency_key`；host identity 来自认证 principal。
2. 已冻结 `coverage.record` 的最小合同：`engagement_id`、`expected_version`、coverage 维度、状态、限制和可选 `cell_id`/`idempotency_key`；创建由 Core 分配 cell identity，更新必须带 UUIDv7 cell_id 和当前版本。
3. 已同步 registry、schema、service dispatch、CLI operation 清单、matrix 和专项测试；RPC 复用通用 dispatch，MCP 继续不暴露 host-only 写面。
4. API 已从 `1.1.0` 升到 `1.2.0`，旧版本按 exact-match 规则拒绝。

### S2：生成当前提交的发布证据

运行并归档 `npm run build`、`npm run typecheck`、`npm run verify:matrix`、`npm test`、`npm run test:clean`（若脚本可用）和 `node scripts/verify-release.mjs`。报告必须绑定当前 commit、source/build/schema/policy digest，并分别列出通过、跳过和未选择 profile。

当前候选 release 验证已完成：schemas 10/10、Core 350/350、CLI 29/29、MCP 12/12、Hermes 5/5、Bun driver 11/11，0 skip/0 fail；`documentation-links`、兼容矩阵、profile manifest、隔离 tarball consumer、proxy restart/replay 和 OrbStack PostgreSQL runtime 全部通过；报告见 `openspec/changes/harden-taric-authority-runtime/release-report.json`，专项报告包括 `clean-consumer-report.json` 与 `proxy-restart-report.json`。PostgreSQL 单 authority profile 已验证 12 个场景及独立 backup/restore；真实双宿主、第三方宿主和远程 bridge 仍按 profile 保持 `not_verified`。质量报告绑定当前 Core implementation、schema、policy、样本和 fixture 摘要；样本是 30 条 synthetic fixture，人类标注样本数为 0，因此 `release_state=blocked`，质量 capability 继续 disabled。该状态不阻塞同步适配开发。

### S3：按 profile 补真实环境验收

S2 候选门禁已通过；clean consumer 与 PostgreSQL 单 authority 已有当前候选证据。按 S0 选择尚未验证的 multi-host、容器 spool、远程 gateway 和真实宿主重启 profile；若源码变化影响其 digest，再重跑对应门禁。每个结果只允许写成 `verified`、`not_verified` 或 `unsupported`，不把历史 benchmark 或其他 profile 的结果横向借用。

## 5. 验收用例

### 5.1 公共合同（仅在 S1 确认需要时执行）

1. 合法/非法 WorkRun 状态迁移、旧 generation、过期 lease、重复请求和 principal 越权均返回稳定结果。
2. Coverage 首次创建、重复请求、版本冲突、错误 Engagement、证据引用和 gate 同一 `read_seq` 读取均有测试。
3. registry、schema、service、RPC 和 matrix 对同一 operation 给出一致版本和错误码。

### 5.2 发布和恢复

1. 空目录安装匹配产物，不依赖 workspace link、TypeScript path alias 或仓库内 `dist`。
2. 启动、迁移、关闭、重启、重复 replay、旧 generation 回写和权限检查可重复通过。
3. 版本不匹配、schema digest 不匹配或 live evidence 缺失时，服务在建立 host module 前明确拒绝或标记未启用。

### 5.3 PostgreSQL、订阅和 gateway

1. PostgreSQL live 测试有显式 URL；跳过只能表示缺证据，不能表示通过。
2. 两个 host 同时操作同一 WorkRun 时，只有合法 owner/generation 可以继续，旧代写入被拒绝。
3. 通知丢失、重复、乱序、慢消费者和 token 失效后，host 能以 query/read_seq 恢复，且不会无限积压。
4. remote profile 撤权后旧连接不能继续读写，重连必须重新认证和重新绑定 Engagement。

## 6. 对原方案来源的客观判定

| 原方案内容 | 判定 | 原因 |
|---|---|---|
| `work.transition`、`coverage.record` 不在公共 API | **历史源码差距，现已完成** | 原 v2 文档基于当时 registry/dispatch 得出；当前版本已补齐 registry、schema、dispatch、CLI 和 matrix，并有专项测试。 |
| 当前 API、schema、Core、driver 版本和 operation 数 | **源码/矩阵真实事实** | 当前 API 为 `1.2.0`，schema 为 `1.0.0`，Core 为 `0.1.0`，矩阵应包含 57 个 operation。 |
| clean consumer、PostgreSQL live、真实 host、容器和多 host | **按 profile 区分证据** | 当前候选报告验证了本地 tarball clean consumer 和 PostgreSQL 单 authority；真实宿主、容器挂载、双进程/多 host 与远程 bridge 仍为 `not_verified`。候选绑定 dirty worktree，不是 clean Git release。 |
| 分页跳过、gate 双读、lease 无 timer | **来自过时 audit 的结论** | 当前 `workItemsPage`/`coverageCellsPage` 测试覆盖 dense/sparse/empty；gate 使用统一 snapshot；service 有 lease expiry timer。应复验而非重复开发。 |
| Artifact 双重读取或必然存在 TOCTOU | **来自过时 audit 的结论** | 当前实现用同一 fd 读取并做前后 descriptor/entry 核对，替换和中断测试已存在；剩余是实际挂载 profile 验收。 |
| review CLI 会调用模型、review pack 未绑定快照 | **来自过时 audit 的结论** | 当前 CLI 拒绝 provider/model 参数，store 和测试绑定 admission evidence snapshot。 |
| Pi 严格支持 1.1.0 | **来自过时文档的结论** | 当前认证集合是 1.4.0，并明确未认证版本降级；应以 `pi-adapter.ts` 为准。 |
| “Core 340 项测试”或固定旧 commit/宿主 commit | **历史数字已过时；候选测试有当前报告** | 当前候选 Core 全量运行是 350/350，零失败、零跳过；旧 commit 不是当前 HEAD，宿主旧对象或 profile 不因此成为已认证环境。 |
| TARIC-01/02 必须 P0、必须包含某组字段、必须升 API 1.2.0 | **原方案推断；当前已形成实现决策** | 原文把优先级和字段写成既定事实；本次实现冻结了最小合同并升至 API `1.2.0`，但真实宿主是否把它们作为发布 P0 仍需 profile 证据。 |

因此，原方案不是完全基于过时文档，也不是完全由源码重新推导：公共 operation 缺口、版本矩阵、实现存在性和 live 测试跳过状态来自源码；分页、gate、lease、Artifact、review、Pi 及部分优先级/字段结论混入了旧文档或未验证的宿主假设。本次已把两个公共合同落地，并保留 clean consumer、PostgreSQL、多 host 和真实宿主验收作为独立发布证据门槛。发布脚本暴露的 `openspec/specs` 和历史归档链接缺口也已单独标记，不再把它们误报为 operation 实现缺口。

## 7. 已实现且不应重复开发的事项

以下内容在当前源码和测试中已有实现，后续只需按选定 profile 生成证据：

1. Work/Coverage dense、sparse、empty window 分页及 `read_seq` 返回。
2. Coverage gate 的统一 snapshot、visibility 和并发 writer 边界。
3. `lease_expiry` 时间唤醒、订阅重鉴权、有限队列和 polling recovery。
4. Artifact descriptor、fd 单次读取、哈希、身份核对、幂等和源文件保留语义。
5. review pack admission snapshot binding、submit 校验和 CLI provider/model 隔离。
6. Pi 1.4.0 认证及未认证版本的安全降级。
7. API `1.2.0`、schema `1.0.0`、Core `0.1.0`、storage `authority-storage/3` 和 57-operation compatibility matrix。

## 8. 源码和文档索引

| 主题 | 位置 |
|---|---|
| API 合同和 operation registry | `packages/schemas/src/registry.ts` |
| Core dispatch、work/coverage service、订阅 | `packages/core/src/service.ts` |
| WorkRun 状态迁移和分页 | `packages/core/src/store.ts` 的 `transitionWorkRun`、`workItemsPage`、`coverageCellsPage` |
| CoverageCell helper 和 gate snapshot | `packages/core/src/coverage.ts` |
| Artifact ingest | `packages/core/src/service.ts`、`packages/core/test/artifact-ingest.test.mjs` |
| Review pack/submit 和 CLI harness | `packages/core/src/store.ts`、`packages/cli/src/review.ts`、对应 test |
| Pi 版本认证 | `packages/core/src/pi-adapter.ts` |
| Gateway/RPC | `packages/core/src/adapter-rpc.ts`、`packages/cli/src/gateway.ts` |
| 版本矩阵 | `compatibility-matrix.json`、`packages/core/src/compatibility.ts` |
| 发布验证 | `scripts/verify-release.mjs` |
| 宿主 profile | `docs/host-integration-profiles.md` |
| PostgreSQL readiness | `docs/postgres-runtime-readiness.md` |
| 历史 audit（只作背景，需按当前基线复验） | `docs/taric-host-sync-adaptation-audit.md` |

