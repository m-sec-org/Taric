# Taric 同步适配未完成项与落地计划

> 版本：v1（2026-10-25）  
> Taric 基线：`main` HEAD `66ea5ed` 及当前同步适配源码  
> 参照宿主：BreachWeave `pentest` 分支 `6957a55`  
> 文档性质：Taric 侧同步适配缺口、发布门槛和可执行验收清单

## 1. 结论

Taric 的同步适配主要代码已经形成，但还不能称为“跨仓可发布、可独立接入、已完成真实宿主验收”。当前未完成项集中在三层：

1. **公共合同仍有代码缺口**：`work.transition` 和 `coverage.record` 仍未进入 Taric 的公共 dispatch/registry；现有能力主要停留在 store 层或进程内 helper。
2. **已有实现缺少发布闭环**：clean consumer、合同版本同步、当前提交审计、PostgreSQL/多主机、重启恢复和真实 host profile 证据尚未闭合。
3. **可选能力需要按 profile 验收**：订阅、文件摄取、review pack、多 principal gateway 已有实现，但不能仅凭单元测试声称真实部署场景已支持。

Taric 的定位保持不变：提供通用的外置记忆、权威状态、证据治理、覆盖查询、租约/代次、审计和可恢复查询。Taric 不执行目标动作，不启动 agent，不管理凭据，不解析客户 Scope/ROE，不实现 CTF 平台业务，也不负责模型或人工复核编排。

## 2. 当前实现事实和证据口径

### 2.1 当前已经具备的能力

- Bun SQLite driver、Core exports、driver conformance 和 embedding smoke 已存在。
- `work.query` 已具备模型投影、资源引用和密集/稀疏/空窗口分页修复。
- `coverage.gate/query`、统一快照和 `read_seq` 已存在。
- 订阅 delta、去抖、重鉴权、RPC 通知和 `lease_expiry` 时间唤醒已存在。
- `artifact.ingest_file` 已具备路径绑定、descriptor、单次读取、哈希、幂等和发布前状态核对。
- review pack 已绑定 admission snapshot；CLI 已拒绝模型调用参数。
- 多 principal gateway、token 到 principal 解析、Pi 适配和 compatibility matrix 已存在。
- 来源门和 host/operator capture 约束已存在；模型不能通过自报字段提升事实可信度。

### 2.2 当前不能直接宣称的内容

- Core 340 项开发测试中存在因未配置 PostgreSQL 而跳过的项目；SQLite/Bun conformance 不能替代 PostgreSQL live 或多主机验证。
- 旧 audit 文档和部分设计文档仍引用更早基线，不能直接作为 `66ea5ed` 的发布证明。
- workspace 构建、`dist` 可用和单元测试通过，不能替代 clean consumer 安装、真实 BreachWeave host 重启和容器挂载验收。
- 订阅是 best-effort 状态提示，不是可靠消息队列；通知丢失时必须通过 query/read_seq 恢复。
- Artifact 保持 opaque；凭据脱敏、加密、保留、删除和原始 transcript ACL 仍属于宿主。

## 3. 未完成项总表

| ID | 未完成项 | 当前状态 | 需要交付 | 优先级/责任方 | 完成证据 |
|---|---|---|---|---|---|
| TARIC-01 | 暴露 `work.transition` 公共操作 | `AuthorityStore.transitionWorkRun()` 已存在，但 registry/dispatch 没有稳定公共 operation | 在 CoreService、operation registry、schema、RPC/CLI（如对外暴露）增加 host-only 操作；输入包含 `work_run_id`、`generation`、`owner/host_id`、目标状态和幂等键；固化合法状态图、lease/generation fencing、审计和错误码 | P0，Taric | 旧 owner、旧 generation、重复请求、过期 lease 和非法跃迁都得到确定结果；宿主无需直写 SQLite |
| TARIC-02 | 暴露 `coverage.record` 公共操作 | `createCoverageCell()` 是库级 helper，尚无面向宿主的稳定 cell identity/CAS dispatch | 增加 host-only 更新合同：`engagement_id`、稳定 `cell_key`、`expected_version`、状态、证据引用、`work_run/generation` 和幂等键；支持首次创建/更新、重复返回原结果、旧版本拒绝和审计 | P0，Taric；仅进程内 profile 可暂列 P1 | 并发更新只有一个版本成功；重放不重复写；写入结果能在同一 `read_seq` 被 gate 读取；model principal 无权调用 |
| TARIC-03 | 合同、schema 和适配器同步 | API 当前为 `1.1.0`；上述操作不在公共合同；`coverage.gate/query` response 仍需确认跨进程稳定性 | TARIC-01/02 合入后同步 `$defs`、registry、Core/RPC/MCP/CLI、adapter descriptor、compatibility matrix 和文档；为 gate/query 补稳定 response、错误码和 `read_seq`；合同升至 `1.2.0` | P0，Taric | 所有 transport 返回同一版本；旧/未知合同明确拒绝；clean consumer 可以按 schema 解析 gate/query |
| TARIC-04 | clean consumer 与发布闭环 | `@taric/core`、`@taric/schemas`、`@taric/driver-bun-sqlite` 仍为 `private`；当前验证依赖 workspace/dist | 选定 workspace、内部 registry 或 artifact registry 作为支持形态；生成锁定产物，补齐 exports、依赖闭包、锁文件、Bun 版本、权限和 close/restart 说明 | P0（独立插件/跨仓安装）；workspace-only 可暂列 P1 | 空项目安装匹配 tarball；能导入 Core/schemas/driver，完成 startup、migration、close、重启恢复；无相对路径或未构建 dist 隐式依赖 |
| TARIC-05 | 当前提交审计和发布基线 | 旧 audit 与当前源码基线不一致；已有开发测试记录但缺完整归档 | 针对锁定 commit 重新执行 audit；归档 commit、dirty diff digest、命令、Bun/Node、schema/API/driver/Pi、容器 digest、日志和 skipped 清单 | P0，Taric | 报告与 commit 一致；跳过项有原因和补测门槛；SQLite、PostgreSQL live、multi-host 结论分开表述 |
| TARIC-06 | PostgreSQL、重启和多主机场景 | PostgreSQL 项目在无 DB URL 时跳过；真实多 host 证据不足 | 建立 live PostgreSQL profile，验证读水位、租约、事务、通知退化、迁移、断线重连、进程重启和并发 host；不能支持的场景写入 capability profile | P1；采用 multi-host profile 时升 P0 | live DB 测试日志；两 host lease/generation fencing 可重复；数据库异常不泄漏连接串/SQL/秘密 |
| TARIC-07 | 订阅语义和失败处理 | delta、debounce、重鉴权和租约唤醒已有实现；订阅仍是 best-effort hint | 固化 `since_read_seq` 补读边界、主题边沿去重、重连、退订审计、慢消费者有界队列/关闭策略和 PG watermark 不可用时的轮询退化 | P1，Taric | 注入丢失、重复、乱序、慢消费者、断线和 token 失效；最终 query/read_seq 可恢复，队列不无限增长，退订后无事件 |
| TARIC-08 | Artifact ingest 真实竞态验收 | 基础 descriptor、哈希、幂等、符号链接和替换保护已有 | 在 Bun、容器挂载和真实 spool 中验证符号链接、路径替换、文件增长/缩短、中断、重复 ingest、权限、max-size 和重启恢复；明确 `source_deleted=false` 语义 | P1，Taric；脱敏/保留/删除由宿主 | 每个场景返回确定错误或稳定 artifact；不越界读取；相同幂等键只发布一个结果；不意外删除源文件 |
| TARIC-09 | Review pack/large reference 收口 | admission snapshot、超大引用、stale 和 CLI 模型隔离已有测试 | 复验大引用、stale proposal、policy/evidence digest、重复提交、错误脱敏和外部 reviewer attestation；Taric 不运行模型、不生成客户 verdict | P1，Taric 提供合同，宿主提供 reviewer | pack 可由同一 admission snapshot 重建；过期/超限确定拒绝；reviewer 身份来自认证 transport |
| TARIC-10 | 端到端故障恢复和幂等 | 单项能力有测试，尚无完整“host 调用—Taric 重启—重放”证据 | 注入 startup 失败、close、崩溃、租约过期、outbox 重放、重复 request、旧 generation 回写和 migration 中断；形成恢复 runbook | P1，Taric 与宿主联合 | 重启后无重复事实、无旧代写入；pending/unknown 可识别；恢复步骤可重复执行 |
| TARIC-11 | 能力矩阵和文档发布化 | D1/D2/D4 已有代码或矩阵，但信息散落在文档/测试输出 | 发布 machine-readable capability manifest，覆盖 API/schema、driver、SQLite/PostgreSQL、single/multi-host、subscription、Artifact、review profile；同步 API、host profile、runbook，标记旧 Node bridge 为历史 | P2，Taric | 宿主只消费一个版本化 manifest；profile 不满足时明确拒绝/降级；文档、源码和矩阵一致 |
| TARIC-12 | 多 principal gateway 真实验收 | gateway、token resolver、RPC subscription 有代码/单测；真实桥接部署证据不足 | 在远程/桥接 profile 验证 token 轮换/撤权、principal-Engagement 绑定、重连、慢连接、跨租户拒绝和错误脱敏；进程内 profile 不强制启用 | P1，选择远程/桥接时纳入发布门 | 撤权后旧连接不能继续读写；重连重新认证；跨租户正负矩阵可重复；慢连接不阻塞 Core |

## 4. 推荐实施顺序

### S0：确认支持 profile

交付一份选择记录，明确 Taric 首期支持哪一种形态：

- **独立插件基线**：优先完成公共 API、transport、版本握手、恢复和 clean consumer。
- **Bun 进程内嵌入**：优先完成 Bun driver 产物、依赖闭包、Core 生命周期和 BreachWeave host restart。
- **远程/桥接 profile**：额外纳入 gateway、token、principal、Engagement 绑定和撤权验收。

未选择的 profile 标记为 `unsupported` 或 `not_verified`，不能用其他 profile 的测试结果替代。

### S1：补齐公共合同

按 TARIC-01 → TARIC-02 → TARIC-03 顺序实施：

1. 先实现 `work.transition`，形成完整 WorkRun 状态图和 host fencing。
2. 再实现 `coverage.record`，形成稳定 cell identity、CAS、证据引用和幂等更新。
3. 最后统一更新 schema、registry、授权映射、transport、CLI/MCP、兼容矩阵和版本握手。

这两个操作都必须保持通用语义：`test_category` 继续是 opaque 字符串；Taric 不引入 WSTG、ASM、CTF、flag、Scope 或宿主 scheduler 字段。

### S2：完成可消费和可审计交付

并行完成 TARIC-04 和 TARIC-05：

- 构建并校验三包匹配产物，使用空 consumer 执行安装和启动。
- 重新生成当前提交审计，区分实现测试、profile 测试和未验证项。
- 记录完整产物 hash、版本、环境、测试日志和 skipped 项。
- 将 `taric-host-sync-adaptation-audit.md`、设计文档和 capability manifest 对齐到同一基线。

### S3：按 profile 补环境验收

按实际发布形态选择 TARIC-06～TARIC-12。即使首期不启用，也要在发布矩阵标注 `verified`、`not_verified` 或 `unsupported`，并写明后续门槛。

## 5. 验收用例

### 5.1 公共合同

1. `work.transition` 的合法状态跃迁全部通过，非法跃迁、旧 owner、旧 generation、过期 lease 和重复请求均返回稳定错误或原结果。
2. `coverage.record` 的首次创建、CAS 更新、旧版本冲突、重复幂等键、错误 Engagement、错误 resource/evidence 引用均有测试。
3. host principal 可以写入；model principal 不能调用；所有写操作产生带 run/generation/principal 的审计事件。
4. `coverage.record` 后立即以同一快照执行 `coverage.gate`，gate 读取到正确版本和 `read_seq`。

### 5.2 发布和恢复

1. 空目录安装三包匹配产物，不依赖 workspace link、TypeScript path alias 或仓库源代码。
2. 启动、迁移、关闭、重启恢复和权限检查全部通过。
3. API/schema/driver/Pi 版本不匹配时在 host module 建立前拒绝。
4. Taric 重启、host 重启、连接断开、重复重放和旧 generation 回写均不会产生重复事实或越权写入。

### 5.3 PostgreSQL、多 host 和 gateway

1. PostgreSQL live 测试不能以跳过代替通过；数据库不可用时错误必须可诊断且不泄漏秘密。
2. 两个 host 同时操作同一 WorkRun 时，只有合法 owner/generation 可以继续；旧代输出必须被拒绝。
3. gateway 撤权后旧 token/连接不能继续读写；重连必须重新认证和重新绑定 Engagement。
4. 订阅通知丢失、重复、乱序或慢消费者时，host 可以通过 query/read_seq 恢复，不依赖通知作为事实。

## 6. 明确不属于 Taric 的工作

以下内容保留在 BreachWeave 或其他宿主，不作为 Taric 同步适配开发：

- 竞赛平台 provider、题目 start/stop/hint/submit、flag/score/solved 状态机、3 槽位和平台限频；
- 授权项目 Scope/ROE 解析、DNS/redirect/egress 强制、工具启动和目标资源互斥；
- WSTG/ASM/CTF 测试字典、CoverageManifest 业务内容、planner/solver/observer 编排和 UI；
- 模型调用、agent loop、scheduler、目标执行、HITL 决策和 reviewer verdict；
- 凭据、flag、Cookie、原始响应的脱敏、加密、保留、删除和 secret scanning；
- 客户报告模板、平台积分展示和竞赛 replay/archive 策略。

Taric 只提供通用的 engagement/resource/work/evidence/artifact/coverage/review 合同，以及版本、租约、代次、CAS、审计和可恢复查询。宿主负责把这些能力映射到竞赛或授权渗透语义。

## 7. 已修复、无需重复开发的旧审计项

以下问题在当前源码中已有对应修复，后续只需按 TARIC-05～TARIC-08 重新验收：

1. `work.query`/coverage 分页在密集、稀疏和空窗口下的游标跳过问题。
2. `coverage.gate` 与 visibility 分别读取不同水位的问题，当前已有统一快照函数。
3. `lease_expiry` 无时间唤醒的问题，当前已有定时器；仍需验收通知丢失和重连。
4. `artifact.ingest_file` 的 descriptor、单次读取、哈希、符号链接和替换保护，剩余真实挂载/中断/重启验收。
5. review CLI 接受 `--model` 或自行调用模型的问题，当前已有拒绝逻辑；剩余外部 reviewer 流程验收。
6. API 从旧 `1.0` 基线推进到当前 `1.1.0` 的工作已完成；只有新增 TARIC-01/02 公共操作时才升至 `1.2.0`。

## 8. 源码和文档索引

| 主题 | 位置 |
|---|---|
| API 合同和操作注册 | `packages/schemas/src/registry.ts` |
| Core dispatch 和订阅 | `packages/core/src/service.ts` |
| WorkRun 状态迁移 | `packages/core/src/store.ts` 的 `transitionWorkRun` |
| CoverageCell helper | `packages/core/src/coverage.ts` 的 `createCoverageCell` |
| Work/Coverage 查询 | `packages/core/src/service.ts`、`packages/core/src/store.ts` |
| Artifact ingest | `packages/core/src/service.ts`、`packages/core/src/artifact-content-store.ts` |
| Review pack/submit | `packages/core/src/store.ts`、`packages/cli/src/review.ts` |
| Gateway/RPC | `packages/core/src/adapter-rpc.ts`、`packages/cli/src/gateway.ts` |
| 版本矩阵 | `compatibility-matrix.json`、`packages/core/src/compatibility.ts` |
| 宿主 profile | `docs/host-integration-profiles.md` |
| API 说明 | `docs/taric-api.md` |
| 旧审计，需按当前基线复验 | `docs/taric-host-sync-adaptation-audit.md` |

