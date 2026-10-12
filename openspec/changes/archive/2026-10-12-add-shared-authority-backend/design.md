# Design

## Context

设计 `docs/taric-design.md` §4.2.3、§7.1、§7.2、§7.3、§14.5、§15.1 和 §16 将 PostgreSQL 定义为条件性的多主机 authority。SQLite 是默认单机后端；共享文件、NFS 锁、共享 Git clone 和多个 SQLite 副本均不提供 Taric 所需的一致性。

单机/多机边界、存储不变量、恢复数据和验收映射以同目录 `coverage.md` 为索引。

## Goals / Non-Goals

**Goals:**

- 通过统一 storage contract 让 PostgreSQL 与 SQLite 对外产生等价 commit/CAS/ID/audit/outbox/snapshot 行为。
- 使用数据库服务端 sequence/transaction/lease fencing 保证多主机并发和 reader pin。
- 提供显式启用、备份恢复、迁移、健康诊断和“不支持伪多机部署”的运行手册。

**Non-Goals:**

- 不让 PostgreSQL 成为单机默认依赖，不自动切换后端或把多主机作为首发阻塞项。
- 不实现通用分布式调度、worker manager、跨 Engagement 共享或目标动作执行。
- 不把对象存储、Git 或 NFS 当 authority，不改变宿主 artifact/credential 责任。

## Decisions

### 1. Explicit deployment profile

配置只有在 operator 明确选择 `multi_host_authority` 且提供 PostgreSQL service 时启用。默认 profile 只加载 SQLite；启动诊断报告 backend、schema/policy digest 和 lease mode。缺配置时拒绝多机声明而不回退成不安全共享 SQLite。

### 2. Shared storage contract

PostgreSQL 实现同一 storage interface，使用事务、唯一约束、server-side sequence、行锁/条件更新、server-side lease expiry/fencing 和 outbox ordering。conformance 使用相同场景验证 SQLite/PostgreSQL 的外部行为，不复制 Core policy。

### 3. Snapshot and recovery

多机 snapshot、backup、restore 和 migration 绑定 authority sequence、schema/integrity metadata。restore 先进入临时目标，验证 hash/reference/conflict 后原子切换；失败不污染 destination。reader pin 只读完整 generation。

### 4. Unsupported deployment guard

检测 shared SQLite path、NFS lock、shared Git clone、独立 SQLite replicas 或多个不共享 authority service 的 host，并返回 stable unsupported deployment error。Git 仍是 projection checkpoint，不是 authority。

## Risks / Trade-offs

- [PostgreSQL 服务不可用] → 只阻止 multi-host authority 写入并报告恢复状态，single-host SQLite 不受影响。
- [数据库版本差异] → 锁定支持窗口、migration manifest 和 backend conformance。
- [备份恢复滞后] → 报告 recovered sequence/backup timestamp，恢复后要求 reader/lease 重新验证。
- [误把 fallback 当共享一致性] → 显式 deployment guard，禁止静默降级到共享文件或独立副本。

## Migration Plan

先在 offline environment 运行 SQLite snapshot/backup dry-run 和 PostgreSQL schema migration，再启用独立 multi-host profile。迁移窗口停止旧 authority 写入，导入验证后的 snapshot，重新签发 server-side leases，运行 conformance 后开放 host。回滚切回匹配版本的 SQLite snapshot；不删除已提交事件。
