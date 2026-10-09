# 设计覆盖索引

本索引将 `docs/taric-design.md` 的约定映射到本 Phase 2 变更。该变更依赖单机首发 Core；它交付宿主适配器，不把 Taric 变成 agent 平台、调度器或目标执行器。

| 设计范围 | 本变更承接 | 规格/任务 | 验收证据 |
|---|---|---|---|
| §1–§1.2 产品定位、宿主边界 | 独立插件、宿主拥有模型/调度/工具/授权 | proposal 非目标；design Non-Goals；host-adapters 4 个 requirement | §15.0 adapter contract、§15.4 release gate |
| §2.1 信任、证据、最小权限、零 LLM 写权 | 适配器只用受认证 scoped client，不持有 store/db | host-adapters:1；tasks 1.1–1.3 | §15.2 writer bypass、§15.3 poisoning |
| §2.2 差距闭环 | facade → 真实 lifecycle bridge 和 manifest | proposal What Changes；tasks 2–4 | §15.0.1、§15.0.2 |
| §3 参考源码边界 | 不复用旧 CLI/schema；仅吸收 adapter 语义 | proposal Impact；design Decisions | §15.0 |
| §4.1 Core/adapter 边界 | Core 规则共享，adapter 只映射事件 | host-adapters:1–2；tasks 1.2、2.1、3.1 | §15.0、§15.2 |
| §4.2 SPI、版本矩阵、部署 | host/version/commit manifest、真实测试证据、fallback | host-adapters:1；tasks 1.1、2.3、4.2 | §15.0 |
| §4.3 WorkRun/Attempt/checkpoint | adapter 传递 host/agent/dispatch/Attempt，不能绕 fencing | host-adapters:2；tasks 1.3、2.2 | §15.1 lease/fencing |
| §4.4 独立上下文 | context hook 只请求 allowlisted Context Pack | host-adapters:2；tasks 2.1、3.1 | §15.0.1 model projection |
| §4.5 projection/Git | 仅使用首发 projection contract，不管理 authority | design Non-Goals；tasks 4.3 | §15.0.1、§15.4 |
| §4.6 持续演进 | adapter 不复制 revision/merge/impact | design Non-Goals；tasks 1.3 | Phase 3 conformance |
| §4.7 Artifact/认证 | 不传输内容和凭据，仅保留宿主引用 | proposal Impact；host-adapters:3 | §15.0.1 |
| §4.8 防护控制/动作 | 适配 action/result，不执行或授权动作 | host-adapters:2；design Non-Goals | §15.0.2 |
| §5 信任状态机/审核独立 | 适配器不计算 admission/L2 | host-adapters:1；tasks 1.2 | §15.2 |
| §6 数据模型 | 复用版本化 request/response 和 identity attribution | host-adapters:1–2 | §15.0 |
| §7 并发、事务、ID | 交由 Core；adapter 使用 idempotency 和 lease | host-adapters:1–2；tasks 1.3、2.2 | §15.1 |
| §8 权威审计 | adapter 错误/重试/结果由 Core 统一记录 | host-adapters:1–2；tasks 2.2、3.3 | §15.1、§15.2 |
| §9 质量和覆盖 | 提供 host contract fixture，不替代质量评估 | proposal 依赖说明 | §15.0、Phase 4 |
| §10 守卫策略 | capability/engagement/lease 由 Core 强制 | host-adapters:1；tasks 1.2 | §15.2 |
| §11 生命周期/召回 | adapter 只触发 context/reload，不决定召回 | host-adapters:2–3 | §15.0.1 |
| §12 API/CLI/MCP | adapter management 与 shared API 对齐 | host-adapters:4；tasks 4.1 | §15.0 |
| §13 角色权限 | transport principal 不能自报 role，宿主仍负责授权 | host-adapters:1；design Decisions | §15.2 |
| §14 Phase 2 | 只交付锁定 DeepSeek、Hermes general plugin 和管理诊断 | proposal、design Migration | §15.0、§15.4 |
| §15.0–§15.4 验收 | adapter contract、projection、control、并发恢复、信任、投毒均引用 Core gate | tasks 2.2、3.3、4.2 | 对应各验收组；本变更不重新定义阈值 |
| §16 部署参数 | Hermes 不替换 provider；未测版本 fallback | host-adapters:3–4 | §15.0 |
| §17 总结 | 原生 adapter 是独立插件接入层 | proposal/design 全文 | release report |

## 数据类型覆盖

`AdapterManifest`、`TransportPrincipal`、`Capability`、`HostLifecycleEvent`、`SessionIdentity`、`AttemptAttribution`、`CheckpointReference`、`ActionResultReference`、`ErrorMapping` 和 `FallbackCapability` 由 `host-adapters` 规格覆盖；WorkRun、Checkpoint、ActionIntent 的权威状态仍由首发和 Phase 3 变更提供。

## 明确不在本变更

完整 ResourceRevision/Relation/PatchSet/Impact、full coverage/L2 quality、PostgreSQL multi-host、Artifact 内容、凭据、agent loop、worker 调度和目标工具执行分别属于后续变更或宿主职责。
