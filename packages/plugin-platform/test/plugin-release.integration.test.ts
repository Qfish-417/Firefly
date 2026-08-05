import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  assertContract,
  type ArtifactRef,
  type ImprovementPlan,
  type JsonObject,
  type LearningFinding,
  type TaskEnvelope,
} from "@firefly/contracts";
import { fingerprintTask } from "@firefly/governance";
import {
  DockerSandboxRunner,
  GitWorktreeBuilder,
  createVerificationReport,
  digestFiles,
  resolveCanaryVersion,
} from "@firefly/plugin-platform";
import {
  ApprovalRepository,
  ArtifactRepository,
  EvolutionRunRepository,
  PluginReleaseRepository,
  VerticalSliceRepository,
  WorkflowTaskRepository,
  createDatabase,
  migrateToLatest,
  type QuestLabDatabase,
} from "@firefly/persistence";
import { sql, type Kysely } from "kysely";

const executeFile = promisify(execFile);
const connectionString = process.env.TEST_DATABASE_URL;
const sandboxImage = process.env.TEST_SANDBOX_IMAGE;

test(
  "governed plugin release builds in a worktree, passes isolated gates and rolls back by digest",
  { skip: connectionString && sandboxImage ? false : "TEST_DATABASE_URL and TEST_SANDBOX_IMAGE are required" },
  async () => {
    assert.ok(connectionString);
    assert.ok(sandboxImage);
    await migrateToLatest(connectionString);
    const db = createDatabase(connectionString);
    const fixtureRoot = await mkdtemp(join(tmpdir(), "firefly-plugin-fixture-"));
    let cleanupBuild: (() => Promise<void>) | undefined;
    try {
      await sql`
        TRUNCATE TABLE questlab.outbox_event, questlab.inbox_receipt,
          questlab.plugin, questlab.evolution_run, questlab.artifact
        RESTART IDENTITY CASCADE
      `.execute(db);
      const repositoryPath = await createPluginRepository(fixtureRoot);
      const runId = "run.plugin-release.m3";
      const ownerId = "tenant.questlab";
      const artifactPaths = [
        "plugins/solar-energy/manifest.json",
        "plugins/solar-energy/src/daylight.mjs",
        "plugins/solar-energy/test/gate.mjs",
      ];
      const baselineDigest = await digestFiles(repositoryPath, artifactPaths);
      const baselineArtifact: ArtifactRef = {
        artifact_id: "artifact.plugin.solar-energy.1.2.0",
        uri: `urn:firefly:plugin:solar-energy:1.2.0:${baselineDigest.slice(7)}`,
        digest: baselineDigest,
        media_type: "application/vnd.firefly.plugin+json",
        scope: "tenant",
        owner_id: ownerId,
        lineage_ids: [],
      };
      const sourceCommit = (await git(repositoryPath, ["rev-parse", "HEAD"])).trim();
      await createAuthorizedRun(db, runId, baselineArtifact);
      const plan = await approvePlan(db, runId, baselineArtifact);
      const task = await completeGovernedEngineerTask(db, runId, plan);

      const baselineSandbox = await new DockerSandboxRunner(sandboxImage).run({
        run_id: `${runId}.baseline`,
        worktree_path: repositoryPath,
        owner_id: ownerId,
        checks: [{ name: "physics_invariants", command: ["node", "plugins/solar-energy/test/gate.mjs", "physics_invariants"] }],
      });
      assert.equal(baselineSandbox.status, "failed");

      const builder = new GitWorktreeBuilder(fixtureRoot);
      const build = await builder.build({
        run_id: runId,
        repository_path: repositoryPath,
        base_ref: "HEAD",
        plugin_id: "solar-energy",
        candidate_version: "1.3.0",
        plan,
        patch_files: [
          {
            path: "plugins/solar-energy/manifest.json",
            content: (await readFile(join(process.cwd(), "plugins/solar-energy/manifest.json"), "utf8")).replace('"version": "1.2.0"', '"version": "1.3.0"'),
          },
          {
            path: "plugins/solar-energy/src/daylight.mjs",
            content: await readFile(join(process.cwd(), "plugins/solar-energy/candidates/1.3.0/daylight.mjs"), "utf8"),
          },
        ],
        artifact_paths: artifactPaths,
        generated_test_paths: ["plugins/solar-energy/test/gate.mjs"],
        owner_id: ownerId,
      });
      cleanupBuild = build.cleanup;
      assert.match(build.change_set.patch_commit, /^[a-f0-9]{40}$/);
      assert.deepEqual(build.change_set.changed_paths, [
        "plugins/solar-energy/manifest.json",
        "plugins/solar-energy/src/daylight.mjs",
      ]);
      assert.notEqual(build.change_set.plugin_artifact.digest, baselineArtifact.digest);
      assertContract("ChangeSet", build.change_set);

      const checks = [
        "physics_invariants",
        "assessment_invariance",
        "accessibility",
        "historical_replay",
      ].map((name) => ({
        name,
        command: ["node", "plugins/solar-energy/test/gate.mjs", name],
      }));
      const startedAt = new Date();
      const sandbox = await new DockerSandboxRunner(sandboxImage).run({
        run_id: runId,
        worktree_path: build.worktree_path,
        owner_id: ownerId,
        checks,
      });
      const completedAt = new Date();
      assert.equal(sandbox.status, "passed");
      assert.equal(sandbox.network, "none");
      assert.equal(sandbox.read_only, true);

      const artifacts = new ArtifactRepository(db);
      await artifacts.store({ ...build.change_set.plugin_artifact, metadata: { run_id: runId, kind: "candidate-plugin" } });
      for (const generatedTest of build.change_set.generated_tests) {
        await artifacts.store({ ...generatedTest, metadata: { run_id: runId, kind: "gate-test" } });
      }
      for (const result of sandbox.checks) {
        await artifacts.store({
          ...result.evidence,
          lineage_ids: [build.change_set.plugin_artifact.artifact_id],
          metadata: { run_id: runId, kind: "sandbox-evidence", check: result.name },
        });
      }
      const vertical = new VerticalSliceRepository(db);
      await vertical.recordChangeSet(runId, `result.${task.message_id}`, build.change_set);
      const verification = createVerificationReport({ run_id: runId, change_set: build.change_set, sandbox });
      assertContract("VerificationReport", verification);
      await vertical.recordVerification(runId, "event.sandbox-passed", verification);

      const releases = new PluginReleaseRepository(db);
      await releases.registerBaseline({
        plugin_id: "solar-energy",
        version_id: "plugin-version.solar-energy.1.2.0",
        version: "1.2.0",
        artifact: baselineArtifact,
        source_commit: sourceCommit,
      });
      const releaseId = "plugin-release.solar-energy.1.3.0";
      const canaryPolicy = {
        percentage: 100,
        authorized_subjects: [],
        subject_prefixes: ["synthetic."],
      } satisfies JsonObject;
      const proposal = {
        release_id: releaseId,
        run_id: runId,
        plugin_id: "solar-energy",
        candidate_version_id: "plugin-version.solar-energy.1.3.0",
        candidate_version: "1.3.0",
        candidate_artifact: build.change_set.plugin_artifact,
        source_commit: build.change_set.patch_commit,
        rollback_version_id: "plugin-version.solar-energy.1.2.0",
        change_set: build.change_set,
        authorized_task_id: task.message_id,
        canary_policy: canaryPolicy,
      } as const;
      await releases.propose(proposal);
      assert.equal((await releases.propose(proposal)).release_id, releaseId);
      const sandboxRecord = {
        sandbox_run_id: `sandbox.${runId}`,
        release_id: releaseId,
        status: sandbox.status,
        image: sandbox.image,
        limits: sandbox.limits as unknown as JsonObject,
        checks: sandbox.checks.map((check) => ({ name: check.name, status: check.status, evidence_id: check.evidence.artifact_id })),
        started_at: startedAt,
        completed_at: completedAt,
      } as const;
      await releases.recordSandboxRun(sandboxRecord);
      assert.equal((await releases.recordSandboxRun(sandboxRecord)).sandbox_run_id, sandboxRecord.sandbox_run_id);
      let release = (await releases.transition(releaseId, transition("sandbox", "sandbox_passed", 0))).release;
      release = (await releases.transition(releaseId, {
        ...transition("verification", "verification_passed", 1),
        verification_report_id: verification.report_id,
      })).release;
      release = (await releases.transition(releaseId, transition("approval-request", "request_approval", 2))).release;
      assert.equal(release.state, "awaiting_approval");

      const approvalId = `approval.${releaseId}`;
      const approvals = new ApprovalRepository(db);
      await approvals.request({
        id: approvalId,
        run_id: runId,
        subject_type: "PluginRelease",
        subject_id: releaseId,
        requested_by: "plugin-platform",
      });
      await approvals.approveSubject(
        approvalId,
        "PluginRelease",
        releaseId,
        "release-manager",
        "independent gates passed",
      );
      release = (await releases.transition(releaseId, {
        ...transition("approved", "approve", 3),
        approval_id: approvalId,
      })).release;
      assert.equal(release.state, "canary");

      const authorized = resolveCanaryVersion({
        release_id: releaseId,
        subject_id: "synthetic.learner.001",
        baseline_digest: baselineArtifact.digest,
        candidate_digest: build.change_set.plugin_artifact.digest,
        policy: canaryPolicy,
      });
      const unauthorized = resolveCanaryVersion({
        release_id: releaseId,
        subject_id: "learner.real.001",
        baseline_digest: baselineArtifact.digest,
        candidate_digest: build.change_set.plugin_artifact.digest,
        policy: canaryPolicy,
      });
      assert.equal(authorized.selected_digest, build.change_set.plugin_artifact.digest);
      assert.equal(unauthorized.selected_digest, baselineArtifact.digest);

      await releases.recordCanaryEvaluation({
        evaluation_id: `canary.${runId}.success`,
        release_id: releaseId,
        cohort: "synthetic",
        sample_size: 50,
        metrics: { mastery_delta: 0.12, harm_signals: 0 },
        decision: "activate",
        evidence_refs: sandbox.checks.map((check) => check.evidence),
        evaluated_at: new Date(),
      });
      release = (await releases.transition(releaseId, transition("canary-success", "canary_succeeded", 4))).release;
      assert.equal(release.state, "active");
      assert.equal((await releases.getActiveVersion("solar-energy"))?.digest, build.change_set.plugin_artifact.digest);

      await releases.recordCanaryEvaluation({
        evaluation_id: `canary.${runId}.fault-injection`,
        release_id: releaseId,
        cohort: "synthetic-fault-injection",
        sample_size: 10,
        metrics: { mastery_delta: -0.2, harm_signals: 1 },
        decision: "rollback",
        evidence_refs: [],
        evaluated_at: new Date(Date.now() + 1),
      });
      release = (await releases.transition(releaseId, transition("rollback", "rollback", 5))).release;
      assert.equal(release.state, "rolled_back");
      assert.equal((await releases.getActiveVersion("solar-energy"))?.digest, baselineArtifact.digest);
      const trace = await vertical.getTrace(runId);
      assert.equal((trace?.plugin_release as { state?: string } | undefined)?.state, "rolled_back");
      assert.equal(trace?.plugin_release_transitions.length, 6);
      assert.equal(trace?.sandbox_runs.length, 1);
      assert.equal(trace?.canary_evaluations.length, 2);
      assert.equal(
        (trace?.active_plugin_version as { digest?: string } | undefined)?.digest,
        baselineArtifact.digest,
      );
    } finally {
      await cleanupBuild?.();
      await rm(fixtureRoot, { recursive: true, force: true });
      await db.destroy();
    }
  },
);

async function createPluginRepository(root: string): Promise<string> {
  const repositoryPath = join(root, "repository");
  await mkdir(repositoryPath, { recursive: true });
  await cp(join(process.cwd(), "plugins/solar-energy"), join(repositoryPath, "plugins/solar-energy"), {
    recursive: true,
  });
  await rm(join(repositoryPath, "plugins/solar-energy/candidates"), { recursive: true, force: true });
  await git(repositoryPath, ["init"]);
  await git(repositoryPath, ["add", "."]);
  await git(repositoryPath, [
    "-c",
    "user.name=FireFly Test",
    "-c",
    "user.email=test@firefly.invalid",
    "commit",
    "-m",
    "baseline solar-energy 1.2.0",
  ]);
  return repositoryPath;
}

async function createAuthorizedRun(
  db: Kysely<QuestLabDatabase>,
  runId: string,
  baseline: ArtifactRef,
): Promise<void> {
  await new EvolutionRunRepository(db).create({
    id: runId,
    correlation_id: `correlation.${runId}`,
    goal: { purpose: "M3 plugin release" },
    budget: { max_tasks: 8, max_transitions: 16 },
    risk_level: "high",
  });
  await new ArtifactRepository(db).store({ ...baseline, metadata: { run_id: runId, kind: "baseline-plugin" } });
  const finding: LearningFinding = {
    finding_id: `finding.${runId}`,
    scope: {
      world_id: "world.mars-base",
      plugin_version: "solar-energy@1.2.0",
      cohort: "synthetic",
    },
    problem: "The constant output model teaches that solar panels generate power at night.",
    evidence_refs: [baseline],
    affected_concepts: ["day-night-cycle", "solar-generation"],
    confidence: 1,
    severity: "high",
    recommended_change_type: "plugin",
    success_criteria: { mastery_delta: 0.05, no_harm_constraints: ["assessment-contract-unchanged"] },
  };
  await new VerticalSliceRepository(db).recordFinding(runId, "event.m3-observed", finding);
}

async function approvePlan(
  db: Kysely<QuestLabDatabase>,
  runId: string,
  baseline: ArtifactRef,
): Promise<ImprovementPlan> {
  const proposed: ImprovementPlan = {
    plan_id: `plan.${runId}`,
    finding_id: `finding.${runId}`,
    status: "proposed",
    change_class: "A3",
    target_artifact: baseline,
    allowed_paths: [
      "plugins/solar-energy/manifest.json",
      "plugins/solar-energy/src/daylight.mjs",
    ],
    risk_level: "high",
    verification_contract: [
      "physics_invariants",
      "assessment_invariance",
      "accessibility",
      "historical_replay",
    ],
    rollback_target: baseline,
  };
  const vertical = new VerticalSliceRepository(db);
  await vertical.recordPlan(runId, proposed.finding_id, proposed);
  const approvals = new ApprovalRepository(db);
  const approvalId = `approval.plan.${runId}`;
  await approvals.request({
    id: approvalId,
    run_id: runId,
    subject_type: "ImprovementPlan",
    subject_id: proposed.plan_id,
    requested_by: "control-plane",
  });
  const approved: ImprovementPlan = {
    ...proposed,
    status: "approved",
    approved_by: "teacher.m3",
    approved_at: new Date().toISOString(),
  };
  await approvals.approvePlan(approvalId, approved, "teacher.m3", "approve isolated plugin fix");
  return approved;
}

async function completeGovernedEngineerTask(
  db: Kysely<QuestLabDatabase>,
  runId: string,
  plan: ImprovementPlan,
): Promise<TaskEnvelope> {
  const payload = { plan: plan as unknown as JsonObject };
  const fingerprint = fingerprintTask({
    task_type: "BuildPluginChangeTask",
    subject: "experience-engineer",
    payload,
    artifact_refs: [plan.target_artifact],
  });
  const now = new Date();
  const task: TaskEnvelope = {
    message_id: `task.build-plugin.${runId}`,
    message_type: "BuildPluginChangeTask",
    schema_version: 1,
    correlation_id: runId,
    trace_id: `trace.${runId}`,
    producer: "control-plane",
    subject: "experience-engineer",
    idempotency_key: `build-plugin:${runId}`,
    created_at: now.toISOString(),
    deadline: new Date(now.getTime() + 60_000).toISOString(),
    cancellation_token: `cancel.build-plugin.${runId}`,
    lease: { duration_sec: 30, heartbeat_sec: 5 },
    retry_policy: { max_attempts: 1, initial_backoff_ms: 100, max_backoff_ms: 1000 },
    budget: { max_tokens: 0, max_cost_usd: 0, max_duration_sec: 60 },
    governance: {
      root_run_id: runId,
      hop_count: 0,
      max_hops: 8,
      task_fingerprint: fingerprint,
      policy_snapshot: "governance.default.v1",
      epoch: 0,
      cooldown_key: `plugin-change.${runId}`,
    },
    artifact_refs: [plan.target_artifact],
    payload,
  };
  const { LoopSentinel } = await import("@firefly/governance");
  await new LoopSentinel(db).dispatch(task, {
    id: task.message_id,
    run_id: runId,
    task_type: task.message_type,
    subject: task.subject,
    payload,
    artifact_refs: task.artifact_refs,
    idempotency_key: task.idempotency_key,
    available_at: now,
    deadline: new Date(task.deadline),
    max_attempts: 1,
  });
  const tasks = new WorkflowTaskRepository(db);
  await tasks.claimNext("experience-engineer", "worker.m3", 30_000, now);
  await tasks.complete(task.message_id, "worker.m3", { status: "patch-proposal-accepted" }, new Date(now.getTime() + 1));
  return task;
}

function transition(
  suffix: string,
  event: Parameters<PluginReleaseRepository["transition"]>[1]["event"],
  expectedVersion: number,
) {
  return {
    event_id: `event.plugin-release.${suffix}`,
    event,
    expected_version: expectedVersion,
    occurred_at: new Date(Date.now() + expectedVersion),
  };
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await executeFile("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return result.stdout;
}
