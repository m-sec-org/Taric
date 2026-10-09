# Taric API Boundary v1

Taric exposes versioned JSON contracts through CLI, MCP, and native host adapters. The Core owns memory state transitions and canonical writes. Host applications own target-system tools, Artifact bodies and lifecycle, credentials, HITL interaction, and action authorization.

## Model-facing operations

| Operation | Purpose | Boundary |
|---|---|---|
| `context.query` | Read an engagement-scoped, pinned Context Pack | Allowlisted fields and host-approved Artifact references only |
| `resource.query` | Read resources, revisions, relations, and trust metadata | No unallowlisted fields or other engagements |
| `evidence.query` | Read evidence metadata and host Artifact references | Does not return Artifact bodies or credentials |
| `proposal.submit` | Submit a proposal, observation, claim, or patch | Creates L0/private state only |
| `checkpoint.propose` | Suggest progress for a host checkpoint | Does not commit a checkpoint or change a WorkRun lease |
| `action.recommend` | Ask Taric for an advisory action recommendation | Never authorizes or executes a target action |

Model-facing operations never expose `writer.commit`, admission internals, `checkpoint.commit`, host credential facilities, target tools, or arbitrary file/database paths.

## Host adapter operations

Native adapters map lifecycle events to the same versioned contract. Authenticated adapters may commit checkpoints for the current WorkRun lease and record host action decisions/results. The supported action modes are `llm_recommend`, `authorized_autonomous`, and `host_hitl`; the host chooses the mode and remains responsible for authorization and execution.

## Projection allowlist

Markdown, Context Pack, query, trace, and export projections exclude raw Artifact contents, `SecretRef`, token/session material, private paths, unreviewed proposals, and sensitive drafts. Artifact retention and redaction are host policies.
