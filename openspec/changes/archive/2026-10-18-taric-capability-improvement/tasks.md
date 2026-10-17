# Tasks

任务进度以各项复选框及所引用证据为准。编号对应 design 的 I-01～I-08 与来源提案 §17 的 T01～T14；各切片连同自身测试/文档交付。测试命令从仓库根执行，先构建所需 dist；仅 §8 做跨切片收口。

## 1. P0：采用闭环与承诺修正（I-01/I-03/I-04/I-08）

- [x] 1.1 更新 `docs/agent-integration.md` 与中文集成方案，按 A 只读/B 候选/C Finding L2/D 运行恢复/E 原文列 operation、role、初始化、依赖闭包、信任结果与宿主职责；验证五闭环均不绕过身份/隔离/治理，并标注当前 conditional fencing 的真实限制。
- [x] 1.2 在同一入口加入两类宿主成本记录模板、适用/不适用条件、事实保证边界和 I-01～I-08 来源索引；验证无未测人周/ROI/等效安全比例，推演与真实认证明确分开。
- [x] 1.3 建立 README、Pi descriptor/注册结果、adapter/capability status、snapshot.import 支持声明的矛盾清单与修正规则；验证每项关联实现位置、证据范围、对应任务，且不重做已完成硬化能力。

## 2. P1a：可信归属与公开导入边界（I-03/I-08）

- [x] 2.1 更新 session binding schema、authority 持久化和受信任 service 入口，显式保存 host-session/run-bound 及运行关联；验证仅 host/operator 可建立绑定，旧缺模式/请求降级/跨 Engagement 绑定明确失败，并更新 API 文档。
- [x] 2.2 在 proposal/capture/checkpoint/action 路径统一核查 transport/session/run 关联；扩展 API-boundary/协作测试，覆盖全部省略、部分省略、错 owner、旧 generation、过期 lease、迟到隔离，验证 canonical/audit/outbox/幂等状态无非预期变化（T02/T04）。
- [x] 2.3 Artifact begin/append/commit 从持久 upload/session 校验当前运行 fence，重启 publication/reconcile 也复验；扩展 Artifact 故障/恢复测试，验证无字段省略降级、失效内容不 available、显式 host-session 正常且不宣称租约保证（T04/T10）。
- [x] 2.4 使公开 dispatch、Core service 方法与 CLI 的 snapshot.import 明确 unsupported_capability，并从 supported 清单移除；保留隔离后端恢复/conformance，更新 registry/API/接入文档及测试，验证拒绝无状态变化、内部 backup_restore 场景仍有效（T14）。
- [x] 2.5 记录旧材料使用正常 proposal/外部 evidence 引用的例子；验证原始时间/材料来源/limitations 可表达，但 transport 身份不能自报、历史材料不冒充当前观察/L2（T14）。

## 3. P1a：实例能力与自定义 adapter（I-04）

- [x] 3.1 开放格式校验的 adapter ID，分列 package/distribution/version/commit，保留认证上限；扩展 host-adapter 测试，验证自报 capability 不授予权限、未知 patch/fork/native 版本 unsupported，通用协议仍按自身合同可用（T05）。
- [x] 3.2 合成 implementation/runtime/authorization/certification-evidence/quality 状态，修正 Pi callback 存在但缺 run/tool binding 仍报告可用的路径；验证缺 binding、旧摘要、skipped/mock 证据不 enabled，质量 pending 不抹去技术结果（T05/T12）。
- [x] 3.3 将 adapter.status、capability.status、README/接入支持矩阵改为同规则生成或一致性检查；在 runtime-startup/readiness/release-support 测试中验证静态实现不代替当前健康、PG 新摘要重取证、失败不创建 SQLite fallback，并更新 runbook（T01/T12）。

## 4. P1a：Node 代理与真实 Bun 治理闭环（I-02）

- [x] 4.1 增加可运行 Node proxy 启动器与真实 Bun client，复用 openRuntimeService/本地 host RPC 的公开入口；扩展 RPC 认证/framing/部分帧/重连测试，验证模型不能获得 host/reviewer/writer/operator 凭据或切换 principal，并文档化 socket/密钥/容器挂载责任（T02/T06）。
- [x] 4.2 示例通过隔离可信 Node client 完成 operator 初始化、Resource/Observation/Evidence/Claim/Finding、host 工具结果捕获、proposal/L1、独立 reviewer attestation、writer promote_l2；验证模型 MCP 六工具权限不变，pending/L1/verified 结果可区分、旧 review/input/evidence 不晋升（T03/T06）。
- [x] 4.3 以临时持久 authority 跑真实 Bun/Node 进程、代理/authority 重启与幂等/CAS/迟到重试；保存版本/命令/产物和调用/等待成本，验证只依赖公开入口且不把缺 Bun/Node 模拟/第三方推演当认证通过（T01/T06）。最终证据见 `docs/benchmarks/proxy-restart-v5.json`：Node 22.21.1/Bun 1.3.13、7 次独立 operator CLI 与 19 次固定 host RPC、两次进程重启、全部调用等待及原始请求/响应、实测 socket 权限、expected_version 竞争拒绝并保留审核事件、过期提案隔离及重启重试无新提交。用户于 2026-10-18 明确工程实现工时不阻塞完成；历史工时保留未计量，自报费用 `300$` 不换算工时。
- [x] 4.4 在示例和 API 文档明确 P1a 原文走外部引用或受信任内容 API、普通 RPC 仍 1 MiB；验证元数据路径超限拒绝、不宣称 64 MiB 上传，同时生成逐入口操作/身份/结果/限制表。

## 5. P1b：有界 Context 与 authority 读取（I-05）

- [x] 5.1 扩展 benchmark-authority，拆分排队/SQL 次数及行数/hydration/排序/投影/序列化/cursor/RSS/event-loop/WAL；保存同机 10k/50k、长历史、高 churn、多 Engagement 的改前基线，验证包含 fixture、环境、样本数和 p50/p95（T07）。基线见 `docs/benchmarks/authority-scale-v2-baseline.json`，最终源测量见 `docs/benchmarks/authority-scale-v3.json`。
- [x] 5.2 扩展共享 authority backend 的 pinned 候选/事件范围读取，SQLite/PG 保持合同等价并使用适当索引；在 authority-scale/runtime-conformance 测试验证不全表 events、过滤按 Engagement/sequence 下推、固定版本与扫描预算可观测。
- [x] 5.3 将 Context 首屏/续页改为固定 read_seq/read_time、必含项与其余排序组的有界 keyset；扩展 context-recovery/persistent-cursor 测试覆盖 trust/freshness/blocked/未测覆盖/omitted ranges、并发更新、预算不足，验证无重漏、无静默丢强制项（T07）。
- [x] 5.4 将 resume delta 改为有界变更 subject 与固定前后版本查询，返回 continuation/预算错误并保留 scope/任务/授权 premise 阻断；验证长历史/高 churn 不声称截断结果完整，也不升级为事件流/投递证明。
- [x] 5.5 升级并限制 cursor 状态，绑定 authority/principal/Engagement/read_seq/read_time/policy/filter/ordering/budget/expiry；扩展持久 cursor 测试验证旧格式、篡改、换绑定、到期、密钥轮换/丢失拒绝，合法续页跨重启正确，cursor 不含完整记录（T08）。
- [x] 5.6 复跑同机基线并更新 context-recovery/authority runbook，验证续页无全量 hydration、读取行数/cursor 随页大小受限；报告 50k 首屏降低 50% 候选目标是否达到，未达如实记录，禁止外推通用 2 秒/SLA（T07）。候选首屏 3.08s 对比基线 5.36s，降低 42.5%，目标未达到；不作通用 SLA 声明。

## 6. P1b：Artifact 与维护实测（I-06）

- [x] 6.1 以现有 Artifact profile 对齐每个声明支持内容入口的 64 MiB decoded/base64+metadata envelope、响应/队列限制；扩展 Core/CLI/transport 边界测试和文档，验证超限无发布、模型无原文权限、普通元数据 RPC 不粗暴放宽（T09）。
- [x] 6.2 依据测量减少 base64/Buffer/staging/hash/JSON 冗余复制并实施有界接收/背压；扩展真实进程 transport 文本/二进制、1/2 上传、64 MiB × 2、超限/慢客户端基准，验证 hash 一致、队列有界、端到端耗时/吞吐/RSS/event-loop/失败/publication 有样本数与原始结果（T09）。证据：`docs/benchmarks/artifact-transport-v2.json`，四个 64 MiB 进程样本和两个 JSON 边界样本，零发布失败且哈希一致；队列为 2 × 64 KiB，超限无发布。
- [x] 6.3 覆盖 before_manifest/before_rename/after_rename/after_publication_marker/before_catalog_commit/after_catalog_commit、中止、重复 commit 和重启恢复；扩展 Artifact durability 测试并更新 runbook，验证未核验/失效绑定内容不 available，local_process_crash 与无 fsync/无断电保证保持明确（T10）。
- [x] 6.4 在 doctor/verify/reconcile/export 与普通写入/heartbeat 并发时测队列、固定水位、event-loop 和 WAL；扩展维护授权/副作用测试和 authority runbook，验证 operator-only、只读与修复分离、无静默历史改写或未经设计 worker（T11）。证据脚本：`scripts/benchmark-maintenance.mjs`，报告：`docs/benchmarks/maintenance-concurrency-v2.json`。

## 7. P2：host 状态轮询与条件订阅（I-07）

- [x] 7.1 增加 host.state registry/schema/service 与接入文档，按授权 Engagement 返回有界 L1/Conflict/Impact/unknown action/lease 聚合和时间/水位；新增真实范围/时间测试，验证模型无权、撤权/跨 Engagement 不泄漏、freshness/lease 到期无需新 commit 也被反映（T13）。
- [x] 7.2 提供退避轮询示例，测量前记录调用/资源/发现延迟预算，再测跨进程提交、失败与重连；验证关闭所有通知仍正确，保存是否超预算和订阅触发/未触发结论（T13）。
- [x] 7.3 仅在 7.2 超预算触发后实现独立 host MCP resources 协商/list/read/subscribe/unsubscribe，稳定 URI 更新提示与合并/限额/重鉴权；同步协议文档/测试，验证注册窗口、跨进程变化、撤权、丢失/乱序/慢消费、重连重读，不抢 outbox、不触发模型/动作（T13）。未触发则以含证据的 disabled 结论完成本任务，不虚构实现或通知测试通过。本次测量未超出 1000 ms 发现预算，故 resources subscription 保持 disabled；证据见 `docs/benchmarks/host-state-poll-v1.json`。

## 8. 跨切片集成与发布证据

- [x] 8.1 用 T01～T14 追踪表核对各切片测试/文档已交付，并运行 `npm run typecheck`、`npm run build`、`npm test`；验证六模型工具、持久单机默认/显式 memory、多主机 fail-closed、唯一 Core 治理和 64 MiB 合同保持。最终独立干净构建 `docs/benchmarks/capability-verification-v2.json` 记录 typecheck/build 及各包测试全部通过：core 291、CLI 22、MCP 12、schemas 9、Hermes 5，共 339，零失败/跳过；T01～T14 证据索引见 `release-report.md`。
- [x] 8.2 独立干净构建重跑所需真实隔离 conformance/current live gate，生成发布证据包与报告；验证源码/构建/schema/policy 摘要、运行时/宿主版本、机器/fixture、命令、样本数、原始/故障结果、技术/质量分列及未验证范围完整，callback 文本不代替真实场景，未完成外部门槛不得声称通过。最终报告：`docs/benchmarks/capability-verification-v2.json` 与 `docs/benchmarks/postgres-runtime-v2.json`；技术与 PostgreSQL live gate 通过，12 个共享 authority 场景通过，独立 pg_dump/pg_restore 的 24 张表一致且审计序列 107→107；人类标注/基线样本数为 0，质量门槛未通过，故 `release_state` 保持 `blocked`。
