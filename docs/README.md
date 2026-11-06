# Taric 文档

本目录的主文档按读者和任务整理，内容以当前源码和 Schema 为准。Taric 不提供旧 KB/Link 格式兼容；文档中不再保留旧版本的操作说明。`docs/benchmarks/` 是机器可读的验证结果，不能单独当作生产容量或 SLA；`docs/pi-docs/` 是 Pi 上游参考资料，属于独立的宿主文档。

| 文档 | 适合读者 | 解决的问题 |
| --- | --- | --- |
| [架构与模块说明](taric-design.md) | 攻防人员、智能体研发人员 | Taric 的边界、模块职责、数据流和典型使用方式 |
| [宿主接入与部署](agent-integration.md) | 智能体研发人员、平台工程师 | Node/Bun、CLI、MCP、proxy、gateway 和宿主 adapter 如何接入 |
| [API 与 MCP 合同](taric-api.md) | SDK/工具开发者、安全评审人员 | 身份授权、操作目录、请求/错误格式、历史检索和原文读取限制 |
| [运维手册](operations.md) | 系统运行维护人员 | SQLite、PostgreSQL、Artifact spool、游标、备份恢复和排障 |
| [Authority 驱动开发](authority-driver-guide.md) | 存储和运行时开发人员 | 自定义 SQL driver 的接口、事务语义和验收方式 |

## 阅读顺序

首次部署先看架构说明，再根据宿主类型阅读接入指南；需要让模型调用 Taric 时，再阅读 MCP 合同和历史检索章节。单机运行直接使用 SQLite；只有需要多个物理或容器宿主共享同一 authority 时才阅读 PostgreSQL 运维章节。

## 当前合同

- workspace/runtime：`1.1.0`
- Core API：`1.5.0`
- adapter：`1.1`
- record schema：`1.0.0`
- authority storage：`authority-storage/5`
- SQL layout：`authority-sql/5`

版本必须精确配对。运行时诊断可通过 CLI 的 `capability.status` 查看，操作注册表和请求 Schema 位于 [`packages/schemas/src/registry.ts`](../packages/schemas/src/registry.ts) 与 [`packages/schemas/schemas/v1/core.schema.json`](../packages/schemas/schemas/v1/core.schema.json)。
