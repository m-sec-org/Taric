# Harden Taric Authority Runtime

## Problem

The runtime quality capability has deterministic evaluation code, but release evidence still lacks independently annotated samples and human baseline provenance. Synthetic fixtures cannot establish production quality.

## Scope

Collect versioned, independently annotated samples; bind the sample digest, annotation provenance, policy digest and runtime commit into a release report; keep the capability disabled until the required evidence is complete.

## Capabilities

- quality-release-evidence

## Non-goals

This change does not introduce model execution, reviewer identity management, target execution or a compatibility shim.
