import test from "node:test";
import assert from "node:assert/strict";
import { AuthorityStore, createDeepSeekHarnessAdapter, createPiAdapter } from "../dist/index.js";

test("Pi and DeepSeek adapters share the same Core facade contract", () => {
  const store = new AuthorityStore(); const pi = createPiAdapter(store, "test"); const dsh = createDeepSeekHarnessAdapter(store, "dsh-test");
  assert.equal(pi.descriptor.contract_version, dsh.descriptor.contract_version);
  assert.deepEqual(pi.descriptor.capabilities, dsh.descriptor.capabilities);
  store.close();
});
