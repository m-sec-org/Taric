# markdown-projection Specification

## Purpose
Defines human-readable engagement projections and Git checkpoints that are safe to share through Taric permissions and are not the authority store.

## Requirements

### Requirement: Generate allowlisted Markdown projections

The system SHALL continue to generate Brief and Index projections from committed authority using explicit field allowlists. These derived projections MUST exclude raw Artifact payloads and task-session execution sidecars, even when Taric stores them, while allowing opaque Artifact references, safe typed metadata, hashes, provenance, integrity status, and catalog/index watermarks. Host/session locators are not projection fields. Projection generation SHALL read Artifact metadata from the catalog and MUST NOT scan raw payload chunks or wait for a full 100 GiB content traversal. L0 and unrequested L1 candidates SHALL remain excluded from ordinary facts; explicit candidate views must mark trust, provenance, and limitations. Complete generations must contain manifest hash, authority sequence, projected watermark, and file hashes; publication must atomically switch current and retain reader-pinned old generations. Raw Artifact payload files and Markdown sidecars are a separate task-session source store and SHALL only be served through explicit authorized content operations, never treated as the canonical projection.

#### Scenario: Generate a projection

- **WHEN** an authority generation is committed and its task session contains original Artifact Markdown
- **THEN** Taric publishes a complete Brief/Index using allowlisted references and metadata without copying raw Artifact or execution-sidecar bodies

#### Scenario: A field is not allowlisted

- **WHEN** a stored Artifact or execution record field has not been approved for projection
- **THEN** that field is omitted from Markdown, Context Pack, and model-facing output while the source content remains available only through authorized content APIs

#### Scenario: Project metadata for an Artifact held in session storage

- **WHEN** the authority catalog contains an Artifact whose original payload is in a task-session spool
- **THEN** Taric MAY project only allowlisted opaque reference and safe metadata; it does not traverse, read, or copy the raw payload or Markdown sidecar

#### Scenario: Read during projection switch

- **WHEN** a client reads during generation publication
- **THEN** it sees one complete old or new derived generation with a matching manifest and never a partially generated raw or projected file

### Requirement: Control projection sharing

The system SHALL enforce Taric Engagement and task-session permissions when serving derived Markdown projections or explicit raw Artifact content. Derived projection files SHALL remain non-canonical views, while task-session Artifact payloads and Markdown metadata sidecars SHALL remain content storage associated with authority metadata. Requests SHALL identify a principal, Engagement, session, and reference or summary filter, never an arbitrary filesystem path or caller-asserted permission boolean.

#### Scenario: Read projection without engagement permission

- **WHEN** a principal lacks access to an Engagement or task-session Artifact
- **THEN** Taric denies the read without returning projection, content, generation, or path metadata

#### Scenario: Read another projection path

- **WHEN** a client supplies a path outside the registered task session or derived generation for the requested reference
- **THEN** Taric denies the request without reading that file

### Requirement: Local Git checkpoint by default
系统 SHALL 默认启用并为每个 authority generation 创建本地 Git checkpoint；operator 可显式关闭并在状态中标明。checkpoint 绑定 projection manifest、authority sequence 和文件 hash，失败标记为 pending/failed 并可重试，不回滚 authority。远端 push 只在每 Engagement 显式配置私有 repository、access control、retention policy 和成功 secrets-scan callback 后允许，不根据布尔自报声明安全。

#### Scenario: Local checkpoint
- **WHEN** a committed authority generation is checkpointed under default settings
- **THEN** the checkpoint remains in the local repository and is not pushed remotely

#### Scenario: Remote push is requested without safeguards
- **WHEN** remote push is requested but any required engagement repository setting is missing
- **THEN** Taric does not push the checkpoint and reports the missing configuration

#### Scenario: Checkpoint or scan fails
- **WHEN** local commit fails or a required secrets scan does not pass
- **THEN** Taric retains the authority generation, records pending or blocked checkpoint status, and does not push remotely

### Requirement: Generation projection and Git checkpoint policy

Projection SHALL generate distinct Brief/Index immutable generations from a fixed authority snapshot, containing a manifest, file hashes, schema/policy digest, entity list, and authority sequence. Publication SHALL atomically switch the current pointer and retain reader-pinned generations. Field allowlists MUST exclude raw Artifacts, SecretRef, tokens, private paths, unreviewed proposals, sensitive drafts, L0, and unrequested L1. Each enabled projection installation SHALL create a local Git checkpoint by default, bound to the manifest and authority sequence. Remote push MUST require explicit Engagement authorization, a private repository, access control, retention policy, and a real secrets-scan callback; callback results SHALL record scanner tool version and result hash. Failures SHALL retain authority, mark the checkpoint pending/blocked, and support retry; configuration booleans MUST NOT substitute for scan results.

#### Scenario: Reader during generation switch
- **WHEN** a reader requests Brief or Index while the projection generation is switching
- **THEN** the reader sees a complete old or new generation with a matching manifest and never a partially generated file

#### Scenario: Local checkpoint by default
- **WHEN** an authority generation is published with default settings
- **THEN** Taric creates a local repository checkpoint bound to the sequence and manifest and performs no remote push without explicit authorization

#### Scenario: Remote safeguards missing
- **WHEN** an Engagement lacks a private repository, access control, retention policy, or real scan callback/result
- **THEN** Taric does not push, records the missing configuration or blocked/pending checkpoint, and preserves retry state

#### Scenario: Git or scan failure
- **WHEN** a local commit or secrets scan fails
- **THEN** the authority generation remains queryable, the checkpoint records pending/blocked status and any available error or scan evidence, and authority is not rolled back
