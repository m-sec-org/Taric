# Design

## Context

首发 authority 只能保存基础记录，不能表达资源变体、不可变观察与可变理解的关系，也不能安全合并并发 patch。设计依据为 `docs/taric-design.md` §4.4–4.8、§6–9、§11、§15.1 和 §16；本变更依赖首发的 service boundary，不改变宿主调度责任。

完整章节、数据类型、审查遗漏与验收映射以同目录 `coverage.md` 为准。

## Goals / Non-Goals

**Goals:**

- 保留 observation、checkpoint、host decision 和 evidence 的历史值，同时以 revision 表达当前理解。
- 让非冲突 patch 可确定性合并，冲突进入可审计队列，不使用 timestamp last-write-wins。
- 让依赖变化按 criticality 有界传播，并给宿主返回 revalidation WorkItem/安全边界 delta。
- 让 Context、projection、Git checkpoint 和 snapshot 都绑定 authority sequence/generation，可恢复且不泄漏候选或敏感字段。

**Non-Goals:**

- 不运行影响分析 worker 来调度宿主，不自动关闭或授权外部动作。
- 不存储 Artifact 内容、扫描 secrets、管理凭据或替宿主选择控制规避策略。
- 不交付 PostgreSQL、多主机 lease 或 Phase 4 的 L2 质量门槛。

## Decisions

### 1. 双表示和稳定 identity

Observation/Artifact reference immutable；Resource/Relation/Claim 的当前理解用 revision。logical identity 与 variant 分离，revision 绑定 source observation、validity 和 content hash。直接覆盖 JSON 的方案会破坏 as-of 与证据追溯，因此不采用。

### 2. 有界 PatchSet merge

PatchSet 绑定 base generation、每对象 base version、read/write set。独立字段和关系新增可合并；删除、scope/status、互斥关系必须 CAS；冲突保留双方值、source refs 和 merge status。大批量影响传播返回 continuation/pending watermark，不宣称全图已完成。

### 3. Control applicability 与 coverage

ControlObservation 与 AccessDecisionObservation 分离，绑定 policy snapshot、resource/identity/operation/condition 版本。unknown 不进行控制或 origin 归因；edge block 只产生 blocked-by-control。适用性变化追加事件，历史观察不变。

### 4. Pinned context、projection 和 snapshot

cursor 绑定 principal、Engagement、filters、read_seq、排序和 budget；resume delta 从 checkpoint 到当前 sequence 计算。projection 先生成完整 immutable generation，再原子切换 current pointer。snapshot import 在临时 authority 验证 schema、hash、Engagement 和 sequence 后原子导入。

### 5. Git 边界

默认只创建 local Git checkpoint，并绑定 manifest/authority sequence。远端 push 需要每个 Engagement 明确授权、私有 repository/access/retention 和真实 secrets scan callback；记录 scanner version/result hash，配置 boolean 不能替代扫描结果。远端失败保持 authority，checkpoint 为 pending 并可重试。

## Risks / Trade-offs

- [依赖图规模过大] → bounded batches、continuation 和 pending watermark；宿主决定 revalidation 调度。
- [三方合并误合并事实] → 事实字段、scope、状态和互斥边只允许 CAS；保留冲突证据。
- [snapshot 导入污染 authority] → 临时校验区、完整 hash/reference check 和单事务切换；失败不修改目标。
- [Git/扫描器不可用] → local authority 提交不回滚，记录 pending/blocked 并重试；远端不推送。

## Migration Plan

先为现有基础记录建立 revision/source observation 和 schema migration dry-run；无法证明来源的记录进入 quarantine。再启用 PatchSet/Impact/Context cursor，最后切换 generation projection、local Git 和 snapshot round-trip。回滚使用升级前快照和匹配服务版本，历史事件不原地删除。
