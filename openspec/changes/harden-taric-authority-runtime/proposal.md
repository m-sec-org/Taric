# Proposal

## Why

Taric 已经具备单机 authority、治理、固定快照、Artifact spool 和多入口 API 的骨架，但当前实现与规格之间仍有几处会影响发布判断的边界：canonical identity 仍可由调用方提供，proposal 可能先落库再暴露领域错误，公开 admission 路径没有明确区分 L1 结构准入与 L2 独立审核晋升，MCP 默认使用易失的 `:memory:` authority，且 PostgreSQL、cursor、维护操作和能力声明缺少可执行的运行时契约。评审文档已用源码证据确认这些问题，现将修订后的判断固化为可实施的分阶段变更。

## What Changes

- **BREAKING** 明确新建 canonical record 的 ID 由 Core writer 分配 UUIDv7；更新使用独立的 `target_id`/`subject_ref` 与 expected version，不再把 caller-provided `content.id` 当作 canonical identity。
- **BREAKING** 将 proposal 写入拆成 envelope 校验和 domain candidate 校验；非法字段、枚举、格式、Engagement、subject/kind 不一致和特权字段在写入边界返回结构化 `validation_error` 且不改变状态，合法但等待证据或审核的 proposal 仍可显式保持 pending/quarantine。
- 明确 L1 admission 是结构/引用/版本的确定性准入，L2 finding promotion 才执行独立 reviewer 与完整 policy hard gates；对外暴露对应的显式操作或稳定错误，不再把 `admission.evaluate` 默认为已完成 L2 治理。
- CLI 与 MCP 使用同一 authority resolver；single-host 默认落到持久 SQLite，显式 multi-host profile 才尝试 PostgreSQL，缺失 shared service 时 blocked/unavailable 且不回退为伪共享部署。
- 为引用校验、列表和固定快照建立规模化契约：批量引用查询、必要索引、keyset 分页、量化 10k/50k 基准，并把 snapshot/export 的 O(N) 物化成本单独报告。
- 使 context cursor 的密钥可跨进程/重启验证，cursor 仅保存固定快照、过滤、偏移和已交付 ID 等可重建状态；增加篡改、跨 principal、无重复/遗漏测试。
- 将 doctor、verify、reconcile、snapshot export 作为 operator-only 维护操作隔离；在证明必要性前不改变 SQLite 单写者事务模型。
- 补齐 adapter RPC 多行分帧、结构化错误 code、能力 metadata 一致性检查、Artifact 内存/耐久性基准和真实质量证据 provenance。

## Capabilities

### New Capabilities

无。本变更固化并修订已有 Taric capability 的行为契约。

### Modified Capabilities

- `engagement-memory`: writer-owned UUIDv7 identity、proposal/domain 写入校验、更新目标语义。
- `memory-governance`: L1 admission 与 L2 independent promotion 的边界、重校验和原子状态转换。
- `taric-runtime-api`: 统一 authority 解析、持久化默认值、显式治理操作、稳定错误和入口能力边界。
- `authority-storage`: 批量引用/分页/快照规模契约、维护操作隔离和 Artifact 耐久性测量边界。
- `shared-authority-backend`: PostgreSQL service facade、conformance gate、blocked 而非 SQLite fallback 的 multi-host 运行时语义。
- `advanced-context-recovery`: 可持久验证的 cursor 密钥与可重建 continuation 状态。
- `artifact-content-storage`: 上传峰值、chunk/fsync profile 和中断恢复的可测量耐久性契约。
- `quality-evaluation`: capability state/evidence metadata、规模基准、质量证据 provenance 与 release gate。

## Impact

影响 `packages/core` 的 identity、store、policy、service、context、artifact store、shared-authority 和 error mapping；影响 `packages/cli`、`packages/mcp` 的启动解析和 operation inventory；影响 schemas、release-support/conformance tests、文档与 runbook。需要同步更新 snapshot/export、proposal/admission、CLI/MCP/adapter 合约和现有测试 fixture。SQLite 仍是 single-host 默认后端；PostgreSQL 只有在 multi-host profile 的原语和 conformance gate 通过后才可启用。
