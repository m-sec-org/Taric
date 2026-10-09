import test from "node:test";
import assert from "node:assert/strict";
import { AuthorityStore, TaricAdapterFacade, uuidv7, validateAdapter } from "../dist/index.js";

test("adapter contract rejects unsupported versions and capabilities", () => {
  assert.equal(validateAdapter({ host_id: "pi", version: "1", contract_version: "9.0", capabilities: [] }).accepted, false);
  assert.equal(validateAdapter({ host_id: "pi", version: "1", contract_version: "1.0", capabilities: ["unknown"] }).accepted, false);
  assert.equal(validateAdapter({ host_id: "pi", version: "1", contract_version: "1.0", capabilities: ["proposal_submission"] }).accepted, true);
});

test("adapter facade keeps engagement attribution", () => {
  const store = new AuthorityStore(); const engagement_id = uuidv7();
  const adapter = new TaricAdapterFacade({ host_id: "pi", version: "1", contract_version: "1.0", capabilities: ["proposal_submission"] }, store);
  const proposal = adapter.submitProposal({ engagement_id, host_id: "pi" }, { engagement_id, subject_type: "claim", base_version: 0, content: { id: uuidv7(), engagement_id, kind: "claim", proposition: "x" } });
  assert.equal(proposal.status, "pending");
  assert.throws(() => adapter.submitProposal({ engagement_id: uuidv7(), host_id: "pi" }, { engagement_id, subject_type: "claim", base_version: 0, content: { id: uuidv7(), engagement_id, kind: "claim" } }), /engagement mismatch/);
  store.close();
});
