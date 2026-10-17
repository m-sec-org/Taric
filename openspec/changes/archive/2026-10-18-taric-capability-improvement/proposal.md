# Proposal

## Why

依据 [能力改进方案](../../../../docs/taric-capability-improvement-proposal.md) 的 I-01～I-08、T01～T14 固化本变更，基线为 `c3db857e937c04293eb08e258ca98c8e24a2b897`。Taric 已有治理核心与硬化成果，但最小宿主接入、运行归属、能力声明及大读/Artifact 成本仍有可核实缺口；宿主推演与历史基准不能直接升级为当前支持承诺。

## What Changes

- P0/I-01：在既有文档建立只读、候选、Finding 验证、运行恢复、原文内容五个采用闭环，列完整依赖/角色/宿主职责与实际成本记录方式。
- P1a/I-02：交付真实 Bun 进程经 Node proxy 调用唯一 Core 的参考路径，完成 capture/proposal → L1 → 独立 review → L2 → 重启读取；模型和 host/writer/reviewer/operator 身份分离。
- P1a/I-03：持久化 host-session/run-bound 可信模式，运行绑定不能通过全部/部分省略字段降级，Artifact 与恢复发布执行同一归属约束。
- P1a/I-04：开放自定义 adapter 标识，按认证版本、真实 binding、principal、backend readiness 与匹配证据合成能力；实现、启用、证据、质量结论分列，先纠正 Pi 与 README/status 矛盾。
- P1b/I-05：Context/续页/resume 改用固定快照、有界读取与稳定位置，保留强制可见项和信任过滤；测 10k/50k、历史/churn、cursor 与资源成本。
- P1b/I-06：对齐声明支持内容的入口限制并减少实测冗余复制，保持 64 MiB decoded chunk、opaque 内容和 process-crash 合同；补真实 transport、故障与 operator 维护测量。
- P2/I-07：交付有界 host 状态与退避轮询，只有实测成本或发现延迟超出事先记录预算时才实现独立 host 订阅；通知不构成正确性依赖。
- **BREAKING** / I-08：公开 snapshot.import 明确 unsupported，撤销公开迁移合同；内部恢复/conformance 保留。升级 session/adapter/cursor 格式时旧格式显式失败，不猜测兼容。

## Capabilities

### New Capabilities

无；沿用项目既有能力路径。

### Modified Capabilities

- `host-adapters`: Node 代理闭环、自定义 ID、按实例与证据合成能力。
- `taric-runtime-api`: 有界 host 状态、条件订阅边界、公开 import/replay 明确拒绝。
- `advanced-context-recovery`: 固定读取/时间、有界续页/resume、持久 cursor，移除公开 snapshot migration。
- `authority-storage`: 有界读取诊断、维护并发成本与预算失败语义。
- `artifact-content-storage`: transport/队列上限与真实资源测量，完整性/发布状态约束。
- `collaboration-state`: 显式双模式及不可降级的运行 fencing。
- `shared-authority-backend`: 内部 backup/restore 与公开 import 的支持边界。

## Impact

影响 Core adapter/service/context/authority/Artifact/capability、schemas/registry、CLI 和条件 host MCP，以及对应测试/benchmark。更新现有接入、API、Context、authority 和支持文档，无新增运行时依赖计划。Bun driver、远程 transport、MCP Tasks、fsync/worker 独立立项；不拆包、不新增 batch/import/replay、不调度或签发动作授权。

依赖已完成但未归档的 `harden-taric-authority-runtime` 合同；后续规格同步先硬化、后本变更，保留其持久 cursor、publication recovery 与激活保证。本次只生成规划产物，不把历史 benchmark/宿主推演当当前认证或启用结果。
