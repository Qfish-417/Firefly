import assert from "node:assert/strict";
import test from "node:test";

import { fingerprintTask } from "../src/index.ts";

test("task fingerprints are stable across object key order", () => {
  const first = fingerprintTask({
    task_type: "AnalyzeLearningOutcomeTask",
    subject: "learning-scientist",
    payload: { cohort: "beginner", metrics: { retention: 0.5, mastery: 0.6 } },
    artifact_refs: [],
  });
  const reordered = fingerprintTask({
    task_type: "AnalyzeLearningOutcomeTask",
    subject: "learning-scientist",
    payload: { metrics: { mastery: 0.6, retention: 0.5 }, cohort: "beginner" },
    artifact_refs: [],
  });
  const changed = fingerprintTask({
    task_type: "AnalyzeLearningOutcomeTask",
    subject: "learning-director",
    payload: { cohort: "beginner", metrics: { retention: 0.5, mastery: 0.6 } },
    artifact_refs: [],
  });

  assert.equal(first, reordered);
  assert.notEqual(first, changed);
});
