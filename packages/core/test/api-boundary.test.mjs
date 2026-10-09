import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("API documentation keeps model-facing boundary explicit", async () => {
  const api = await readFile(new URL("../../../docs/taric-api.md", import.meta.url), "utf8");
  assert.match(api, /action\.recommend/);
  assert.match(api, /checkpoint\.commit/);
  assert.match(api, /does not return Artifact bodies or credentials/i);
  assert.match(api, /llm_recommend/);
  assert.match(api, /authorized_autonomous/);
  assert.match(api, /host_hitl/);
  assert.doesNotMatch(api, /target-system operation.*execute/i);
});
