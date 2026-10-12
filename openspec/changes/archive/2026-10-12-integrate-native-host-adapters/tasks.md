# Tasks

任务与设计 §1–§17、数据类型和 §15 验收的映射见同目录 `coverage.md`。

## 1. Contract and transport

- [x] 1.1 定义 host/version/commit、Taric contract version、capabilities、fallback、错误映射和测试证据的 manifest，并用 schema fixture 验证未知版本为 `unsupported`。
- [x] 1.2 实现受认证 scoped Core client，验证 principal、engagement、lease、Attempt 和 capability 后才允许写入，并用 writer-bypass 集成测试证明没有 store/db 暴露。
- [x] 1.3 将已验证的 session/context/observer events 映射到共享 contract，验证重复事件返回原 idempotent 结果；未提供的写入生命周期保持 unavailable。

## 2. DeepSeek Harness adapter

- [x] 2.1 针对锁定 Cordis host commit 注册 session lifecycle hooks，并用 pinned host event contract fixture 验证 callback 归属和错误映射；缺失 context/tool/action hooks 显式报告。
- [x] 2.2 对已提供的 session event 执行 idempotency 测试，并复用 Core 的 checkpoint/action fencing tests；DeepSeek 取消/reload hooks 缺失时保持 unavailable。
- [x] 2.3 对未列入 manifest 的 release/preview commit 返回 unsupported 并验证只暴露 MCP/CLI fallback 能力。

## 3. Hermes general plugin

- [x] 3.1 实现 Python general plugin 的 pre-LLM、pre-tool、post-tool、session hooks 与 Core RPC，验证插件 contract fixture 能完成上下文请求和 observer 调用；提案/checkpoint hooks 标记 unavailable。
- [x] 3.2 验证启用插件不改变 external MemoryProvider 选择；Core 不可用时返回错误且不声称已保存状态。
- [x] 3.3 为 RPC unavailable、重复 session 事件和 provider coexistence 补充测试与接入文档，验证错误码稳定；取消/reload 未提供时保持 unavailable。

## 4. Adapter management and release evidence

- [x] 4.1 实现 install/remove/config/health/version 命令，只改 Taric adapter 配置并验证缺失 host hook 不被模拟为可用。
- [x] 4.2 对 Pi、锁定 DeepSeek、Hermes 和 MCP fallback 运行已验证能力的 conformance tests，验证 state、identity、pinned read 和错误等价；未提供 action/result lifecycle 不纳入 native claim。
- [x] 4.3 更新 adapter compatibility manifest、agent integration 文档和诊断样例，并用子进程验证文档中的 adapter version/health 命令。
