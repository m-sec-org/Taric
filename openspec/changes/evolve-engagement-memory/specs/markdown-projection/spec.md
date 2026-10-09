# Spec Delta

## ADDED Requirements

### Requirement: Generation projection and Git checkpoint policy

Projection SHALL 从固定 authority snapshot 生成 distinct Brief/Index immutable generation，包含 manifest、file hashes、schema/policy digest、entity list 和 authority sequence；发布 SHALL 原子切换 current pointer，并保留 reader pinned generation。字段白名单 MUST 排除 raw Artifact、SecretRef、token、private path、未审 proposal、敏感 draft、L0 和未请求 L1。每个启用 projection 的安装默认创建 local Git checkpoint，绑定 manifest/authority sequence。远端 push MUST 由 Engagement 显式授权，并满足 private repository、access control、retention policy 和真实 secrets-scan callback；callback 结果 SHALL 记录 scanner tool version/result hash。失败 SHALL 保留 authority，标记 pending/blocked 并可 retry，禁止把配置 boolean 当扫描结果。

#### Scenario: Reader during generation switch
- **WHEN** reader 在 projection generation 切换期间请求 Brief 或 Index
- **THEN** reader 看到完整旧代或完整新代及匹配 manifest，不读到半生成文件

#### Scenario: Local checkpoint by default
- **WHEN** authority generation 在默认配置下发布
- **THEN** Taric 在本地仓库创建绑定 sequence/manifest 的 checkpoint，未显式授权时不执行 remote push

#### Scenario: Remote safeguards missing
- **WHEN** Engagement 未配置私有 repo、访问控制、保留策略或真实 scan callback/result
- **THEN** Taric 不 push，记录缺失配置或 blocked/pending checkpoint，并保留可重试状态

#### Scenario: Git or scan failure
- **WHEN** local commit 或 secrets scan 失败
- **THEN** authority generation 保持可查询，checkpoint 标记 pending/blocked 并记录错误、tool version/result hash（若可得），不回滚 authority
