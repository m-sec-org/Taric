# Tasks

任务与设计章节、数据类型、分层指标和 §15 验收的映射见同目录 `coverage.md`。

## 1. Policy and trust transitions

- [x] 1.1 定义版本化 admission policy、risk profile、schema/scope/evidence/freshness/independence hard gates，验证模型 verdict、accept=true 或 caller trust level 不能改变结果。
- [x] 1.2 实现 L0→L1→L2 状态迁移、reviewer capability、固定 evidence snapshot/input hash/policy digest，验证 self-review、失效证据和缺 capability 全部 fail closed。
- [x] 1.3 为高/严重 finding 配置异构 reviewer/model/ruleset 或人工要求，验证相同模型同提示无法单独满足强独立性。

## 2. Coverage, negative, and lifecycle

- [x] 2.1 实现完整 coverage cell 维度与状态机，验证不同 identity/tenant/path/operation/parameter/condition 不被一条结果合并。
- [x] 2.2 实现 bounded positive/negative、反证、blocked-by-control 和 coverage-close gate，验证 edge block 不关闭 origin coverage、negative 不断言 universal absence。
- [x] 2.3 实现 review-after、expiry、supersede、retract、archive、stale/contradicted recall filters，验证当前召回排除旧状态而 as-of 保留历史事件。
- [x] 2.4 让 impact/revalidation 队列、未 ingest 外部结果、冲突 evidence 和 pending watermark 在报告中可见，验证未完成状态不能显示为完整覆盖。

## 3. Poisoning and quality evaluation

- [x] 3.1 建立版本化 web/host positive、negative、blocked、stale、conflict、forged evidence、prompt injection 和 memory poisoning fixtures，验证元数据含预期 trust/coverage outcome。
- [x] 3.2 执行 HTTP/tool/Markdown/proposal/reviewer payload poisoning 与权限旁路测试，验证 policy、writer capability、host authorization、projection allowlist 不变。
- [x] 3.3 按 web/host、risk class、evidence level 分层计算 finding/retrieval precision/recall、unsupported claim、coverage miss、calibration error、FP/FN、传播错误和 review agreement，并报告 sample count/95% CI。

## 4. Doctor, replay, and release report

- [x] 4.1 实现 operation marker pending/applied/indexed/failed/recovered、启动 doctor、hash-chain/sequence/counter/idempotency/outbox/projection drift 检查，验证异常进入显式 repair state。
- [x] 4.2 实现 operator-only preview/replay/rebuild/reconcile，验证派生视图可从 authority event 重建且不静默改写历史。
- [x] 4.3 生成包含 commit/schema/policy/fixture digests、样本量、分层指标、95% CI、失败证据和配置的 release report，验证 required gate 失败会阻止通过。
- [x] 4.4 运行 clean-checkout、100-worker/多 Engagement 并发、崩溃注入、L1→L2 bypass、coverage、poisoning、replay/rebuild 和单机 p95≤2s 闸门，验证缺模型审核保持 proposal-only。
