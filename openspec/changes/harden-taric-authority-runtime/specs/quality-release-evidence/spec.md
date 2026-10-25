# Spec Delta

## Purpose

Provides auditable quality evidence that can activate the runtime capability only when independently annotated data, human baselines, and the current release identity are complete and mutually consistent.

## ADDED Requirements

### Requirement: Versioned quality samples cover required strata
The release evidence MUST identify a versioned sample set with independent annotations for every required quality stratum and a stable content digest.

#### Scenario: Complete sample set
- **WHEN** a release report is generated from a sample set covering every required stratum with independent annotations
- **THEN** the report records the sample version, content digest, strata counts, and annotation provenance

#### Scenario: Missing or unannotated stratum
- **WHEN** any required stratum is absent or lacks independent annotations
- **THEN** report generation fails and the quality capability remains disabled

### Requirement: Human baseline provenance is recorded
The release evidence MUST record the human baseline source, annotation agreement, and confidence interval method used for quality evaluation.

#### Scenario: Baseline is complete
- **WHEN** the baseline source and agreement measurements are present and valid
- **THEN** the report records their provenance and confidence interval method

#### Scenario: Baseline is incomplete
- **WHEN** baseline provenance or agreement is missing or invalid
- **THEN** the report is incomplete and the quality capability remains disabled

### Requirement: Release evidence is digest-bound
The quality release report MUST bind the sample digest, policy digest, runtime source commit, and report schema identity to the evaluated result.

#### Scenario: Current report matches runtime
- **WHEN** all bound digests and the source commit match the runtime being activated
- **THEN** the evidence is eligible for activation

#### Scenario: Stale or mismatched report
- **WHEN** any bound digest, source commit, or report schema identity does not match
- **THEN** activation is rejected and the quality capability remains disabled

The runtime MUST require an independently provisioned digest pin over the exact release-report bytes and MUST recompute the current implementation, schema and policy identities before enabling the quality capability. The release report MUST bind its quality result to the current Core implementation digest.

#### Scenario: Pinned report matches current runtime
- **WHEN** the exact report bytes match the independent deployment pin, the report's technical and runtime gates pass, and implementation/schema/policy digests match the running Core
- **THEN** `capability.status` may report only the quality capability as supported, enabled and verified

#### Scenario: Missing or modified report pin
- **WHEN** the report or independent pin is absent, malformed or mismatched
- **THEN** the quality capability remains disabled and a deterministic failure is exposed

### Requirement: Failed evidence fails closed
The runtime MUST reject failed, stale, or incomplete quality reports without partially enabling the quality capability.

#### Scenario: Failed report
- **WHEN** report evaluation contains a failed quality gate
- **THEN** the runtime reports the capability as disabled

#### Scenario: Invalid report
- **WHEN** a report is malformed, incomplete, or cannot be verified
- **THEN** the runtime reports the capability as disabled and exposes a deterministic failure reason
