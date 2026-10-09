# Tasks

任务与设计 §1–§17、数据类型和 §15 验收的映射见同目录 `coverage.md`。

## 1. Contract and transport

- [ ] 1.1 定义 host/version/commit、Taric contract version、capabilities、fallback、错误映射和测试证据的 manifest，并用 schema fixture 验证未知版本为 `unsupported`。
- [ ] 1.2 实现受认证 scoped Core client，验证 principal、engagement、lease、Attempt 和 capability 后才允许写入，并用 writer-bypass 集成测试证明没有 store/db 暴露。
- [ ] 1.3 将 session/context/proposal/checkpoint/action/result/cancel/reload 映射到共享 contract，验证重复回调返回原 idempotent 结果。

## 2. DeepSeek Harness adapter

- [ ] 2.1 针对锁定 Cordis host commit 注册真实 session/context/tool/action lifecycle hooks，并在真实运行时 contract test 中验证 callback 归属和错误映射。
- [ ] 2.2 对 checkpoint、host result、取消和重载执行 fencing/idempotency 测试，验证旧 Attempt 不会写入当前状态。
- [ ] 2.3 对未列入 manifest 的 release/preview commit 返回 unsupported 并验证只暴露 MCP/CLI fallback 能力。

## 3. Hermes general plugin

- [ ] 3.1 实现 Python general plugin 的 pre-LLM、pre-tool、post-tool、session-end hooks 与 Core RPC，验证真实 Hermes contract fixture 能完成提案和上下文调用。
- [ ] 3.2 验证启用插件不改变 external MemoryProvider 选择；Core 不可用时返回错误且不声称已保存状态。
- [ ] 3.3 为取消、重载、RPC 超时和重复 session 事件补充测试与接入文档，验证错误码和重试行为稳定。

## 4. Adapter management and release evidence

- [ ] 4.1 实现 install/remove/config/health/version 命令，只改 Taric adapter 配置并验证缺失 host hook 不被模拟为可用。
- [ ] 4.2 对 Pi、锁定 DeepSeek、Hermes 和 MCP fallback 运行同一重叠能力 conformance suite，验证 state、identity、pinned read、action/result 和错误等价。
- [ ] 4.3 更新 adapter compatibility manifest、agent integration 文档和诊断样例，并用 clean checkout 子进程验证每个示例命令。
