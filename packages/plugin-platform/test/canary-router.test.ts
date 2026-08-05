import assert from "node:assert/strict";
import test from "node:test";

import {
  DockerSandboxRunner,
  InvalidCanaryPolicyError,
  UnpinnedSandboxImageError,
  resolveCanaryVersion,
} from "@firefly/plugin-platform";

const baseline = `sha256:${"a".repeat(64)}` as const;
const candidate = `sha256:${"b".repeat(64)}` as const;

test("canary routing never exposes a candidate to an unauthorized subject", () => {
  const unauthorized = resolveCanaryVersion({
    release_id: "release.solar.1.3.0",
    subject_id: "learner.real.001",
    baseline_digest: baseline,
    candidate_digest: candidate,
    policy: { percentage: 100, authorized_subjects: [], subject_prefixes: ["synthetic."] },
  });
  assert.equal(unauthorized.cohort, "baseline");
  assert.equal(unauthorized.selected_digest, baseline);

  const authorized = resolveCanaryVersion({
    release_id: "release.solar.1.3.0",
    subject_id: "synthetic.001",
    baseline_digest: baseline,
    candidate_digest: candidate,
    policy: { percentage: 100, authorized_subjects: [], subject_prefixes: ["synthetic."] },
  });
  assert.equal(authorized.cohort, "canary");
  assert.equal(authorized.selected_digest, candidate);
});

test("canary routing requires an explicit authorization boundary", () => {
  assert.throws(
    () =>
      resolveCanaryVersion({
        release_id: "release.solar.1.3.0",
        subject_id: "anyone",
        baseline_digest: baseline,
        candidate_digest: candidate,
        policy: { percentage: 10, authorized_subjects: [], subject_prefixes: [] },
      }),
    InvalidCanaryPolicyError,
  );
});

test("the Docker sandbox requires an immutable image digest", () => {
  assert.throws(() => new DockerSandboxRunner("node:24-alpine"), UnpinnedSandboxImageError);
});
