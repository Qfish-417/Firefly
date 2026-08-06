import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
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
import { PluginReleaseWorkflow } from "@firefly/control-plane";
import { fingerprintTask } from "@firefly/governance";
import {
  DockerSandboxRunner,
  GitWorktreeBuilder,
  IsolatedPluginEngineeringTool,
  digestFiles,
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
  "model Engineer evidence reaches governed release and rolls back by digest",
  { skip: connectionString && sandboxImage ? false : "TEST_DATABASE_URL and TEST_SANDBOX_IMAGE are required" },
  async () => {
    assert.ok(connectionString);
    assert.ok(sandboxImage);
    await migrateToLatest(connectionString);
    const db = createDatabase(connectionString);
    const fixtureRoot = await mkdtemp(join(tmpdir(), "firefly-plugin-fixture-"));
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

      const checks = [
        "physics_invariants",
        "assessment_invariance",
        "accessibility",
        "historical_replay",
      ].map((name) => ({
        name,
        command: ["node", "plugins/solar-energy/test/gate.mjs", name],
      }));
      const releaseId = "plugin-release.solar-energy.1.3.0";
      const canaryPolicy = {
        percentage: 100,
        authorized_subjects: [],
        subject_prefixes: ["synthetic."],
      } as const;
      const builder = new GitWorktreeBuilder(fixtureRoot);
      const sandbox = new DockerSandboxRunner(sandboxImage);
      const engineering = new IsolatedPluginEngineeringTool(builder, sandbox, {
        repository_path: repositoryPath,
        base_ref: "HEAD",
        plugin_id: "solar-energy",
        candidate_version: "1.3.0",
        artifact_paths: artifactPaths,
        generated_test_paths: ["plugins/solar-energy/test/gate.mjs"],
        owner_id: ownerId,
        checks,
      });
      const candidate = await engineering.buildAndVerify({
        run_id: runId,
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
      });
      const workflow = new PluginReleaseWorkflow(db);
      const prepared = await workflow.prepareVerified({
        release_id: releaseId,
        run_id: runId,
        plugin_id: "solar-energy",
        candidate_version_id: "plugin-version.solar-energy.1.3.0",
        candidate_version: "1.3.0",
        rollback_version_id: "plugin-version.solar-energy.1.2.0",
        baseline_version: "1.2.0",
        baseline_source_commit: sourceCommit,
        authorized_task_id: task.message_id,
        canary_policy: canaryPolicy,
        plan,
        change_set: candidate.change_set,
        verification: candidate.verification,
        sandbox: candidate.sandbox,
      });
      assert.equal(prepared.release.state, "awaiting_approval");
      assert.equal(prepared.sandbox.status, "passed");
      assert.equal(prepared.sandbox.network, "none");
      assert.equal(prepared.sandbox.read_only, true);
      assert.match(prepared.change_set.patch_commit, /^[a-f0-9]{40}$/);
      assert.deepEqual(prepared.change_set.changed_paths, [
        "plugins/solar-energy/manifest.json",
        "plugins/solar-energy/src/daylight.mjs",
      ]);
      assert.notEqual(prepared.change_set.plugin_artifact.digest, baselineArtifact.digest);
      assertContract("ChangeSet", prepared.change_set);
      assertContract("VerificationReport", prepared.verification);
      const releases = new PluginReleaseRepository(db);
      assert.equal((await releases.propose({
        release_id: releaseId,
        run_id: runId,
        plugin_id: "solar-energy",
        candidate_version_id: "plugin-version.solar-energy.1.3.0",
        candidate_version: "1.3.0",
        candidate_artifact: prepared.change_set.plugin_artifact,
        source_commit: prepared.change_set.patch_commit,
        rollback_version_id: "plugin-version.solar-energy.1.2.0",
        change_set: prepared.change_set,
        authorized_task_id: task.message_id,
        canary_policy: canaryPolicy as unknown as JsonObject,
      })).release_id, releaseId);
      let release = await workflow.approveRelease(
        releaseId,
        "release-manager",
        "independent gates passed",
      );
      assert.equal(release.state, "canary");
      const authorized = await workflow.resolveCanary(releaseId, "synthetic.learner.001");
      const unauthorized = await workflow.resolveCanary(releaseId, "learner.real.001");
      assert.equal(authorized.selected_digest, prepared.change_set.plugin_artifact.digest);
      assert.equal(unauthorized.selected_digest, baselineArtifact.digest);
      release = await workflow.completeCanary({
        evaluation_id: `canary.${runId}.success`,
        release_id: releaseId,
        cohort: "synthetic",
        sample_size: 50,
        metrics: { mastery_delta: 0.12, harm_signals: 0 },
        decision: "activate",
        evidence_refs: prepared.sandbox.checks.map((check) => check.evidence),
        evaluated_at: new Date(),
      });
      assert.equal(release.state, "active");
      assert.equal((await releases.getActiveVersion("solar-energy"))?.digest, prepared.change_set.plugin_artifact.digest);
      release = await workflow.completeCanary({
        evaluation_id: `canary.${runId}.fault-injection`,
        release_id: releaseId,
        cohort: "synthetic-fault-injection",
        sample_size: 10,
        metrics: { mastery_delta: -0.2, harm_signals: 1 },
        decision: "rollback",
        evidence_refs: [],
        evaluated_at: new Date(Date.now() + 1),
      });
      assert.equal(release.state, "rolled_back");
      assert.equal((await releases.getActiveVersion("solar-energy"))?.digest, baselineArtifact.digest);
      const vertical = new VerticalSliceRepository(db);
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

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await executeFile("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return result.stdout;
}
