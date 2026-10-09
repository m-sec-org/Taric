# 设计覆盖索引

本索引将设计 §1–17 映射到 Phase 3 的版本演进变更。它依赖单机首发 authority、writer/capability、WorkRun 和基础 projection；不会把 Taric 扩展为扫描或调度平台。

| 设计范围 | 本变更承接 | 规格/任务 | 验收证据 |
|---|---|---|---|
| §1–§1.2 产品定位、非目标 | 长期记忆、证据关联、协作恢复；宿主仍负责 Artifact/动作 | proposal/design Non-Goals | §15.1、§15.2 |
| §2 原则与差距 | 不可变观察、可变理解、有限合并、证据优先 | engagement-memory-evolution:1–3；tasks 1–2 | §15.1、§15.2 |
| §3 参考边界 | 不兼容旧 KB/Link 格式，仅迁移可验证 authority | design Migration；tasks 1.1 | §15.3 fixtures |
| §4.1/§4.2 Core/SPI | 复用 Core service/schema；不新增 host runtime | proposal Impact | §15.0 |
| §4.3 WorkRun/Attempt | draft 封存、resume delta、rebase，不调度 worker | advanced-context-recovery:1–2；tasks 3.2–3.3 | §15.1 |
| §4.4 Context Pack | role/risk budget、scope/ROE、证据定位、cursor、manifest | advanced-context-recovery:1；tasks 3.1–3.2 | §15.1 |
| §4.5 projection/Git | immutable generation、Brief/Index、local Git；远端显式授权+真实扫描 | markdown-projection:1；tasks 4.2–4.4 | §15.0.1、§15.4 |
| §4.6 关系图持续演进 | ResourceRevision、variant、Relation、PatchSet、ImpactEvent | engagement-memory-evolution:1–3；tasks 1–2 | §15.1 |
| §4.7 Artifact/认证 | 只保存引用/hash/location，内容由宿主管理 | engagement-memory-evolution:4；design Non-Goals | §15.0.1 |
| §4.8 防护控制 | control applicability、unknown、origin evidence、blocked-by-control | engagement-memory-evolution:4；tasks 1.3、2.4 | §15.0.2、§15.1 |
| §5 状态/信任 | 保留历史状态，影响传播只改 current applicability | engagement-memory-evolution:1–3 | §15.2、Phase 4 |
| §6 数据模型 | UUIDv7、display alias、revision/variant/relation/patch/impact/control | tasks 1.1–1.3 | §15.1 ID/CAS |
| §7 事务/ID/读一致性 | base generation/version、CAS、pinned cursor、snapshot import | tasks 2.1、3.2、4.1 | §15.1 |
| §8 审计/事件 | patch/merge/impact/applicability、Git manifest 和 sequence 可追溯 | tasks 2.2、4.2–4.4 | §15.1、§15.4 |
| §9 幻觉/阴性/coverage | 结构化 negative、coverage gap、control block 不关闭 origin | engagement-memory-evolution:3–4；tasks 1.3、2.4 | §15.0.2；Phase 4 完整 gate |
| §10 守卫 | cross-Engagement、reference kind、unknown layer、CAS 硬门 | engagement-memory-evolution:1、4 | §15.2 |
| §11 召回/生命周期 | Phase 3 提供 stale applicability；完整 expiry/retract/archive 由 Phase 4 | proposal 依赖、design Non-Goals | Phase 4 |
| §12 API/CLI | revise/draft/patch/relation/impact、snapshot import/export、projection status | tasks 2–4、5.1 | §15.0、§15.1 |
| §13 权限 | principal×Engagement×generation/cursor，不能任意 path/boolean | advanced-context-recovery:1；markdown-projection:1 | §15.2 |
| §14 Phase 3 | 完整关系图、影响传播、context cursor、snapshot round-trip | proposal、design Migration | §15.1 |
| §15.0–§15.4 验收 | adapter 共享契约；读一致性、覆盖控制、并发、信任、投毒和发布证据承接到对应 Phase | tasks 5.2 | 各验收组；质量统计由 Phase 4 承接 |
| §16 部署参数 | SQLite 单机、local Git 默认、远端按 Engagement 配置 | markdown-projection:1；tasks 4.3–4.4 | §15.0.1、§15.4 |
| §17 总结 | PTES memory core 的可演进实体和投影 | 全部 proposal/spec | release report |

## 审查遗漏的强制覆盖

- Checkpoint 的 scope/target version、negative results、host decision refs、budget consumption、draft/handoff 和 read_seq 由首发变更依赖，并在 `advanced-context-recovery` resume manifest 中保留引用。
- Context Pack 的 worker role/risk budget、coverage/conflict/stale、证据字节/行/HTTP 定位、source hash/time/revision/permission、builder/token estimator 和截断声明由 `advanced-context-recovery` 覆盖。
- 所有 query/context/cursor/projection/patch/impact/snapshot/reference 都必须检查 principal 与 Engagement；cross-Engagement 不变量由任务 2.3、3.2、5.2 验证。
- operation marker 与启动 doctor 由单机首发 `authority-storage` 交付；本变更承接高级 snapshot import、revision 全历史移植和 context/projection generation，Phase 4 再承接完整 authority replay/rebuild/reconcile 评估。
- local Git 默认提交，remote push 需要真实 secrets scan tool version/result hash/callback，失败 pending/retry。
