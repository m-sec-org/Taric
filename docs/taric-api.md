# API 与 MCP 合同

本文面向 SDK 开发者、安全评审人员和宿主集成工程师。Taric Core 是唯一的业务写入与授权权威；CLI、MCP、adapter 和 gateway 都通过 Core 合同访问同一套治理逻辑。

当前合同版本：workspace `1.1.0`、Core API `1.5.0`、adapter `1.1`、记录 Schema `1.0.0`、authority storage `authority-storage/5`、SQL `authority-sql/5`。API 版本必须精确匹配，旧客户端不会被静默降级。私有 workspace 包的版本不表示已发布到 npm。

## 调用与错误

Core 的主要入口为 `service.dispatch(operation, principal, request)`。可信 transport 创建 principal；请求对象中的 `role`、`principal_id`、`capabilities` 等字段不能注册身份。CLI/MCP/gateway 不应把整个 Core service 暴露给不可信调用方。

成功返回 `{ "ok": true, "data": ... }`，失败返回 `{ "ok": false, "error": { "code", "message", ... } }`。校验错误可含有有界的 `error.details`；调用方优先按 `error.code` 处理，不应依赖提交值、秘密、SQL、token 或绝对路径出现在诊断中。

检查外层 envelope 还不够：Admission 可能返回外层 `ok:true` 而 `data.ok:false`，表示调用成功但提案被业务策略拒绝。MCP `isError` 和 CLI 退出码反映 transport/Core 外层结果，不能替代业务判定。

`@taric/schemas` 导出领域 Schema、每个受支持操作的 request schema 和操作 registry。MCP 用请求 Schema 生成 `inputSchema` 并在派发前校验；Core 派发仍会执行授权、版本、身份、幂等和业务校验。Schema 是输入合同，不授予调用权限，也不能让调用方写入 Core 管理字段。当前完整操作合同以 `packages/schemas/src/registry.ts` 为准，运行状态可用 `capability.status` 查询。

## 身份、角色和能力

角色描述调用者类型，capability 描述具体操作许可；两者都必须满足。所有记录按 Engagement 隔离。模型不能将候选直接标为已验证 Finding，也不能通过请求字段升级信任级别。

| 身份 | 常见职责 | 典型边界 |
| --- | --- | --- |
| `model` | 读取允许的上下文、资源和证据，提交候选、checkpoint 建议和 Action 建议 | 不执行 Admission、host checkpoint commit、raw Artifact 读取或目标动作 |
| `host` | 运行宿主生命周期，采集观察、维护工作租约、回传动作决定/结果和 Artifact | 不代表人工 reviewer；目标动作仍由宿主自身策略授权 |
| `reviewer` | 对固定 review pack 独立提交 review | 必须使用可信 attestation，reviewer 身份不能由模型参数指定 |
| `writer` | 执行被授予的治理写入和 Finding 晋升工作 | 仍受 operation role/capability 限制；默认不授予模型 |
| `operator` | 初始化、管理、诊断、维护和恢复 authority | 凭据必须留在可信运维边界，不可作为模型 token |

主要 grant 包括 `read`、`propose`、`review`、`admit`、`work`、`checkpoint`、`action`、`audit`、`operator`、`writer`、`content`、`content_read`、`history_read`。角色允许列表、grant 和 Engagement 绑定必须同时满足。`content_read` 与 `history_read` 是不同权限：前者允许 host/operator 按需读取原始 Artifact；后者只允许 model 读取显式分类的执行历史文本。

## 操作能力地图

Core registry 定义每个操作允许的角色、所需 grant、是否 Engagement-scoped、是否修改 authority、request/response schema 和错误集合。MCP 工具目录是该 registry 按固定 principal 过滤后的子集，不是另一套权限定义。

| 能力域 | 代表操作 | 解决的问题 |
| --- | --- | --- |
| Engagement 与范围 | `engagement.init`、`scope.revise`、`scope.invalidate`、`scope.query` | 建立测试边界；每个 WorkRun 必须绑定当前有效、已批准的 ScopeRevision |
| 记忆与证据 | `context.query`、`resource.query`、`evidence.query`、`proposal.submit`、`capture.observation` | 读取受控上下文，记录候选、观察、证据和资源版本 |
| 治理 | `review.pack`、`review.submit`、`admission.evaluate`、`admission.promote_l2` | 固定审核材料、独立 Review、按策略改变候选信任状态 |
| 运行恢复 | `work.claim`、`work.renew`、`work.reclaim`、`work.resume`、`checkpoint.propose`、`checkpoint.commit` | 通过租约、Attempt 和 generation 管理并恢复宿主工作 |
| 动作与审计 | `action.recommend`、`action.host-decision`、`action.host-result`、`action.audit.query` | 分离模型建议与宿主授权/执行结果，并留下追加式审计历史 |
| 覆盖与报告 | `coverage.record`、`coverage.snapshot`、`coverage.gate`、`report.snapshot.commit`、`engagement.close` | 固定测试预期、识别缺口、校验报告并关闭/重新打开任务 |
| Artifact 与历史 | `artifact.store.begin`、`artifact.store.append`、`artifact.store.commit`、`artifact.search`、`artifact.history.read`、`history.query` | 保存任务附件；在单独 grant 下搜索和读取已分类执行历史 |
| 运维与恢复 | `audit.verify`、`audit.doctor`、`audit.reconcile`、`snapshot.export`、`capability.status` | 检查审计、定位漂移、预览/修复派生状态、导出只读快照和查看能力 |

操作名和输入字段以 registry 的当前 request schema 为准，不能从表格标题推断未列出的参数。公共 `snapshot.import`、通用 `migration`、`backup.restore`、`remote.push` 和目标执行操作不对外提供。

## MCP 工具目录

MCP 使用 stdio 和协议 `2024-11-05`，当前提供 `initialize`、`tools/list`、`tools/call`，不提供 resources/subscriptions、Tasks 或 HTTP listener。一个服务进程只绑定一个 principal；多种安全身份应启动不同进程。工具参数不能更换身份、grant、Review attestation、Engagement 或宿主 session。

绑定 Engagement 时，默认 model 有 13 个工具；未绑定 model 没有 scoped 工具。默认 grant 下的其他目录为 host 47、reviewer 1、writer 7、operator 54 个工具。实际 `tools/list` 永远是准确信息：权限配置变化时目录可能变化，不要把固定数量硬编码在宿主中。model 单独获得 `history_read` 后，目录多出 3 个只读历史工具；`content_read` 只适用于 host/operator。

每个工具使用 registry 中该操作的完整 `inputSchema`。常规调用的序列化参数上限为 1 MiB；`artifact.store.append` 可传更大的 base64 分块，但解码后仍受 64 MiB chunk 限制。MCP 不会截断返回值，操作本身负责限制分页、内容段和响应大小。任何请求都由 Core 再次授权和校验。

## 上下文、游标与恢复

`context.query` 返回受策略过滤且受预算限制的 Context Pack。继续分页时保留原 principal、Engagement、过滤器、顺序、预算和返回的 cursor/read sequence。cursor 绑定原查询及 authority 水位，不能跨主体、Engagement 或内容根复用。遇到无效 cursor 时，从新水位重新读取。

模型提交候选后，宿主应采集真实观察和 Evidence，再运行 admission/review 流程。提案被接受不自动证明其内容真实；L2 Finding 需要规定的证据、策略和独立 reviewer。攻防宿主可将外部系统中的项目/任务 ID 保存在自己的映射中，并映射到 Taric 的 canonical Resource/ResourceRevision。

claim WorkRun 前，Engagement 必须有当前有效、已批准的 ScopeRevision。每次续租、迁移、checkpoint、Action 和 run-bound Artifact 写入需匹配当前 owner、Attempt、lease 和 generation。过期或被 reclaim 的运行不能通过旧 generation 写入当前状态。Taric 保存恢复信息，但 worker 的创建、调度和取消由宿主负责。

## 动作建议和目标操作

`action.recommend` 保存模型对目标、方法、理由、约束和不确定性的建议。宿主根据自身授权策略决定是否执行，随后通过 host operation 回传批准/拒绝与执行结果；未知结果需要 reconciliation。Taric 不发送目标请求，不自动重试，也不签发目标授权。

宿主策略可以表达 `llm_recommend`、`authorized_autonomous` 或 `host_hitl` 等决策模式，但这些标签本身不会产生权限。安全不变量仍要求身份、ScopeRevision、有效运行和宿主授权全部成立。Taric 对目标系统没有执行接口（模型工具也不含 target-system operation execution）。

## Gateway 与 session 绑定

`taric gateway` 是 CLI 提供的可选远程传输层，支持 Unix socket、TLS TCP JSON-RPC 和 HTTPS `POST /rpc`。访问 token 在受信任配置中固定映射 principal；网络监听必须启用 TLS。TCP 可维持连接和通知，HTTPS 是请求/响应。gateway 重启会关闭连接；token 删除后不会继续生效。

host principal 可由 trusted transport 绑定 `transport_session_id`。Artifact、WorkRun 和 host state 操作应匹配该 session；请求中不能伪造 transport 绑定。run-bound session 还要求 WorkRun、Attempt、generation 和 owner 与当前租约一致。

## Artifact 原文与 execution history

Artifact 是任务会话的文件/文本载体。开始上传、分块 append、commit 后，Taric 校验哈希、长度、session 绑定以及 run fencing，再发布目录记录。存储可为 Taric spool 或 external reference；external reference 只是 locator 元数据，Taric 不替宿主取回外部内容。

普通模型视图仅返回允许的元数据/引用，不返回 Artifact 原文或凭据（`does not return Artifact bodies or credentials`）。host/operator 若明确配置 `content_read`，可以读取授权原文；宿主负责 ACL、加密、保留、扫描和脱敏。原始任务目标凭据可以经 host 授权后作为 opaque bytes 保存，但不被解析或自动注入模型上下文。

执行历史模型读取有单独的窄接口：

1. host 在 begin 请求声明 `history_content_class: "execution_history"`，只用于 Taric 本地存储的文本；`task_credential`、二进制、外部引用和未分类内容不支持。
2. commit 与完整性检查完成后，历史索引才可见。索引是派生数据，可按需由 operator 有界重建。
3. model 获得 `history_read` 后，可用 `history.query` 查询事件、`artifact.search` 搜索文本、`artifact.history.read` 按偏移分段读取，单段最大 16 KiB。
4. 查询绑定 Engagement、session、可选 WorkRun/Attempt、principal 和水位。用返回 cursor 继续同一查询；响应 `incomplete` 表示索引不完整，不能解释为无历史记录。

## 运维操作与能力状态

维护操作按角色限制。`audit.verify` 和 `audit.doctor` 用于观察；`audit.reconcile` 必须由 operator 调用，支持 preview 与显式修复动作。不要在应用启动时自动把预览变为修复。authority restore 是运维流程，不是 public import API。

PostgreSQL 代码可用，但多主机运行时默认禁用。启用需要与当前 Core/schema/policy 匹配的 runtime conformance evidence 及部署健康检查。统计质量能力 `quality.full_statistical_evaluation` 当前为 unsupported/disabled，等独立人工标注样本和基线证据齐备后再评估是否启用。最新能力状态以 `capability.status` 和兼容矩阵为准。
