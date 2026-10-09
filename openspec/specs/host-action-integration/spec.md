# host-action-integration Specification

## Purpose
Defines the boundary for Taric's action recommendations and host decision records while preserving host ownership of authorization, HITL, and execution.

## Requirements

### Requirement: Support host-selected action modes
The system SHALL support recording one of three host-selected action modes: `llm_recommend`, `authorized_autonomous`, and `host_hitl`. Taric SHALL NOT choose a mode as a global default or infer authorization from an LLM recommendation.

#### Scenario: LLM recommendation mode
- **WHEN** an engagement uses `llm_recommend`
- **THEN** Taric returns a recommendation as advisory information and records no host authorization unless separately supplied by the host

#### Scenario: Authorized autonomous mode
- **WHEN** a host reports `authorized_autonomous`
- **THEN** Taric records the host-selected mode and decision reference but does not execute the action

#### Scenario: Host HITL mode
- **WHEN** a host reports `host_hitl`
- **THEN** Taric records the host-provided authorization outcome without implementing user identity or approval interaction

### Requirement: Record host action outcomes
The system SHALL associate host decision and execution-result references with an ActionIntent and its WorkRun. The system SHALL represent denied, authorized, executed, failed, and unknown outcomes without changing them into Taric-issued grants.

#### Scenario: Host reports an execution outcome
- **WHEN** the adapter submits a host result for an ActionIntent
- **THEN** Taric stores the result state and opaque host reference with attempt attribution
