# Spec Delta

## Scope

本变更交付单机默认 Markdown Brief/Index、字段白名单、L0/L1 trust gating、generation manifest、原子发布、Engagement 权限和本地 Git checkpoint。完整攻击面图、关系投影与跨主机共享属于后续 engagement-memory/authority 变更。

## MODIFIED Requirements

### Requirement: Generate allowlisted Markdown projections
系统 SHALL 默认从已提交 authority 生成 Markdown projection。projection 使用显式字段白名单，排除 Artifact 原文、SecretRef、token、私有路径、未审 proposal 和敏感 draft。L0 和未请求的 L1 candidate 不得进入默认 Brief/Index 普通事实；显式 candidate view 必须标出 trust、provenance、limitations。完整 generation 必须包含 manifest hash、authority sequence、projected watermark 和文件 hash；发布必须原子切换 current，保留仍被 reader pin 的旧 generation。Brief 至少展示 scope、active WorkItem、阻塞和 handoff；Index 至少展示 Engagement 内资源/coverage gap 的白名单索引。完整 typed attack-surface graph、stale/conflict 影响传播在后续变更交付。

#### Scenario: Generate a projection
- **WHEN** an authority generation is committed
- **THEN** Taric atomically publishes a complete Markdown generation using only allowlisted fields

#### Scenario: A field is not allowlisted
- **WHEN** a stored field has not been approved for projection
- **THEN** that field is omitted from Markdown and model-facing output

#### Scenario: Read during projection switch
- **WHEN** a client reads during generation publication
- **THEN** it sees one complete old or new generation with a matching manifest

### Requirement: Control projection sharing
The system SHALL enforce Taric engagement permissions when serving or sharing Markdown projections. Projection files SHALL remain derived views and SHALL NOT become the canonical state source. Requests SHALL identify a principal and engagement, not arbitrary filesystem paths or caller-asserted permission booleans.

#### Scenario: Read projection without engagement permission
- **WHEN** a principal lacks access to an engagement projection
- **THEN** Taric denies the read

#### Scenario: Read another projection path
- **WHEN** a client supplies a path outside the requested engagement generation
- **THEN** Taric denies the request without reading that file

### Requirement: Local Git checkpoint by default
系统 SHALL 默认启用并为每个 authority generation 创建本地 Git checkpoint；operator 可显式关闭并在状态中标明。checkpoint 绑定 projection manifest、authority sequence 和文件 hash，失败标记为 pending/failed 并可重试，不回滚 authority。远端 push 只在每 Engagement 显式配置私有 repository、access control、retention policy 和成功 secrets-scan callback 后允许，不根据布尔自报声明安全。

#### Scenario: Local checkpoint
- **WHEN** a committed authority generation is checkpointed under default settings
- **THEN** the checkpoint remains in the local repository and is not pushed remotely

#### Scenario: Remote push is requested without safeguards
- **WHEN** remote push is requested but any required engagement repository setting is missing
- **THEN** Taric does not push the checkpoint and reports the missing configuration

#### Scenario: Checkpoint or scan fails
- **WHEN** local commit fails or a required secrets scan does not pass
- **THEN** Taric retains the authority generation, records pending or blocked checkpoint status, and does not push remotely

## Follow-up Boundary

`evolve-engagement-memory` 承接完整关系图、ResourceRevision/PatchSet/ImpactEvent 的 Markdown 导航和 stale/conflict 传播。本期远端 Git push 仅在已配置的 callback 可执行且通过全部防护时支持，不实现远端仓库管理或 Artifact scanner。
