import { createHash } from "node:crypto";
import { uuidv7 } from "../dist/index.js";

const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export async function ensureApprovedScope(store, engagementId, target = "example.test") {
  let engagement = await store.get(engagementId);
  let scope = typeof engagement?.scope_ref === "string" ? await store.get(engagement.scope_ref) : undefined;
  if (!scope) {
    scope = await store.commit({
      id: uuidv7(), schema_version: "1.0.0", engagement_id: engagementId, kind: "scope",
      allowed_targets: [target], excluded_targets: [], rules_of_engagement_ref: "fixture:unapproved",
    }, "L2");
    const engagementRecord = {
      id: engagementId, engagement_id: engagementId, kind: "engagement",
      name: typeof engagement?.name === "string" ? engagement.name : "scope fixture",
      status: typeof engagement?.status === "string" ? engagement.status : "active",
      scope_ref: scope.id,
    };
    if (!engagement) {
      engagement = await store.commit(engagementRecord, "L2", undefined, undefined, false, 0);
    } else {
      engagement = await store.commit(engagementRecord, "L2", undefined, undefined, false, Number(engagement.version));
    }
  }
  if (typeof scope.current_revision_ref === "string") return { engagement, scope };

  const bytes = Buffer.from("approved test rules of engagement");
  const contentHash = digest(bytes);
  const artifactId = uuidv7();
  const contentRef = `${artifactId}@v1`;
  await store.saveArtifactCatalogRow({
    content_ref: contentRef, engagement_id: engagementId, session_id: "scope-fixture", artifact_id: artifactId, version: 1,
    payload_kind: "text", media_type: "text/plain", storage_mode: "taric_stored", byte_length: bytes.length,
    chunk_count: 1, content_hash: contentHash, content_status: "available", integrity_status: "verified",
    stored_at: new Date().toISOString(), relative_dir: "", manifest_path: "",
  }, [{ ordinal: 0, offset: 0, bytes: bytes.length, hash: contentHash, path: "scope-fixture/chunk" }]);

  const now = Date.now();
  const approved = await store.reviseScope({
    engagement_id: engagementId,
    scope_id: scope.id,
    expected_version: scope.version,
    policy: {
      allowed_targets: [target], excluded_targets: [], protocols: ["https"], ports: [{ from: 443, to: 443 }], methods: ["GET"],
      dns: { require_pinned_addresses: true, reject_private_addresses: true, max_addresses: 8 },
      redirects: { max_hops: 1, same_scope_only: true },
      valid_from: new Date(now - 60_000).toISOString(), valid_until: new Date(now + 3_600_000).toISOString(),
    },
    roe_artifact_ref: contentRef,
    roe_artifact_version: 1,
    idempotency_key: `scope-fixture:${engagementId}`,
    principal: "scope-fixture-operator",
  });
  return { engagement: await store.get(engagementId), scope: approved.scope, revision: approved.revision };
}
