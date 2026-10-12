# 设计覆盖索引

本索引将设计 §1–17 映射到条件性 Phase 5 变更。它只在明确需要 multi-host authority 时启用；Taric 仍是独立记忆插件，不是通用分布式平台。

| 设计范围 | 本变更承接 | 规格/任务 | 验收证据 |
|---|---|---|---|
| §1–§1.2 产品与部署边界 | single-host 默认 SQLite；multi-host 显式 profile | shared-authority-backend:1；tasks 1.1、4.1 | §15.1、§15.4 |
| §2 原则 | 事务、CAS、ID、fencing、审计和最小权限在共享后端保持不变量 | shared-authority-backend:2、5 | §15.1、§15.2 |
| §3 参考边界 | 不复用共享 SQLite/NFS/Git 作为 authority | shared-authority-backend:4 | §15.1 |
| §4.1/§4.2 Core/SPI | 统一 storage interface；Core policy 不复制 | design Decisions；tasks 1.2、2.1 | §15.0、§15.1 |
| §4.3 WorkRun/Attempt | server-side lease/heartbeat/reclaim/fencing | shared-authority-backend:2；tasks 2.2 | §15.1 |
| §4.4 Context/reader pin | shared sequence/generation 下固定读取 | shared-authority-backend:2；tasks 2.3 | §15.1 |
| §4.5 projection/Git | Git/Markdown 仍是派生视图，不提供 locking/order | shared-authority-backend:4 | §15.0.1 |
| §4.6 revision/impact | 复用 Phase 3 revision/impact，不在后端复制领域规则 | proposal Impact；design Non-Goals | Phase 3 conformance |
| §4.7 Artifact/凭据 | 后端不存 Artifact body 或 credential | design Non-Goals | §15.0.1 |
| §4.8 controls/actions | 后端不授权/执行动作，仅持久化 shared authority state | proposal Impact | §15.2 |
| §5 trust | 后端不改变 Core trust/policy，仅提供一致事务存储 | tasks 1.2 | §15.2 |
| §6 数据模型 | UUIDv7、display sequence、provenance/revision/snapshot 保真 | shared-authority-backend:2–3 | §15.1 |
| §7 并发/事务/ID | server transaction/sequence/CAS、跨 host 唯一 event/display ID | shared-authority-backend:2；tasks 2.1 | §15.1、§15.4 |
| §8 审计 | ordered event/outbox、backup/restore 不丢 history | shared-authority-backend:2–3 | §15.1 |
| §9 coverage | 后端保留 coverage/impact state，不自行关闭 gap | design Non-Goals | Phase 4 |
| §10 guards | deployment guard 拒绝伪多机，Core guard 继续生效 | shared-authority-backend:4 | §15.2 |
| §11 lifecycle | recovery 只恢复 authority/lease，不能自动重放动作 | shared-authority-backend:3 | §15.1 |
| §12 API/CLI | backend/health/backup/restore/migration diagnostics | tasks 1.1、3.1、4.1 | §15.0、§15.4 |
| §13 permissions | operator explicit enable；host lease/capability 由 Core 验证 | shared-authority-backend:1–2 | §15.2 |
| §14 Phase 5 | PostgreSQL、server lease/order、backup/restore 仅条件交付 | proposal、design Migration | Phase 5 conformance |
| §15.0–§15.4 验收 | dual backend contract、100-worker multi-host、故障、reader pin、restore | tasks 3.2–3.3、4.2 | 对应各验收组；single-host 可独立通过 |
| §16 部署参数 | 默认 SQLite；明确 multi-host 才启用 PostgreSQL | shared-authority-backend:1 | §15.4 |
| §17 总结 | PostgreSQL 是可选 authority backend，不改变插件定位 | proposal/design 全文 | enabled/disabled report |

## 必须保留的不变量

UUIDv7/display sequence、Engagement 隔离、CAS、audit event order、idempotency、outbox、lease generation、pinned read、snapshot integrity、backup recovered sequence 和 unsupported pseudo-multi-host guard 必须由 SQLite/PostgreSQL 同一 conformance suite 验证。任何 mismatch 都阻止 Phase 5 enabled；single-host 默认不因 PostgreSQL 未启用而失败。
