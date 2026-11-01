# Taric 1.0.3 面向 BreachWeave 的控制面合同评估与改进建议

> **后续状态（2026-11-01）**：本文结论描述锁定源码基线 `2314880`，其缺口不能作为当前状态。当前 Taric `1.0.4` 已提供 ScopeRevision/ROE、完整 Coverage snapshot、Action audit query、ReportSnapshot/CloseDecision；本轮还修复了缺少已批准 ScopeRevision 时创建 WorkRun，以及无 revision 旧 WorkRun 续租/推进/写 Action 或 run-bound Artifact 的绕行路径。Taric workspace 全量测试通过，原评审列出的四项 P0 合同阻塞已在 Taric 侧处理。BreachWeave 本地 acceptance 必须针对新源码重新运行，生产部署验收仍未完成。当前结果见[控制面验证记录](taric-103-breachweave-control-plane-verification.md)。

> 基于锁定的 Taric 源码与 BreachWeave 本地集成验证，聚焦授权渗透工作流的可恢复控制面。

- 评估日期：2026-11-01
- Taric 基线：`23148800ca08595ffce0c7ee83a88f190c245633`（本机 checkout `main`，工作树干净）
- BreachWeave：`taric-103-recoverable-pentest-control-plane` 变更
- 建议性质：上游合同与运行时改进建议；本文没有修改 Taric 实现或其 API 合同

## 1. 结论

Taric 1.0.3 已提供 Scope 版本历史、Coverage gate、Action 推荐/决策/结果/reconcile 操作，以及 Artifact 内容存储。这些能力能够支撑若干本地 fixture，但还不能让 BreachWeave 在公共、跨传输、可重启恢复的合同上证明治理事实完整。因此 BreachWeave 在授权项目发生受治理写入前执行 fail-closed 检查，返回 `TARIC_CONTROL_PLANE_CONTRACT_BLOCKED`。

主要合同缺口有四类：

1. Scope/ROE 没有一等不可变修订身份和已验证的策略摘要。
2. Coverage 的公共读取接口不能同时提供完整域和真正固定的分页快照。
3. Action 写链存在，但缺少公开、完整、按水位固定的历史审计读取面和结构化网络 provenance。
4. 没有 canonical ReportSnapshot 和 CloseDecision 类型及操作。

其中，Scope 有 `id`、Core 管理的整数 `version`，历史版本也能通过 `record_versions` 查询。因此准确问题不是“Scope 没有历史”，而是缺少独立 ScopeRevision 身份，以及将 ROE 内容、规范化授权策略与该修订绑定的公共合同。类似地，Taric 内部有 Coverage gate 计算能力，也有 Action 写操作；阻塞来自公开查询语义和治理记录合同不足。

BreachWeave 最新控制面报告记载 `implementationChecks=passed`、`localAcceptance=blocked`、`productionAcceptance=unverified`。Taric 合同审计 `18/18` 表示缺口诊断断言可复现，不表示整合已通过。[BreachWeave 合同审计](../../BreachWeave/docs/taric-103-contract-blocker-audit.md) · [控制面报告](../../BreachWeave/docs/artifacts/taric-103-control-plane-local.json) · [本机运行手册](../../BreachWeave/docs/taric-103-control-plane-local-runbook.md)

## 2. 阻塞项、源码事实与影响

### 2.1 Scope/ROE 修订身份不完整

Taric 的 [`Scope` 类型](../packages/schemas/src/types.ts#L290-L297)包含 `allowed_targets`、`excluded_targets`、字符串 `rules_of_engagement_ref`、可选有效时间和备注。Schema 对未知字段采取封闭校验，见 [Scope JSON Schema](../packages/schemas/schemas/v1/core.schema.json#L720-L763)。Scope 的提交会递增记录版本并写入 `record_versions`，所以历史内容可查询；但 proposal subject 列表没有 `scope_revision`，也没有 ScopeRevision UUID、ROE 专用 Artifact 绑定和验证过的 policy digest。参见 [`proposalSubjectContracts`](../packages/core/src/validation.ts#L181-L183)。

这意味着当前 WorkRun、Checkpoint 和 Action 能绑定 Scope ID/version，却不能引用一个独立、不可变、具有明确 ROE 内容摘要的授权版本。Host 可以自行计算摘要或保存一份 opaque Artifact，但这不等于 Taric 分配并验证的 canonical ScopeRevision。

**影响：**无法可靠判断运行中的任务、已记录的 Action、Coverage 和报告是否仍基于当前获批的授权规则；Scope 修改后的失效与重审也缺少统一、可查询的依据。相关 BreachWeave 任务包括 1.5、2.8、4.5、4.7、5.3 和 5.7。

### 2.2 Coverage gate 有实现，公共查询不能证明完整固定域

Taric 注册了 `coverage.query`、`coverage.record` 和 `coverage.gate`。内部 [`coverageGateSnapshot`](../packages/core/src/coverage.ts#L263-L274)也能计算 gate 与读取水位。但公共查询有两处语义缺口：

- `coverage.query` 的 cursor 包含 `read_seq`，实际查询主体仍从当前 `records` 表读取，没有按该序列读取历史版本。跨页更新时，同一个 cursor 水位可能观察到不同状态，见 [`coverageQuery`](../packages/core/src/store.ts#L3144-L3169)。
- 通用 `resource.query(kind=coverage, as_of)` 能读固定历史版本，但 [`recordsPage` recall 过滤](../packages/core/src/store.ts#L475-L492)会排除 `inconclusive`、`recall_excluded`、过期或待 review 记录。`inconclusive` 是有效状态，也是 gate 应披露的未解决缺口，不能从完整授权 Coverage 域里静默消失。

此外，Coverage 查询先扫描有界记录，再在应用层过滤 resource/category/status。过滤稀疏时，扫描预算可能先耗尽，导致结果集不足或截断。关键实现见 [`AuthorityStore.coverageQuery`](../packages/core/src/store.ts) 和 `recordsPage`。

**影响：**BreachWeave 可以读取一组 recall-visible Coverage，但不能将其宣称为完整、固定的 gate 快照；也不能据此证明所有 manifest cell 都已覆盖、合理标记为 `not_applicable`，或明确留有 gap。相关任务包括 4.3、5.1、5.3、5.6、5.7 和 6.4。

### 2.3 Action 写操作存在，完整公共审计读面缺失

操作目录包含 `action.recommend`、`action.host-decision`、`action.host-result` 和 `action.reconcile`，见 [`operationContracts`](../packages/schemas/src/registry.ts#L115-L118)。run-bound 写入会校验 WorkRun、Attempt、owner 和 generation，但 [`recordActionIntent`](../packages/core/src/store.ts#L3368-L3404)更新 `action_intents` 当前状态，并写入 sidecar/audit event；它没有为每次转移提供统一的 canonical、不可变、可按 `read_seq` 查询的历史记录。`work.resume` 主要提供待处理的 `authorized`/`unknown` Action，不能用于重建完整历史，见 [`pendingActionIntents`](../packages/core/src/store.ts#L3407-L3416)。`artifact.session.output` 是独立的执行游标，其水位不是跨操作固定的 Authority `read_seq`。内部 `AuthorityStore.events()` 也不是 57 操作公共 registry 中的 transport-neutral 查询合同。

此外 [`ActionIntent` 类型](../packages/schemas/src/types.ts)的 Scope、decision、result 信息主要是自由文本引用；它没有结构化绑定 ScopeRevision、批准的 DNS 地址集合、实际连接地址、协议/端口、地址族、redirect hop 与时间窗的字段。不得依赖未声明字段偶然透传来补此合同。

**影响：**当前 fixture 能验证推荐到执行、unknown 和显式 reconcile 的具体路径，但重启后无法通过公共水位查询重建完整 ActionIntent/decision/result/reconcile 历史，也不能把目标连接事实作为规范化审计数据取回。相关任务包括 2.5、2.7、4.5、4.7、5.4、5.7 和 6.4。

### 2.4 ReportSnapshot 与 CloseDecision 不存在

公开 [`operationContracts`](../packages/schemas/src/registry.ts#L78-L136)没有 report snapshot 或 Engagement close 操作；[`proposalSubjectContracts`](../packages/core/src/validation.ts#L181-L183)也没有 `report_snapshot` 和 `close_decision` subject。Taric 能保存报告 Artifact 及其 digest，但不会因此验证并固定报告与 Engagement、manifest、Scope/Resource revisions、Evidence snapshot 和 Coverage gate 水位之间的关系。`snapshot.export` 也不能替代缺失的 canonical facts，且其导出范围不包含完整 run-bound Action 历史与 Artifact catalog。

**影响：**Host 可以在本地生成完整性受检的报告文件，但不能证明它是由 Taric 在完整 Coverage/Evidence 水位上接受的 canonical snapshot；关闭状态留在本地也不能在进程重启或删除报告索引后恢复。相关任务包括 2.1、2.7、5.3、5.4、5.6、5.7 和 6.4。

## 3. Taric 改进建议

### P0：补齐使授权本地验收可成立的 canonical 合同

建议将以下工作纳入一个有版本变更说明、迁移设计和明确验收用例的上游合同演进，而不是由宿主用本地文件模拟 authority。

#### 3.1 增加 ScopeRevision 与可验证 ROE

定义不可变 `scope_revision` record，建议至少包含：

- authority 分配的 `id`、`engagement_id`、`scope_ref`、修订序号及 `supersedes`；
- 规范化后的授权目标、排除项、协议、端口、方法、DNS/redirect 约束和有效时间；
- `roe_artifact_ref`、Artifact version、内容 SHA-256 和 `policy_digest`；
- 评审主体、创建时间、批准状态、失效时间及失效原因。

ROE 不应只保存为自由字符串。Schema 应校验域名/IP/CIDR、端口范围、协议/方法、时间窗和冲突规则；对无法规范化或有歧义的输入拒绝授权。建议提供类似 `scope.revise(expected_version, policy, roe_artifact_ref, idempotency_key)` 的操作，并以一个 Authority 事务原子地产生不可变 revision、更新当前 Scope 指针及写入审计事件；配套 `scope.query(scope_id, as_of/read_seq, cursor)` 用于重建历史。

Scope/ROE 的生效必须可被查询。WorkRun、Checkpoint、Action、Coverage 评估和 ReportSnapshot 均应存储精确的 `scope_revision_ref`/`policy_digest`，而不只存 Scope ID/version。revision 改变后，Taric 应提供受影响活动对象清单或至少确保后续恢复和 gate 查询会检测到旧 revision，并要求 host 明确停止、replan 或重新授权；不能改写旧 revision。

#### 3.2 提供真正固定、完整域的 Coverage snapshot

可修正现有 `coverage.query`，也可新增 host/operator 专用 `coverage.snapshot`；关键是写入合同并被所有支持的 transport 实现，而不只是内部 helper：

- 输入绑定 Engagement、manifest/项目范围、ScopeRevision、查询过滤和 `read_seq`；分页时从 `record_versions` 读取同一个 `read_seq`。
- Cursor 绑定 principal、Engagement、manifest/filter、信任级别、visibility 模式、page size、`read_seq`，并有签名和明确的过期错误。
- 完整域模式明确包含哪些 recalled/expired/review 状态和 L1/L2 候选；所有有效状态均须显式返回。`inconclusive` 必须作为 gap 返回，不能被 recall 策略静默移除。
- 响应包含 `read_seq`/`read_time`、预期 cell 数、返回 cell 数、缺失项、gap 摘要、`completeDomain`、visibility/exclusion disclosure、截断状态及 snapshot digest。
- `coverage.gate` 应基于同一个 snapshot 计算并返回结果，或接受 snapshot token 后复用该水位；不能在读完 Coverage 后另取一个当前水位。
- Coverage 记录继续执行 expected-version CAS；补齐 Positive-without-Evidence、`not_applicable` reason、ResourceRevision/ScopeRevision 变更后旧 cell 失效等规则。

将 resource/category/status 过滤条件下推到 SQL，并根据常用的 Engagement/kind/resource/status/read sequence 建立索引。返回扫描数和返回数，以区分“结果为空”与“预算内没有扫完整”。如果 gate 是 manifest-scoped 而不仅 Engagement-scoped，API 应明确表示 scope，避免宿主过滤后将子集 gate 称作 Taric 全域 gate。

#### 3.3 增加 append-only ActionEvent 与固定水位查询

保留 `action_intents` 作为当前状态投影，但将推荐、授权/拒绝、执行、结果、unknown、reconcile、迟到结果隔离等每次状态变化写成独立、不可变的 canonical `action_event`，事件与当前投影在同一事务提交。建议字段包括：Action/Engagement/WorkRun/Attempt/generation/owner、ScopeRevision 与 policy digest、事件序号和时间、请求与结果 digest/reference、状态、幂等键及 actor。

网络 provenance 需要结构化保存批准的解析地址集、实际 pin 地址、IP family、协议/端口、redirect chain 和每次决策时间；不得保存目标凭据或原始响应正文。为 host/operator 提供 `action.audit.query`，支持按 Engagement、WorkRun、Attempt、generation、Action 和状态过滤，按 `read_seq` 固定分页，并能从 Authority 状态重建完整链。区分 Action 当前投影和历史事件，避免把 sidecar metadata 当成 canonical audit history。

明确各 Action 操作的幂等语义与重放边界。非幂等的实际网络调用结果不确定时，不得自动重试目标流量；reconcile 应使用稳定的 Action 引用与可信执行收据。旧 generation 的迟到结果应记录为 quarantined/stale audit 事实，不能覆盖当前状态或影响 Coverage。

#### 3.4 增加 ReportSnapshot 与 CloseDecision，并消除关闭竞态

定义不可变 `report_snapshot`，绑定 Engagement、manifest digest、ScopeRevision、完整 ResourceRevision 集合、Coverage snapshot/gate digest 与水位、Evidence snapshot hash 和已提交 report Artifact ID/version/digest。由 Taric 校验引用及一致性后返回 snapshot ID；仅有 Artifact digest 不能创建已验证的 ReportSnapshot。

增加 `report.snapshot.commit` 和 `engagement.close`（以及有审计记录的 reopen/supersede 流程）。close 请求引用 snapshot，并提交 expected Authority watermark/revisions；Taric 在一个事务内重新验证 gate 完整、所有版本匹配、没有未终结/未知 WorkRun 或 Action，然后通过 CAS 写入不可变 `close_decision`。水位或 Scope/Resource/Coverage/Evidence 变化必须使旧候选关闭失效，并提供精确原因。CloseDecision 应包含 actor、时间、决策、snapshot 引用、gate 水位和 reason。

报告 Artifact 的内容存储与 Authority DB 未必共享事务。采用可恢复的分阶段发布：Artifact committed、snapshot committed、close decision committed；对中途崩溃提供按幂等键查询/恢复和 orphan Artifact 诊断，不能在 Artifact 存在时推断 close 已完成。

### P1：统一读取、一致性与可观测性

- 为 Resource、Work、Coverage、Evidence、Action 和 Report 提供可共享的 snapshot token，确保多域查询可绑定到同一 Authority 水位；返回 cursor 过期、快照无法维持、visibility 不完整等明确诊断。
- 清楚区分历史固定记录读取与实时状态读取。比如 WorkItem body 可以按水位查询，active WorkRun/lease 是实时联结；API 和类型应明确标记二者的 snapshot 语义。
- 对所有读操作统一 cursor 的 principal、Engagement、过滤器和页数/字节预算绑定；定义最后扫描位置与最后返回位置，避免过滤分页漏项、重复或不前进。
- 使 Operation Registry 描述 request/response schema、角色/能力、是否修改 authority、幂等键要求、重放策略、分页水位语义与 error contract；SQLite、PostgreSQL、embedded、RPC 和 HTTPS transport 必须有相同的契约测试。
- 增加 Coverage 扫描/返回比例、cursor invalid/expired、snapshot truncation、Action unknown/reconcile backlog、orphan Artifact、close stale 和恢复耗时等有界诊断指标。诊断只暴露状态和摘要，不包含 Artifact/凭据内容。

### P2：迁移与生产硬化

- 迁移应支持只读 dry-run、可审查差异、可恢复失败和 rollback。旧 Scope 的字符串 ROE 与旧 Action 当前状态不能凭推断升级成已验证 revision/event 历史；无法证明的记录须标为 `legacy_unverified`/partial，并披露缺失范围。
- 为 PostgreSQL 多主机验收单独测试服务端 lease fencing、并发 claim/close、网络分区后 stale host 隔离、重复或丢响应，以及数据库和 Artifact 内容同时故障的恢复。OrbStack 两容器运行只能证明单工作站配置，不代表跨物理主机故障演练。
- 把 Authority DB、Artifact 内容根、cursor key 和非秘密配置摘要作为一个备份/恢复单元；恢复后先执行 integrity/doctor，再允许 generation 或 lease 重新签发。
- 为 ActionEvent 和其他 append-only 记录定义 retention、分区、归档和审计摘要校验策略。保留“逻辑不可变”与“物理保留期限”之间的清晰语义，避免审计历史无限增长或被静默删除。
- 若增加 operation、subject 或持久字段，同步更新 API/schema/storage 版本和 capability discovery；提供最小 clean-consumer 与旧数据库迁移验证。不要让调用方根据版本号以外的实现细节猜测新能力是否存在。

## 4. 建议的实施顺序与验收门槛

| 阶段 | Taric 交付 | 必须通过的证据 |
|---|---|---|
| A：Scope 与 Coverage 基础 | ScopeRevision/ROE schema；固定、完整域 Coverage snapshot 和 gate | 历史 Scope 修订读取；并发修改时旧 cursor 仍读旧版本；inconclusive gap 可见；截断/过期快照不能通过 gate；revision 变化使旧 Work/close 前提失效 |
| B：Action 审计 | append-only ActionEvent；按水位分页查询；结构化网络 provenance | action 每种状态转移皆可查询；重启可重建；未知结果不触发目标重放；跨 Engagement、弱角色和 stale generation 均拒绝 |
| C：Report 与关闭 | canonical ReportSnapshot/CloseDecision 与 CAS close/reopen | snapshot 绑定所有引用和 digest；close 与并发写竞争时只允许一方成功；崩溃可查 orphan 并幂等恢复；删除宿主缓存后可重建关闭状态 |
| D：部署证明 | PostgreSQL 多主机、备份/恢复、egress/身份策略 | 独立物理主机与网络分区演练；配套内容与 cursor key 的恢复验证；生产身份撤销、持久 egress 和 retention/DR 报告 |

每阶段至少应有：源码/Schema 与 operation registry 对齐检查、Bun SQLite fixture、PostgreSQL fixture、各 transport 合同测试、进程重启和崩溃注入、角色/Engagement 隔离负例，以及干净 consumer 验证。成功报告需要分别标记上游单测、存储后端、transport、host conformance、本地 fixture、真实部署，避免把其中一种证据替代另一种。

P0 A～C 全部完成且 BreachWeave 完成相应 Planner/Solver/Web 生命周期切换后，才能重新评估本地授权验收。P2 的生产硬化仍是单独的生产启用门槛，不应倒灌成本地 SQLite 验收要求。

## 5. 分清上游阻塞与宿主侧工作

上面四类缺口是锁定 Taric 公开合同的阻塞，不应由 BreachWeave 用本地 Map、报告 JSON、伪造 UUID 或未声明 schema 字段补齐。BreachWeave 已有 Resource/Work admission、Checkpoint/WorkRun SQLite 重启恢复、Taric-managed Artifact/Evidence、loopback HTTP Action fixture，以及明确的合同前置 gate。

Taric 补齐合同后，BreachWeave 仍需把所有授权 Planner/Solver/Web 读写路径切换到可重建的 authority projection，并测试删除本地状态后的重建。实际受控 HTTP executor 也不等于任意 shell、socket、其他 HTTP 客户端都已被持久 egress firewall 管控。每项目 Engagement 隔离、身份轮换/撤销、独立物理主机网络分区和生产 DR 也属于生产侧工作，不能由 Taric API 合同或本机 OrbStack 单独证明。

## 6. 可复现的本机审计入口

以下命令在 BreachWeave checkout 运行，验证当前锁定 Taric 源码。审计输出的 `18/18` 是合同缺口探针通过，不是接受状态：

```sh
cd ~/development/BreachWeave
bun run audit:taric:contract \
  --taric-source=~/development/Taric \
  --output=docs/artifacts/taric-103-contract-audit.json
bun run verify:taric:control-plane \
  --source=~/development/Taric
```

当前工作区报告位置：

- `docs/artifacts/taric-103-contract-audit.json`：记录被检查 Taric 源文件/build digest 和缺口探针。
- `docs/artifacts/taric-103-control-plane-local.json`：记录 BreachWeave source digest、各实现检查与 `localAcceptance`。
- `docs/artifacts/taric-103-work-fixture.json`、`taric-103-artifact-fixture.json`、`taric-103-artifact-governance.json`、`taric-103-actions.json`：记录各本地 SQLite/loopback fixture 的独立证据。

报告重跑后应以机器报告里的 source digest、分母和 acceptance 状态为准；历史 gateway smoke、单机容器和旧版本的成功记录不能替代当前提交的真实多机/生产证据。
