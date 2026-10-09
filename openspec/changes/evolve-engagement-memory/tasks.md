# Tasks

任务与设计章节、数据类型、远端 Git 边界和 §15 验收的映射见同目录 `coverage.md`。

## 1. Versioned domain model

- [ ] 1.1 定义 ResourceRevision、variant、content hash、source observation、validity 和 UUIDv7/display alias 约束，并用 schema 测试验证旧 revision 不被覆盖。
- [ ] 1.2 定义 typed Relation、TestHypothesis、AttackPath、PatchSet、Conflict 和 ImpactEvent 契约，验证引用类型、Engagement 归属、时间适用性和 criticality。
- [ ] 1.3 定义 ProtectiveControl revision、ControlObservation、AccessDecisionObservation 和 applicability event，验证 unknown/origin/blocked-by-control 语义不混淆。

## 2. Patch merge and impact

- [ ] 2.1 实现 base generation/version、read/write set 和三方 merge，验证非冲突字段/关系可合并，删除/状态/互斥关系必须 CAS。
- [ ] 2.2 实现 conflict queue，保留双方候选值、source evidence、base/diff/merge result，并用并发 patch 测试证明无静默丢失。
- [ ] 2.3 实现 bounded ImpactEvent traversal、continuation、pending watermark 和 revalidation WorkItem，验证关键 premise 变化只影响真实依赖。
- [ ] 2.4 让 control/resource/access revision 变化使受影响 claims、coverage、checkpoint applicability、finding、Context 和未执行 action recommendation 标记 stale，并验证历史值不变。

## 3. Context and recovery evolution

- [ ] 3.1 扩展 Context Pack 选择 scope/ROE、worker role/risk budget、WorkItem acceptance、checkpoint、delta、冲突/过期/coverage gap、证据定位和来源 manifest，验证必需约束优先保留。
- [ ] 3.2 实现绑定 principal、Engagement、filters、pinned read_seq、ordering 和 budget 的 opaque cursor，验证续页无 gap/duplicate 且不可跨 Engagement 重用。
- [ ] 3.3 实现 resume delta、context cache invalidation、draft 封存和显式 rebase，验证 stale Attempt 的 draft/late result 不自动进入当前 authority。

## 4. Snapshot and projection

- [ ] 4.1 实现 Taric-native JSON/JSONL snapshot export/import、schema/version/integrity/source sequence 元数据，验证 malformed/conflicting import 原子失败且 round-trip 保留 provenance/revisions。
- [ ] 4.2 实现 Brief/Index distinct allowlisted generation、manifest/file hashes、reader pin 和 atomic current pointer，验证 L0/未请求 L1/敏感字段不出现在 projection。
- [ ] 4.3 默认创建 local Git checkpoint，绑定 manifest/authority sequence，验证 commit failure 保留 authority 并生成 pending/retry 状态。
- [ ] 4.4 仅在 Engagement 明确授权远端 push 时调用真实 secrets-scan callback，记录 scanner tool version/result hash、repo/access/retention 配置；验证 callback 缺失/失败时不 push 且可重试。

## 5. Documentation and conformance

- [ ] 5.1 更新 API/agent guide，记录 revision/patch/impact/context cursor/snapshot import-export/projection Git contract，并验证示例命令与首发 Core 兼容。
- [ ] 5.2 运行并发 merge、impact continuation、cross-Engagement isolation、snapshot round-trip、projection reader pin 和 Git pending/retry conformance tests，输出 sequence/generation 证据。
