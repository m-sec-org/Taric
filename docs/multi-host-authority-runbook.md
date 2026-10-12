# Multi-host authority runbook

This runbook applies only when an operator explicitly enables the `multi_host_authority` profile. The default `single_host_sqlite` profile remains the supported single-machine deployment and does not need PostgreSQL.

## Supported boundary

- Every Taric host in one shared deployment connects to the same PostgreSQL authority service and compatible schema version.
- PostgreSQL transactions, constraints, sequences, lease expiry, and fencing generation are the source of shared ordering.
- SQLite is local single-host authority only. A shared SQLite file, NFS lock, independent SQLite replicas, or shared Git clone is not a shared authority.
- Markdown and Git are derived projections. They do not coordinate writers, leases, event ordering, or recovery.
- PostgreSQL stores Taric authority state only. Artifact bodies and credentials remain in the host application.

## Enablement checklist

1. Confirm the target needs multiple hosts writing the same authority. If it does not, use the default SQLite profile.
2. Provision one PostgreSQL service inside the deployment's trusted network, apply the supported schema migrations, and restrict credentials to the Taric service role.
3. Configure the explicit `multi_host_authority` profile on every host with the same PostgreSQL service. Do not fall back to SQLite if service configuration or health checks fail.
4. Run the SQLite and PostgreSQL storage conformance suite against the release candidate. Required evidence covers atomic commits, CAS, UUID/display ID allocation, audit/outbox order, lease fencing, pinned reads, backup/restore, and failure recovery.
5. Create a verified backup and restore it into a temporary target. Confirm schema version, source and recovered sequence, integrity hash, Engagement identity, provenance, revision history, and unresolved errors.
6. Generate the shared-authority release evidence report. Enablement is valid only when deployment checks, required gates, conformance, and backup/restore evidence all pass.
7. Start hosts and inspect diagnostics for the selected backend, schema and policy digests, host count, server-fenced lease mode, and enabled state. Verify every host resolves to the same authority service.

## Migration from SQLite

1. Schedule a write freeze and stop every process using the old SQLite authority. Do not copy a live SQLite database between hosts.
2. Export the supported Taric-native snapshot at a pinned authority sequence and retain the source database read-only for rollback.
3. Provision a temporary PostgreSQL target and import the snapshot there. Validate record references, Engagement ownership, display ID uniqueness, revisions, audit integrity, and recovered sequence before switching traffic.
4. Run conformance and a read-only verification against the imported target. Reissue server-side leases; do not resume old host leases or attempt generations.
5. Point all hosts at the same PostgreSQL service and verify backend diagnostics before allowing writes.
6. Keep the old SQLite authority frozen until the new deployment passes its operational observation window. Rollback means restoring the matching frozen SQLite snapshot and fencing PostgreSQL writers; never merge independent histories.

## Backup, restore, and recovery

- Take backups using the supported database backup procedure and record UTC timestamp, schema version, source authority sequence, integrity metadata, and Engagement coverage.
- Test restores into an isolated temporary destination. A restore must validate completely before the destination is switched; failed imports must leave the destination unchanged.
- After restore, compare the recovered sequence and audit chain, verify references and revisions, and report unresolved errors. Keep the system blocked for writes when integrity or schema checks fail.
- Treat all leases as expired after restore. Hosts must obtain new server-side lease generations before submitting run-scoped writes.
- Reconcile projections from committed authority state. Never replay external actions automatically; unresolved action results require host/operator reconciliation.

## Failure handling

- If PostgreSQL is unavailable, block multi-host authority writes and report an unavailable/blocked diagnostic. Do not open a local SQLite fallback.
- If hosts disagree on schema, policy digest, backend, or authority endpoint, keep the deployment disabled until corrected.
- If fencing, event ordering, reader pinning, or conformance fails, mark the release failed and retain the evidence with the incident.
- Shared SQLite, NFS locks, independent SQLite copies, and Git-based locks are unsupported recovery paths. Move to a single PostgreSQL authority or return to a single-host deployment.

