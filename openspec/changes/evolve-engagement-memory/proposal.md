# Proposal

## Why

单机首发提供了基本 Engagement 记忆和恢复边界，但持续渗透测试会不断获得新的 bundle、路由、主体和策略观察；覆盖式更新会丢失历史、并发 patch 会静默覆盖、过期依赖会继续进入上下文。该变更交付 Phase 3 的可追溯版本演进、类型化关系、有限影响传播和高级恢复，仍把 Taric 限定为独立记忆插件。

## What Changes

- 引入稳定 Resource identity、immutable ResourceRevision、method/path/parameter/content-type/principal/tenant variants 和 content hash。
- 引入 typed Relation、PatchSet、read/write set、三方合并、Conflict queue、CAS 和依赖 criticality。
- 实现 ImpactEvent、bounded continuation、revalidation WorkItem，并使受影响 finding、coverage、checkpoint applicability、Context 和 action recommendation stale。
- 补齐 ProtectiveControl applicability、policy snapshot、immutable observations、unknown layer 和 blocked-by-control 传播。
- 增强 Context cursor、resume delta、cache invalidation、draft 封存/rebase，以及 Taric-native JSON/JSONL snapshot export/import。
- 将 Markdown Brief/Index 作为原子 generation；默认只做 local Git checkpoint。远端 push 仅在 Engagement 显式授权、私有配置、保留策略、访问控制和真实 secrets-scan callback 通过后才允许，并记录 scanner tool version/result hash，失败进入 pending/retry。

## Capabilities

### New Capabilities

- `engagement-memory-evolution`: 资源修订、variants、关系、patch 合并、冲突、影响传播和控制适用性。
- `advanced-context-recovery`: 高级 context cursor、resume delta、draft 封存/rebase 和快照迁移。

### Modified Capabilities

- `engagement-memory`: 以 ADDED requirements 增加 Phase 3 版本演进与影响传播行为，不覆盖首发条款。
- `markdown-projection`: 以 ADDED requirements 增加 generation pin、local Git checkpoint 和显式远端授权行为。

## Impact

- 影响 `packages/schemas`、Core revision/merge/impact/context/projection/storage 模块、CLI/API、Markdown/Git worker 和 migration tests。
- 依赖 `complete-taric-runtime-gaps` 归档后的首发 authority、UUIDv7、pinned read、writer capability、WorkRun/checkpoint 和 projection contract。
- 不实现 agent loop、worker 调度、目标工具执行、Artifact 内容保存、凭据、动作授权或跨 Engagement 自动知识共享。
- 该变更只扩展独立插件的可追溯记忆能力，不把 Taric 变成攻击面平台或宿主编排器。

设计章节、数据类型、审查遗漏和 §15 验收的逐项映射见同目录 `coverage.md`。
