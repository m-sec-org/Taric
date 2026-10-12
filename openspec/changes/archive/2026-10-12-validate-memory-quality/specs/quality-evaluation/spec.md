# Spec Delta

## ADDED Requirements

### Requirement: Layered statistical evidence

质量报告 SHALL 使用预先版本化的 web/host、risk category、evidence level 分层，记录每层样本量、人工 baseline、precision/recall、calibration error 和 95% confidence intervals；不能用 auditor 一致率或小样本成功替代 finding truth/recall 证据。

#### Scenario: Insufficient sample layer
- **WHEN** 某风险/证据层样本量不足以支持预定置信区间
- **THEN** 报告明确标记不充分和限制，required release gate 不得被默认视为通过
