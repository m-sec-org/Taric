# Taric capability improvement 验收记录

完成日期：2026-10-18（Asia/Shanghai）。[任务清单](tasks.md) 30/30 完成；工程工时缺项按用户明确要求不阻塞 4.3。技术实现与运行时验证通过，质量发布证据仍待补齐。

最终[综合报告](../../../../docs/benchmarks/capability-verification-v2.json) 记录 `technical_passed=true`、`runtime_verified=true`、`implementation_complete=true`、`release_state=blocked`。源码摘要为 `sha256:8a47b88b35d936c6a07e608c9b47bd832ba01f442c7fbb1fab14d8602a24e996`；构建、schema、policy、fixture 摘要以及机器、版本、命令和各检查结果均保存在报告中。

验证将当前源码导出到空临时目录，经 `npm ci --ignore-scripts` 安装后重新 build/typecheck，不复用工作区的 dist 或依赖树。各包测试结果如下；真实 Bun 与 PostgreSQL 用例均执行，零跳过。

| 套件 | 通过 | 失败 | 跳过 |
|---|---:|---:|---:|
| schemas | 9 | 0 | 0 |
| Core | 291 | 0 | 0 |
| CLI | 22 | 0 | 0 |
| MCP | 12 | 0 | 0 |
| Hermes | 5 | 0 | 0 |
| 合计 | 339 | 0 | 0 |

[PostgreSQL 实测报告](../../../../docs/benchmarks/postgres-runtime-v2.json) 来自 OrbStack 中的 PostgreSQL 17.11：12 个治理场景全部通过，当前 readiness 为 `enabled`，共享 authority 门槛通过。逻辑备份以 `pg_dump` 导出隔离 schema，再通过 `pg_restore --single-transaction` 恢复到独立临时数据库；24 张表逐表一致，审计序列 107→107，authority 与 audit 校验通过。这不是物理备份/WAL 或 Artifact 原文备份认证。

4.3 的[真实进程证据](../../../../docs/benchmarks/proxy-restart-v5.json) 使用 Node 22.21.1、Bun 1.3.13 和临时持久 SQLite。7 次独立 operator CLI 与 19 次固定 host RPC 共 26 次调用均记录请求、响应和等待时间；两次进程重启对应三个不同 PID，socket 权限均实测为 `0600`。单次合成运行耗时 21.09 秒，不作为尾延迟或容量保证。

该基准验证重启后的 canonical 读取、幂等结果与 WorkRun 恢复、变载荷冲突、旧 generation 拒绝、真实 `expected_version` 竞争，以及过期提案隔离。竞争 admission 的返回为 `ok:true`、`data.ok:false`，新增拒绝审核事件而不改变 canonical；迟到提案保留原 Attempt/session 归属，第二次重启后的同键重试不新增提交。

工程实现工时未单独计量。用户提供费用原文 `300$`，未注明币种、费用范围或计费依据；它是用户自报金额，不能换算工时或推导 ROI。用户于 2026-10-18 明确此工时缺项不影响 4.3 完成；技术验收未因此省略。

T01～T14 的实施证据索引如下，测试路径均相对仓库根目录。

| 验收 | 主要证据 |
|---|---|
| T01 持久启动/profile | `packages/core/test/runtime-startup.test.mjs`、`packages/cli/test/bin.test.mjs`、PostgreSQL v2 报告 |
| T02 transport/身份/副作用 | `packages/core/test/api-boundary.test.mjs`、`packages/core/test/adapter-rpc.test.mjs` |
| T03 capture/L1/review/L2 | `packages/core/test/trusted-node-governance.test.mjs`、`packages/core/test/runtime-conformance.test.mjs` |
| T04 fencing/迟到归属 | `packages/core/test/transport-session-fencing.test.mjs`、`packages/core/test/artifact-durability.test.mjs`、proxy v5 报告 |
| T05 adapter 绑定/权限 | `packages/core/test/adapter.test.mjs`、`packages/core/test/host-adapters.test.mjs`、`packages/core/test/release-support.test.mjs` |
| T06 真实 Bun/Node/重启 | `packages/cli/test/bin.test.mjs`、`scripts/benchmark-proxy-restart.mjs`、proxy v5 报告 |
| T07 有界固定读取 | `packages/core/test/context-bounded-read.test.mjs`、`packages/core/test/context-recovery.test.mjs`、`docs/benchmarks/authority-scale-v3.json` |
| T08 cursor 绑定/重启 | `packages/core/test/persistent-cursor.test.mjs` |
| T09 64 MiB transport | `packages/core/test/artifact-scale.test.mjs`、`packages/core/test/adapter-rpc.test.mjs`、`docs/benchmarks/artifact-transport-v2.json` |
| T10 publication/recovery | `packages/core/test/artifact-durability.test.mjs`、`packages/core/test/artifact-async.test.mjs` |
| T11 维护并发 | `packages/core/test/doctor-replay.test.mjs`、`docs/benchmarks/maintenance-concurrency-v2.json` |
| T12 技术/运行时/质量分列 | `packages/core/test/postgres-runtime-readiness.test.mjs`、`packages/core/test/release-support.test.mjs`、综合 v2 报告 |
| T13 host 状态/条件订阅 | `packages/core/test/host-state.test.mjs`、`docs/benchmarks/host-state-poll-v1.json`；轮询满足预算，订阅未触发且保持 disabled，不声称通知测试通过 |
| T14 导入拒绝/历史材料 | `packages/core/test/snapshot-import-boundary.test.mjs`、`docs/taric-api.md` |

既有规模、Artifact 与轮询基准本轮未重新采样。50k Context 首屏的既有测量降低 42.5%，未达到 50% 候选目标；不声明通用两秒 SLA。默认 Artifact 仍只声明进程崩溃恢复，不声明断电耐久。Bun 代理证据限于所测本地拓扑，不认证第三方宿主、真实工具观察内容或人类审核质量。

质量报告的人工标注/基线样本数为 0，`evidence_state=pending`；合成 fixture 不建立生产质量，因此质量发布状态仍为 `blocked`，不影响本变更的技术完成。

重现命令（仓库根目录；先 `npm run build`）：

```sh
node scripts/benchmark-proxy-restart.mjs --output=docs/benchmarks/proxy-restart-v5.json
TARIC_TEST_DATABASE_URL=postgresql://taric:taric-local-only@127.0.0.1:55432/taric \
  TARIC_TEST_POSTGRES_CONTAINER=taric-authority-postgres-1 \
  node scripts/verify-release.mjs \
  --output docs/benchmarks/capability-verification-v2.json \
  --postgres-output docs/benchmarks/postgres-runtime-v2.json
```
