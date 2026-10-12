# Spec Delta

## Purpose

定义 Phase 0–1 单机首发的 SQLite authority、原子写入、固定读取快照、operation marker 与启动检查。本变更不交付多机 backend、可写 snapshot import 或通用 event replay。

## ADDED Requirements

### Requirement: Atomic authority commits and identifiers
系统 SHALL 在单一 SQLite authority 的短事务内原子提交记录版本、安装级 display identifier、审计事件、幂等结果及 outbox。display identifier 在所有 Engagement 和实体类型之间唯一且单调，只在创建逻辑实体时分配，更新保持原 alias；调用者不得指定或重用 alias。相同幂等键只适用于同 principal、Engagement、operation 和规范化 payload hash；不同 payload 必须返回冲突。失败事务不得暴露部分成功。

#### Scenario: Commit one authority change
- **WHEN** a validated authority mutation succeeds
- **THEN** its record version, display identifier, audit event, idempotency result, and outbox entry are committed together

#### Scenario: Fail during a transaction
- **WHEN** a process or storage error interrupts a mutation before commit
- **THEN** restart exposes either the complete committed change or none of it, never a partial success

#### Scenario: Concurrent display identifier allocation
- **WHEN** writers in different engagements allocate display identifiers concurrently
- **THEN** every committed identifier is unique and the installation sequence does not move backward or reset by engagement or record kind

### Requirement: Conditional writes and pinned snapshots
系统 SHALL 将 expected-version、Engagement 归属、owner、lease 和 generation 检查与对应修改放在同一事务。读取快照须在同一只读事务固定 authority sequence；返回内容必须对应所报 read_seq。首发支持固定 snapshot/as_of 读取、稳定排序、绑定 principal/Engagement/filter/read_seq 的 continuation cursor 和 read-your-writes，返回 committed/projected 水位；如 search index 未交付，不得声明 indexed capability。cursor 不得跨 Engagement、换过滤条件或换序列复用。

#### Scenario: Two writers use the same base version
- **WHEN** concurrent mutations target one record version
- **THEN** at most one mutation commits and the other receives a version conflict with no overwritten update

#### Scenario: Read while authority changes
- **WHEN** 构建 snapshot 或 Context Pack 时另一个 writer 提交变化
- **THEN** 结果只含固定 read_seq 可见记录，不混入更晚记录；不支持的历史序号返回结构化错误

#### Scenario: Read after a successful mutation
- **WHEN** a client queries using the committed sequence returned by its write while the projection or index is behind
- **THEN** Taric returns authority-consistent results or a clear pending response and exposes the derived view's lower watermark

### Requirement: Reconcile durable views and event delivery
系统 SHALL 为已提交事务的 projection/Git outbox 工作保存 operation marker，至少包含 operation_id、Engagement、commit_seq、kind、输入 hash、pending/applied/indexed/failed/recovered 状态、错误和重试归属；marker 与权威提交原子建立。启动 doctor 须检查未完成操作、账本连续性、record/counter/idempotency/outbox 水位和 store 权限，输出可审计报告。明确可重试的派生工作可幂等恢复；权威漂移必须阻塞写入并给 operator 修复建议，不得静默覆盖。reconcile 只修复本期已支持的派生投影/outbox，保留权威历史；通用 replay 和全库重建后续交付。

#### Scenario: Detect derived-state drift
- **WHEN** an operator runs authority verification after a partial derived-view failure
- **THEN** Taric reports the inconsistent sequence and affected view without claiming silent repair

#### Scenario: Rebuild a derived view
- **WHEN** operator 显式对本期支持的 projection/outbox 执行 reconcile
- **THEN** Taric 从已提交 authority 状态和 operation marker 幂等完成派生工作，记录恢复事件和水位，不修改权威历史

#### Scenario: Restart with an unfinished operation
- **WHEN** 进程在 authority commit 后、projection 或 Git checkpoint 完成前退出
- **THEN** 启动 doctor 识别 pending/failed marker，报告可重试工作或明确阻塞，不静默声明全部成功

#### Scenario: Authority drift is detected
- **WHEN** doctor 发现权威记录、counter、事件来源或存储权限与已提交状态不一致
- **THEN** 服务阻塞权威写入并提供归属到 operation 和 sequence 的修复报告

### Requirement: Portable authority snapshots and migrations
本期系统 SHALL 提供只读 Taric-native JSON/JSONL 或 Markdown snapshot export，导出在固定 read_seq 下经过权限和字段白名单处理的已提交 Engagement 状态，含 schema/core 版本、Engagement、source sequence、文件 hash 和格式说明。export 不得修改 authority，不得泄漏其他 Engagement、未授权 L0/草稿、SecretRef 或宿主 Artifact 内容。存储 schema version 不支持时必须在写入前失败。snapshot import、round-trip、历史序号移植、升级迁移和 backup/restore 属于后续变更，本期接口须报告 unsupported capability。

#### Scenario: Export an isolated snapshot
- **WHEN** 获授权 operator 导出一个 Engagement 的固定 snapshot
- **THEN** 文件只包含该 principal 可见的本 Engagement 内容、版本和完整性元数据，authority 不发生变化

#### Scenario: Import is deferred
- **WHEN** 客户端在本期请求 snapshot import 或恢复外部快照
- **THEN** 服务返回 unsupported capability，不创建或修改任何记录

#### Scenario: Storage schema is unsupported
- **WHEN** 服务打开非本期支持版本的 authority store
- **THEN** 服务在写入前报告 schema incompatibility，不静默迁移或丢弃数据

### Requirement: Single-host authority deployment
本期系统 SHALL 仅支持一台机器上的多进程/多 worker 连接同一个 Taric service 和 SQLite WAL authority，不要求 PostgreSQL。共享 SQLite 文件、NFS 锁、多个 SQLite 副本或共享 Git clone 不得声明为跨主机一致性方案。

#### Scenario: Multi-host configuration is requested
- **WHEN** operator 在本期配置多主机共享 authority
- **THEN** 服务返回 unsupported deployment，不以 SQLite/Git 降级冒充已支持

#### Scenario: Use a single-host default deployment
- **WHEN** Taric runs with the default single-host configuration
- **THEN** it operates without PostgreSQL configuration or service availability

## Deferred Follow-up

`evolve-engagement-memory` 承接 Taric-native snapshot import/round-trip 和 revision 全历史移植；`validate-memory-quality` 承接完整故障与恢复评估；`add-shared-authority-backend` 承接 PostgreSQL、server-side lease/fencing、多机 ordering、backup/restore 和跨 backend migration/conformance。通用 event replay/全库 rebuild 随后续 authority 演进交付。这些能力不属于本次实现承诺或 release gate；本期固定序号 continuation cursor、doctor 和 projection/outbox 幂等 reconcile 仍是必需能力。
