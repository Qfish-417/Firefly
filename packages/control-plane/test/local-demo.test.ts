import assert from "node:assert/strict";
import test from "node:test";

import { assertContract } from "@firefly/contracts";

import { createLocalDemoInput } from "../src/local-demo.ts";

test("local demo input is deterministic and contract-valid", () => {
  const first = createLocalDemoInput("run.local.unit");
  const second = createLocalDemoInput("run.local.unit");

  assert.deepEqual(first, second);
  assert.equal(first.learning_events.length, 2);
  assert.equal(first.source_plugin.scope, "tenant");
  assert.doesNotThrow(() => assertContract("ArtifactRef", first.source_plugin));
  assert.doesNotThrow(() => assertContract("ArtifactRef", first.evidence_artifact));
  for (const event of first.learning_events) {
    assert.doesNotThrow(() => assertContract("LearningEvent", event));
  }
});

test("local demo rejects unsafe or oversized run identities", () => {
  for (const runId of ["x", "run with spaces", "../run", `run.${"x".repeat(80)}`]) {
    assert.throws(() => createLocalDemoInput(runId), /run-id/);
  }
});
