# Proposal

## Why

单机 SQLite authority 满足独立插件首发，但明确需要多主机共享同一 Engagement 时，多个 SQLite 副本、NFS 锁或共享 Git 无法提供全局 fencing、序列和事件顺序。该变更只在部署明确选择 multi-host authority 时增加 PostgreSQL backend 与 conformance、备份恢复证据，不把 PostgreSQL 或分布式平台带入单机默认部署。

## What Changes

- 增加显式 multi-host 配置和 deployment guard；默认 single-host 不依赖 PostgreSQL。
- 为 PostgreSQL 实现与 SQLite 等价的事务、CAS、UUIDv7/display allocator、audit ordering、outbox、server-side lease/fencing、snapshot 和 backup/restore contract。
- 运行双 backend storage conformance、并发 reader pin、故障恢复和迁移验证。
- 拒绝 shared SQLite files、NFS locks、shared Git clones 和 independent SQLite replicas 作为伪多机部署。
- 发布 multi-host compatibility/operations runbook，仅在所有 gate 通过后标记 enabled。

## Capabilities

### New Capabilities

- `shared-authority-backend`: 明确启用时的 PostgreSQL shared authority、备份恢复和多机一致性。

### Modified Capabilities

- `collaboration-state`: 在 multi-host 配置下增加 server-side lease/fencing 与 event ordering 一致性。
- `authority-storage`: 增加可选 PostgreSQL backend 和双 backend conformance；不改变单机默认。

## Impact

- 影响 storage interface、PostgreSQL deployment/configuration、lease/outbox/event ordering、snapshot/backup tooling、diagnostics 和 operations runbook。
- 依赖首发 SQLite authority、UUIDv7/display allocator、pinned snapshot、audit/outbox、WorkRun fencing 和 Phase 3 snapshot contract 归档。
- 不实现跨 Engagement 自动共享、agent/worker 调度、目标工具、Artifact/credential 服务或通用平台控制面。
- PostgreSQL 代码、依赖和服务只在 explicit multi-host profile 启用时加载；single-host release gate 不要求它。

部署边界、共享后端不变量、数据类型和 §15 验收的逐项映射见同目录 `coverage.md`。
