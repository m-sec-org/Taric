# engagement-memory-evolution Specification

## Purpose

Provides traceable resource revisions, typed relations, bounded patch merging, dependency impact propagation, and protective-control applicability state while preserving immutable observations and evolving current understanding.

## Requirements

### Requirement: Versioned resources and typed relations

Taric SHALL maintain a stable UUIDv7 identity for each logical Resource and represent method/path/parameter/content-type/principal/tenant variants, content hash, source observations, validity, and supersession using immutable ResourceRevision records. Typed Relation, TestHypothesis, and AttackPath records SHALL carry version, source observations, applicability time, Engagement reference, and dependency criticality. Historical Observation, Checkpoint, and host decision values MUST remain unchanged.

#### Scenario: Changed resource content
- **WHEN** a new bundle, response, or interface content hash appears for the same logical resource
- **THEN** Taric creates a new revision and preserves the old revision, source references, and as-of queryability

#### Scenario: Cross-engagement relation
- **WHEN** a patch points a relation, hypothesis, or attack path at an object from another Engagement
- **THEN** Core rejects the submission without exposing metadata from the target Engagement

### Requirement: Bounded patch merge and conflict evidence

PatchSet SHALL bind a base generation, per-object base versions, read_set, and write_set. Independent field changes and relation additions SHALL merge deterministically; deletion, scope/status, mutually exclusive relations, and fact-field changes MUST use explicit CAS or conflict resolution. Conflict records SHALL retain both candidate values, source evidence, base/diff, and merge status, with no silent last-write-wins behavior.

#### Scenario: Non-overlapping patches
- **WHEN** two patches from the same base modify different fields or add different relations
- **THEN** both patches merge and the audit record contains their base, diff, and result

#### Scenario: Overlapping patches
- **WHEN** two patches modify the same fact field or mutually exclusive relation
- **THEN** Taric retains both candidates and places the entity in the conflict queue without silently choosing one

### Requirement: Bounded dependency impact

Taric SHALL propagate ImpactEvent along explicit depends_on/derived_from and field/criticality dependencies using bounded batches, continuation, and a pending watermark. Impact MAY mark claims, hypotheses, WorkItems, coverage, checkpoint applicability, Context, findings, AttackPaths, and report references stale or requiring revalidation; historical observations, checkpoints, and host decisions MUST remain unchanged. Taric SHALL return revalidation WorkItem recommendations and SHALL NOT schedule the host.

#### Scenario: Critical premise withdrawn
- **WHEN** critical evidence or a claim dependency for a finding is withdrawn or contradicted
- **THEN** the dependent finding is paused from ordinary high-trust recall and new reports, unexecuted action recommendations are marked stale, and revalidation is queued

#### Scenario: Large impact graph
- **WHEN** the impact graph exceeds one batch capacity
- **THEN** the response exposes a continuation and pending watermark without claiming all downstream views are updated

### Requirement: Protective-control applicability

ControlObservation and AccessDecisionObservation SHALL remain separate and bind control revision or unknown, policy snapshot, resource revision, authentication/session revision, operation, network conditions, evidence, and limitations. An unknown layer MUST NOT attribute a specific control or origin; origin reached=true MUST have evidence; an edge block with origin not reached SHALL close only the blocked-by-control cell and SHALL NOT close origin coverage. Control changes SHALL append an applicability event without rewriting historical observations.

#### Scenario: Unknown layer
- **WHEN** evidence cannot determine whether a response came from the edge, application, identity layer, or origin
- **THEN** Taric records unknown/inconclusive and does not claim a specific WAF/RASP or origin outcome

#### Scenario: Control revision changes
- **WHEN** a control policy or access-decision premise receives a new revision
- **THEN** related negative claims, coverage, checkpoint applicability, and current findings are marked stale/revalidation while immutable observations remain unchanged
