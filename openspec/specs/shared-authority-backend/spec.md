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

PostgreSQL backup/restore SHALL remain an internal operator disaster-recovery and isolated backend-conformance capability, with schema version, source authority sequence, integrity metadata, Engagement identity, provenance, and revision information. Internal restore MUST validate the temporary target before switching; failure MUST NOT partially modify the destination and SHALL report recovered sequence, backup timestamp, verification, and unresolved errors. These internal guarantees MUST NOT expose a supported public snapshot import, host-state migration, or general event replay operation. Public service/CLI snapshot import SHALL return `unsupported_capability` before mutation; read-only export MUST NOT be described as a complete backup of Artifact payloads or audit history.

#### Scenario: Valid restore
- **WHEN** an operator restores a compatible backup through isolated internal recovery tooling into an empty or explicitly selected target authority
- **THEN** records, events, sequences, lease policy, and revisions match the backup and the tool reports the recovered sequence without exposing a public host import path

#### Scenario: Invalid restore
- **WHEN** backup integrity, schema, reference, or conflict validation fails
- **THEN** restore fails without destination mutation and reports repair action

#### Scenario: Public import is requested
- **WHEN** an operator or host requests snapshot import through a public service or CLI
- **THEN** Taric returns `unsupported_capability` and does not invoke internal restore or alter destination state

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

### Requirement: Gate shared backend runtime activation
PostgreSQL storage primitives SHALL be exposed through the same Core service facade and policy/governance contract as SQLite before the multi-host profile is enabled. The shared runtime SHALL cover proposals, reviews, L1/L2 admission, checkpoints, actions, Artifact catalog, leases, fencing, audit/outbox, pinned reads, and backup/restore semantics. A backend with only partial primitives SHALL report `runtime_state=disabled` and `implementation_state=available`; it SHALL not construct a partially capable service or silently fall back to SQLite.

#### Scenario: Use a primitive-only PostgreSQL backend
- **WHEN** an operator selects PostgreSQL before the full runtime conformance suite passes
- **THEN** startup returns a stable blocked/disabled capability report and performs no authority mutation

#### Scenario: Enable a conforming PostgreSQL runtime
- **WHEN** PostgreSQL passes the shared SQLite conformance suite and health/lease checks
- **THEN** the service facade enables the multi-host profile with equivalent externally visible operation and error semantics

#### Scenario: Shared backend becomes unavailable
- **WHEN** an enabled multi-host service loses its shared backend or fencing health
- **THEN** new writes are blocked with an unavailable/blocked error and the runtime does not open an independent SQLite authority
