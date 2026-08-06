import assert from "node:assert/strict";
import test from "node:test";

import type { AgentResult, ArtifactRef, ChangeSet, VerificationReport } from "@firefly/contracts";

import { extractVerifiedEngineerEvidence } from "../src/index.ts";

const source: ArtifactRef = {
  artifact_id: "artifact.source.model-workers-unit",
  uri: "urn:firefly:plugin:solar-energy:1.2.0",
  digest: `sha256:${"a".repeat(64)}`,
  media_type: "application/vnd.firefly.plugin+json",
  scope: "tenant",
  owner_id: "tenant.questlab",
  lineage_ids: [],
};

const candidate: ArtifactRef = {
  ...source,
  artifact_id: "artifact.candidate.model-workers-unit",
  uri: "urn:firefly:plugin:solar-energy:1.3.0",
  digest: `sha256:${"b".repeat(64)}`,
  lineage_ids: [source.artifact_id],
};

const evidence: ArtifactRef = {
  ...source,
  artifact_id: "artifact.sandbox.model-workers-unit",
  uri: "urn:firefly:sandbox:model-workers-unit:physics",
  digest: `sha256:${"c".repeat(64)}`,
  media_type: "application/json",
  lineage_ids: [candidate.artifact_id],
};

test("Control Plane extracts typed release evidence from a model Engineer result", () => {
  const extracted = extractVerifiedEngineerEvidence(result());

  assert.equal(extracted.change_set.patch_commit, "d".repeat(40));
  assert.equal(extracted.verification.status, "passed");
  assert.equal(extracted.sandbox.network, "none");
  assert.equal(extracted.sandbox.checks[0]?.evidence.digest, evidence.digest);
});

test("Control Plane rejects Engineer evidence that claims a writable Sandbox", () => {
  const value = result();
  const sandbox = value.output.sandbox_execution as unknown as Record<string, unknown>;
  const tampered: AgentResult = {
    ...value,
    output: { ...value.output, sandbox_execution: { ...sandbox, read_only: false } as never },
  };

  assert.throws(() => extractVerifiedEngineerEvidence(tampered), /invalid execution boundary/);
});

function result(): AgentResult {
  const changeSet: ChangeSet = {
    changeset_id: "changeset.model-workers-unit",
    plan_id: "plan.model-workers-unit",
    source_snapshot: source,
    patch_commit: "d".repeat(40),
    plugin_artifact: candidate,
    generated_tests: [],
    changed_paths: ["plugins/solar-energy/src/daylight.mjs"],
    risk_declaration: ["isolated-worktree"],
  };
  const verification: VerificationReport = {
    report_id: "verification.model-workers-unit",
    changeset_id: changeSet.changeset_id,
    status: "passed",
    baseline_snapshot: source,
    checks: [{ name: "physics_invariants", status: "passed", evidence_refs: [evidence] }],
  };
  return {
    result_id: "result.model-workers-unit",
    task_id: "task.model-workers-unit",
    schema_version: 1,
    status: "completed",
    completed_at: "2026-08-06T10:00:00.000Z",
    snapshots: { input_version: "task-v1" },
    artifact_refs: [candidate, evidence],
    output: {
      change_set: changeSet as unknown as never,
      verification_report: verification as unknown as never,
      sandbox_execution: {
        status: "passed",
        runner: "docker",
        image: `node@sha256:${"e".repeat(64)}`,
        network: "none",
        read_only: true,
        limits: { timeout_ms: 30_000, memory_mb: 128, cpus: 1, pids: 64 },
        checks: [
          {
            name: "physics_invariants",
            status: "passed",
            exit_code: 0,
            evidence: evidence as unknown as never,
          },
        ],
      },
    },
  };
}
