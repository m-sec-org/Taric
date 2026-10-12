# shared-authority-backend Specification

## Purpose

在明确需要多主机共享同一 Taric authority 时提供 PostgreSQL 后端、服务端租约和可验证备份恢复；单机默认继续使用 SQLite 且不依赖 PostgreSQL。

## Requirements

### Requirement: Explicit optional shared authority

Taric SHALL 只有在 operator 明确选择 multi-host authority profile 时启用 PostgreSQL。single-host default MUST 无 PostgreSQL 配置、服务可用性或依赖要求。配置 SHALL 暴露 backend、schema/policy digest、host/lease mode 和 enabled 状态；缺少 shared service 时不得静默降级为共享 SQLite 文件或独立副本。

#### Scenario: Default single-host deployment
- **WHEN** operator 使用默认 single-host configuration 启动 Taric
- **THEN** system 使用 SQLite，PostgreSQL 不在启动或发布依赖中

#### Scenario: Explicit multi-host without service
- **WHEN** operator 选择 multi-host profile 但 PostgreSQL service/configuration 不可用
- **THEN** system 返回 stable unavailable/blocked diagnostic，不写入 authority，也不降级为伪共享部署

### Requirement: Equivalent PostgreSQL authority semantics

启用后 PostgreSQL SHALL 对 transactions、conditional writes、UUIDv7/display ID allocation、audit commit ordering、idempotency、outbox、snapshot、server-side lease/heartbeat/reclaim/fencing 和 pinned reads 提供与 SQLite storage contract 等价的外部行为。多主机 event sequence、display sequence 和 generation MUST 全局唯一且单调。

#### Scenario: Concurrent multi-host commits
- **WHEN** 多个 host/Engagement 并发提交 authority mutations
- **THEN** 至多一个冲突 base version 成功，每个成功 commit 有唯一 ordered event/display ID，迟到 generation 被拒绝

#### Scenario: Reader during shared publication
- **WHEN** authority 或 projection generation 在多主机发布期间变化
- **THEN** reader 只看到固定 sequence 下的完整旧代或新代，并暴露 derived watermarks

### Requirement: Portable multi-host backup and recovery

PostgreSQL snapshot/backup/restore/migration SHALL 带 schema version、source authority sequence、integrity metadata、Engagement identity、provenance 和 revision information。restore/import MUST 在临时目标完成验证后原子切换；失败不得部分修改 destination，并报告 recovered sequence、backup timestamp、verification 和 unresolved errors。

#### Scenario: Valid restore
- **WHEN** operator 将兼容 backup 恢复到空或明确目标 authority
- **THEN** records、events、sequences、leases policy 和 revisions 等价于备份且报告 recovered sequence

#### Scenario: Invalid restore
- **WHEN** backup integrity/schema/reference/conflict 检查失败
- **THEN** restore fails without destination mutation and reports repair action

### Requirement: Reject unsupported pseudo-multi-host deployments

Taric SHALL 检测 shared SQLite files、NFS locks、shared Git clones 和 independent SQLite replicas，并以 stable unsupported deployment error 拒绝将其宣称为 shared authority。Git/Markdown projection 仍为派生视图，不得提供 authority locking 或 event ordering。

#### Scenario: Shared SQLite path
- **WHEN** 两个 host 使用 shared SQLite path 或独立副本宣称同一 authority
- **THEN** startup/health 检查拒绝部署并指出需要 PostgreSQL shared service

### Requirement: Conditional conformance and release evidence

PostgreSQL 与 SQLite SHALL 运行同一 storage conformance suite，覆盖 transaction atomicity、CAS、ID allocation、audit/outbox ordering、lease/fencing、snapshot、backup/restore、reader pin 和 failure recovery。multi-host compatibility/runbook 只有在 required gates 通过后才能标记 enabled；single-host release report SHALL 明确 Phase 5 enabled/disabled。

#### Scenario: Conformance mismatch
- **WHEN** 任一 backend 在 externally visible behavior 上与另一 backend 不一致
- **THEN** multi-host release 标记 failed，不能报告 enabled

#### Scenario: Conditional release
- **WHEN** operator 未启用 multi-host profile
- **THEN** single-host release 可通过其自身 gates，并将 PostgreSQL Phase 5 标记 disabled
