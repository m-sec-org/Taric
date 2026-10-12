# Spec Delta

## Purpose

为长期渗透测试提供可追溯的资源修订、类型化关系、受界限 patch 合并、依赖影响传播和防护适用性状态；历史观察保持不可变，当前理解可演进。

## ADDED Requirements

### Requirement: Versioned resources and typed relations

Taric SHALL 为每个逻辑 Resource 保持稳定 UUIDv7 identity，并以 immutable ResourceRevision 表达 method/path/parameter/content-type/principal/tenant variant、content hash、source observation、validity 和 supersedes。Typed Relation、TestHypothesis 和 AttackPath SHALL 带版本、来源观察、适用时间、Engagement 引用和 dependency criticality。历史 Observation、Checkpoint 和 host decision MUST 保持原值。

#### Scenario: Changed resource content
- **WHEN** 同一逻辑资源出现新的 bundle、响应或接口 content hash
- **THEN** Taric 创建新 revision，保留旧 revision、source refs 和 as-of 查询能力

#### Scenario: Cross-engagement relation
- **WHEN** patch 将 relation、hypothesis 或 attack path 指向其他 Engagement 的对象
- **THEN** Core 拒绝提交且不泄漏目标对象的 metadata

### Requirement: Bounded patch merge and conflict evidence

PatchSet SHALL 绑定 base generation、per-object base versions、read_set 和 write_set。独立字段与 relation additions SHALL 确定性合并；删除、scope/status、互斥 relation 和事实字段变化 MUST 通过显式 CAS 或 conflict resolution。Conflict record SHALL 保留双方值、source evidence、base/diff 和 merge status，禁止 silent last-write-wins。

#### Scenario: Non-overlapping patches
- **WHEN** 两个 patch 从同一 base 修改不同字段或新增不同 relation
- **THEN** 两者合并且审计记录 base、diff 和结果

#### Scenario: Overlapping patches
- **WHEN** 两个 patch 修改同一事实字段或互斥 relation
- **THEN** Taric 保留双方候选值并将实体放入 conflict queue，不静默选择一方

### Requirement: Bounded dependency impact

Taric SHALL 沿显式 depends_on/derived_from 和字段/criticality 传播 ImpactEvent，支持 bounded batch、continuation 和 pending watermark。影响可标记 claims、hypotheses、WorkItems、coverage、checkpoint applicability、Context、findings、AttackPaths 和 report references stale/revalidation；历史观察、checkpoint 和 host decision MUST 不变。Taric SHALL 返回 revalidation WorkItem 建议，不调度宿主。

#### Scenario: Critical premise withdrawn
- **WHEN** finding 的关键 evidence 或 claim dependency 被撤回或反证
- **THEN** 依赖 finding 从普通高信任召回和新报告中暂停，未执行 action recommendation 标记 stale，并排队复核

#### Scenario: Large impact graph
- **WHEN** 影响超过单批处理容量
- **THEN** 响应暴露 continuation 和 pending watermark，不声称全部下游视图已更新

### Requirement: Protective-control applicability

ControlObservation 与 AccessDecisionObservation SHALL 分离，并绑定 control revision 或 unknown、policy snapshot、resource revision、authentication/session revision、operation、network conditions、evidence 和 limitations。Unknown layer 不得归因具体控制或 origin；origin reached=true MUST 有证据；edge block + origin not reached SHALL 只关闭 blocked-by-control 对应 cell，不关闭 origin coverage。控制变化追加 applicability event，历史观察不改写。

#### Scenario: Unknown layer
- **WHEN** 证据无法确定响应来自 edge、application、identity 或 origin
- **THEN** Taric 记录 unknown/inconclusive，不宣称特定 WAF/RASP 或 origin outcome

#### Scenario: Control revision changes
- **WHEN** control policy 或 access decision premise 发生新 revision
- **THEN** 相关 negative claim、coverage、checkpoint applicability 和 current finding 标记 stale/revalidation，immutable observations 保持原值
