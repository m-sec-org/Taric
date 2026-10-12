# 设计覆盖索引

本索引将设计 §1–17 映射到 Phase 4 质量与信任变更。它依赖首发和 Phase 3 的 authority、revision、impact、context、projection 与快照，评估 Taric 治理本身，不实现宿主扫描或授权。

| 设计范围 | 本变更承接 | 规格/任务 | 验收证据 |
|---|---|---|---|
| §1–§1.2 产品边界 | 质量/治理插件，不做模型、扫描器、动作执行 | proposal/design Non-Goals | §15.2、§15.3 |
| §2 信任、证据、硬门 | non-LLM policy、L0/L1/L2、异构 A/B、fail closed | memory-quality-evaluation:1；tasks 1.1–1.3 | §15.2 |
| §3 参考源码/评估资产 | 版本化 web/host fixture，不承诺旧格式 | quality spec:4；tasks 3.1 | §15.3 |
| §4.1/§4.2 Core/SPI | 复用首发 API/adapter contract，评估权限和错误 | tasks 3.2、4.4 | §15.0 |
| §4.3 WorkRun/Attempt | 报告 checkpoint、lease、action state 完整性和恢复 gate | tasks 2.4、4.4 | §15.1、§15.4 |
| §4.4 Context | 评估 context omission/coverage/pinned sequence，不改变 builder contract | tasks 2.4、4.4 | §15.1 |
| §4.5 projection/Git | canary allowlist、generation、Git checkpoint 可见性 | tasks 3.2、4.4 | §15.0.1、§15.4 |
| §4.6 revision/impact | 反证、stale、传播错误率、pending impact 可见 | engagement-memory:2–3；tasks 2.3–2.4 | §15.1、§15.3 |
| §4.7 Artifact/凭据 | poisoning 只使用 reference/fixture，不读取 Artifact 原文/凭据 | quality spec:4 | §15.0.1、§15.3 |
| §4.8 controls | control/decision 分离、blocked-by-control、origin coverage | engagement-memory:2；tasks 2.1–2.2 | §15.0.2、§15.3 |
| §5 信任状态机 | L1/L2、独立性、review-after/expiry | memory-quality-evaluation:1–3 | §15.2 |
| §6 数据模型 | coverage cells、evidence limitations、review/policy digests | tasks 1–2 | §15.2、§15.3 |
| §7 事务/ID/并发 | 100 worker、ID/event uniqueness、CAS/crash gate | tasks 4.4 | §15.1、§15.4 |
| §8 审计恢复 | operation marker、doctor、replay/rebuild、repair report | memory-quality-evaluation:5；tasks 4.1–4.2 | §15.1、§15.4 |
| §9 幻觉/漏报 | bounded negative、反证、precision/recall、calibration error、95% CI | memory-quality-evaluation:2、4；quality-evaluation:1 | §15.3、§15.4 |
| §10 守卫 | poisoning、权限旁路、unsupported claim、fail closed | tasks 1.1、3.2 | §15.2、§15.3 |
| §11 生命周期/Guard | expiry、supersede、retract、archive、stale、普通/历史召回 | memory-quality-evaluation:3；tasks 2.3 | §15.2 |
| §12 API/CLI | policy/review/coverage/doctor/replay/report 操作的结构化 evidence | tasks 4.2–4.3 | §15.0、§15.4 |
| §13 角色权限 | model/host/operator/writer/reviewer 隔离与 self-review deny | tasks 1.1–1.3、3.2 | §15.2 |
| §14 Phase 4 | policy guard、independent review、coverage、盲测和 release report | proposal/design Migration | §15.2–§15.4 |
| §15.0–§15.4 验收 | 所有 adapter、projection、control、concurrency、trust、quality gate | tasks 3.2、4.4 | 各验收组逐项报告 |
| §16 部署参数 | 不托管签名密钥/HITL；报告配置和 policy/fixture digests | quality-evaluation:4 | §15.3、§15.4 |
| §17 总结 | 质量证据服务于独立插件，不改变宿主责任 | proposal/design 全文 | release report |

## 指标和闸门

报告必须按 web/host、风险类别、证据等级分层，含 sample count、human baseline、finding/retrieval precision/recall、unsupported-claim、coverage miss、calibration error、guard FP/FN、review agreement、传播错误、延迟、恢复成功率和 95% CI。L1→L2 未授权升级、high/critical unsupported claim、已知正样本召回低于 baseline、coverage gap 不可见、100-worker ID/event 失败、projection/adapter contract 失败或 p95 超过单机目标时均不得报告通过。
