# Tasks

任务与设计章节、共享后端数据类型和 §15 验收的映射见同目录 `coverage.md`。

## 1. Configuration and storage contract

- [ ] 1.1 定义 `single_host_sqlite` 与显式 `multi_host_authority` 配置、backend manifest、PostgreSQL 版本窗口和启动 diagnostics，验证默认安装无 PostgreSQL 依赖。
- [ ] 1.2 扩展 storage contract 覆盖 transaction/CAS、UUIDv7/display sequence、audit ordering、outbox、snapshot、backup、lease/fencing，验证 SQLite contract 仍通过原测试。

## 2. PostgreSQL authority

- [ ] 2.1 实现 PostgreSQL schema/migrations、server-side display sequence、unique constraints、transactional event/outbox writes，验证多主机 concurrent commit 无重复/丢事件。
- [ ] 2.2 实现 server-side lease expiry、heartbeat、reclaim 和 fencing generation，验证旧 host/Attempt 的迟到写入被拒绝且归属保留。
- [ ] 2.3 实现 pinned snapshot、reader generation/sequence 和 projected/indexed watermarks，验证 reader 只见完整旧代或新代。

## 3. Backup, restore, and conformance

- [ ] 3.1 实现带 schema/source sequence/integrity metadata 的 PostgreSQL snapshot、backup、restore 和 migration verification，验证损坏/冲突 restore 不改变 destination。
- [ ] 3.2 运行 SQLite/PostgreSQL shared storage conformance、100-worker multi-host、failure/restart、reader pin、lease fencing、event ordering 和 outbox tests，验证外部行为等价。
- [ ] 3.3 检测并拒绝 shared SQLite/NFS locks/shared Git clones/independent SQLite replicas，验证 stable unsupported deployment error 且不静默降级。

## 4. Operational release boundary

- [ ] 4.1 实现 explicit enable/disable、health/version/backup diagnostics，验证 single-host 不受 PostgreSQL availability 影响，multi-host 缺服务明确阻塞。
- [ ] 4.2 编写 multi-host compatibility、migration、backup/restore、lease recovery runbook，验证仅在 conformance gates 通过后报告 enabled。
- [ ] 4.3 输出包含 backend/schema/policy/backup/recovered-sequence 的 release evidence，并验证 single-host report 将 Phase 5 标记 disabled 或 enabled。
