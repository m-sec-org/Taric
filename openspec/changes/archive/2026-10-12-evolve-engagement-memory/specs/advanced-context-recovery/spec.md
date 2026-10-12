# Spec Delta

## Purpose

提供跨长任务和大上下文的可验证 cursor、resume delta、draft 封存/rebase 以及 Taric-native 快照迁移，使宿主可从固定 authority sequence 安全继续工作。

## ADDED Requirements

### Requirement: Advanced context cursor and resume delta

Context Pack SHALL 按 scope/ROE、worker role/risk budget、WorkItem acceptance、latest checkpoint、相关 delta、冲突/过期/coverage gaps、直接实体、证据定位和背景摘要排序。Pack SHALL 固定 source IDs、hash、time、revision、slice metadata、permission、builder/token-estimator/policy versions、omitted/unexamined ranges 和 pinned read_seq。Cursor MUST 绑定 principal、Engagement、filters、ordering、sequence 和 budget，resume SHALL 返回 checkpoint 后的相关 delta，不得跨 Engagement 或跳过条目。

#### Scenario: Mandatory context exceeds budget
- **WHEN** scope、ROE、验收或恢复点无法全部放入请求预算
- **THEN** 服务返回结构化 minimum-budget error 或 continuation，明确未检查范围，不静默丢弃强制约束

#### Scenario: Continue a pinned cursor
- **WHEN** 客户端提交未过期且归属匹配的 cursor
- **THEN** 下一页使用相同 read_seq 和 ordering，无重复/缺项；跨 Engagement 或篡改 cursor 被拒绝

#### Scenario: Resume after impact
- **WHEN** 新 Attempt 从旧 checkpoint 恢复且 authority sequence 已变化
- **THEN** resume packet 包含相关 delta、scope/dependency 变化、pending actions 和 context manifest，并在 premise 无效时返回 blocked/replan-required

### Requirement: Draft sealing and explicit rebase

旧 Attempt 的未提交 draft、late result 和 proposal SHALL 保留原 Attempt/generation 归属并封存；新 Attempt MUST 通过显式 rebase/新 proposal 才能引用它们。过期 lease、旧 generation 或跨 Engagement draft 不得修改当前 authority。

#### Scenario: Stale draft arrives
- **WHEN** 丢失 Attempt 在新 owner 已接管后提交 draft 或 patch
- **THEN** Taric 将其隔离或拒绝为 current state，保留原 attribution，不覆盖新 Attempt

### Requirement: Portable authority snapshot migration

Taric SHALL 支持带 schema version、Engagement identity、source sequence、UUIDv7/display alias、provenance、revision 和 integrity metadata 的 JSON/JSONL snapshot export/import。Import MUST 在临时目标中完成 schema/reference/hash/conflict 校验后原子切换；不兼容或损坏输入不得部分写入，并返回 recovered sequence/verification result。

#### Scenario: Snapshot round-trip
- **WHEN** operator 将兼容 snapshot 导入空 authority
- **THEN** records、revisions、provenance、source sequence 和历史引用等价于导出状态

#### Scenario: Invalid snapshot
- **WHEN** snapshot schema、integrity、Engagement 或 destination conflict 校验失败
- **THEN** import 失败且目标 authority、counter、outbox、projection 不发生变化
