# Spec Delta

## MODIFIED Requirements

### Requirement: Artifact session catalog and external payload boundary
系统 SHALL 将 Artifact task-session binding、resumable upload state、committed metadata、chunk hashes/offsets/relative paths 和 commit audit event 保存到当前 SQLite authority，并对 session/catalog/chunk reference 提供查询索引。原始 payload bytes SHALL 只保存在配置内容根下的注册 task-session 文件 spool，不进入 SQLite Artifact catalog body、authority event、Markdown projection 或 snapshot。bind SHALL 验证 session root 位于配置内容根目录下，并拒绝路径逃逸。Artifact 文件发布与 SQLite catalog commit 不是同一个原子事务；启动 doctor/reconcile SHALL 识别 publication marker、孤儿或缺失内容的可恢复状态，但不得把未验证的 spool 标为可用。读取缺少 manifest/chunk 或发现 chunk length/hash 不匹配时 SHALL fail closed 并返回 unavailable/integrity error；Taric 不得静默创建、修复或删除原文。

#### Scenario: Persist the Artifact catalog association
- **WHEN** an authenticated host commits a complete upload
- **THEN** Taric writes catalog metadata, chunk locator rows, upload removal, and the `artifact.content.committed` audit event atomically in SQLite while payload bytes remain in the task-session filesystem

#### Scenario: Filesystem and SQLite publication are interrupted
- **WHEN** the process stops between payload publication and SQLite catalog commit
- **THEN** doctor/reconcile reports the pending marker or orphan state with an explicit recovery result, and no unverified content becomes available

#### Scenario: Stored content is missing or tampered
- **WHEN** a known Artifact manifest/chunk is missing or its length/hash differs from catalog metadata
- **THEN** Taric fails closed with a structured unavailable or integrity error and never treats the payload as verified Evidence

## ADDED Requirements

### Requirement: Bounded authority reads and operator maintenance
引用校验、列表和读取 SHALL 使用可观测的有界/批量路径：跨对象引用检查必须按引用集合查询，常用 Engagement/kind/version 查询必须有相应索引，列表必须支持稳定 keyset 分页。固定 snapshot/export 可以物化与数据量相关的结果，但 SHALL 单独报告耗时、峰值内存和 source sequence；不得把小 fixture 的 p95 结果外推为大规模保证。doctor、verify、reconcile 和 snapshot export SHALL 是 operator-only 维护操作，并可在独立 CLI/worker 进程执行而不改变 SQLite 单写者事务语义。

#### Scenario: Validate references at scale
- **WHEN** a proposal contains many references in a large authority
- **THEN** the service validates the set with indexed/batched queries and returns the same isolation result without one full-table scan per reference

#### Scenario: Page a large list
- **WHEN** an operator lists records beyond one response page
- **THEN** the service returns a stable keyset cursor bound to filters and read sequence without duplicates or omissions

#### Scenario: Run maintenance concurrently
- **WHEN** an operator runs doctor, verify, reconcile, or snapshot export while writers are active
- **THEN** the operation is authorized separately, reports its pinned sequence/watermarks, and does not bypass writer transactions or silently alter authority history
