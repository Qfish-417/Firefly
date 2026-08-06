import type {
  ArtifactRef,
  ChangeSet,
  ImprovementPlan,
  JsonObject,
  VerificationReport,
} from "@firefly/contracts";
import { assertContract } from "@firefly/contracts";
import {
  DockerSandboxRunner,
  GitWorktreeBuilder,
  createVerificationReport,
  resolveCanaryVersion,
  type BuildPluginChangeInput,
  type CanaryPolicy,
  type CanaryResolution,
  type PluginWorktreeBuild,
  type SandboxCheck,
  type SandboxReleaseEvidence,
} from "@firefly/plugin-platform";
import {
  ApprovalRepository,
  ArtifactRepository,
  PluginReleaseRepository,
  VerticalSliceRepository,
  type PluginReleaseRecord,
  type QuestLabDatabase,
} from "@firefly/persistence";
import type { Kysely } from "kysely";

export interface PreparePluginReleaseInput extends BuildPluginChangeInput {
  readonly release_id: string;
  readonly candidate_version_id: string;
  readonly rollback_version_id: string;
  readonly baseline_version: string;
  readonly baseline_source_commit: string;
  readonly authorized_task_id: string;
  readonly canary_policy: CanaryPolicy;
  readonly checks: readonly SandboxCheck[];
}

export interface PreparedPluginRelease {
  readonly release: PluginReleaseRecord;
  readonly approval_id?: string;
  readonly change_set: ChangeSet;
  readonly verification: VerificationReport;
  readonly sandbox: SandboxReleaseEvidence;
}

export interface PrepareVerifiedPluginReleaseInput {
  readonly release_id: string;
  readonly run_id: string;
  readonly plugin_id: string;
  readonly candidate_version_id: string;
  readonly candidate_version: string;
  readonly rollback_version_id: string;
  readonly baseline_version: string;
  readonly baseline_source_commit: string;
  readonly authorized_task_id: string;
  readonly canary_policy: CanaryPolicy;
  readonly plan: ImprovementPlan;
  readonly change_set: ChangeSet;
  readonly verification: VerificationReport;
  readonly sandbox: SandboxReleaseEvidence;
  readonly sandbox_started_at?: Date;
  readonly completed_at?: Date;
}

export interface CanaryEvaluationInput {
  readonly evaluation_id: string;
  readonly release_id: string;
  readonly cohort: string;
  readonly sample_size: number;
  readonly metrics: JsonObject;
  readonly decision: "activate" | "rollback" | "needs_human";
  readonly evidence_refs: readonly ArtifactRef[];
  readonly evaluated_at?: Date;
}

export class PluginReleaseWorkflow {
  private readonly approvals: ApprovalRepository;
  private readonly artifacts: ArtifactRepository;
  private readonly releases: PluginReleaseRepository;
  private readonly vertical: VerticalSliceRepository;
  private readonly builder: GitWorktreeBuilder | undefined;
  private readonly sandbox: DockerSandboxRunner | undefined;
  private readonly now: () => Date;

  constructor(
    db: Kysely<QuestLabDatabase>,
    builder?: GitWorktreeBuilder,
    sandbox?: DockerSandboxRunner,
    now: () => Date = () => new Date(),
  ) {
    this.approvals = new ApprovalRepository(db);
    this.artifacts = new ArtifactRepository(db);
    this.releases = new PluginReleaseRepository(db);
    this.vertical = new VerticalSliceRepository(db);
    this.builder = builder;
    this.sandbox = sandbox;
    this.now = now;
  }

  async prepare(input: PreparePluginReleaseInput): Promise<PreparedPluginRelease> {
    this.assertPreparation(input);
    const builder = this.builder;
    const sandboxRunner = this.sandbox;
    if (!builder || !sandboxRunner) {
      throw new Error("Direct release preparation requires Git and Docker adapters");
    }
    let build: PluginWorktreeBuild | undefined;
    try {
      build = await builder.build(input);
      assertContract("ChangeSet", build.change_set);
      await this.storeBuildArtifacts(input.run_id, build.change_set);
      await this.vertical.recordChangeSet(
        input.run_id,
        `result.${input.authorized_task_id}`,
        build.change_set,
      );
      await this.releases.registerBaseline({
        plugin_id: input.plugin_id,
        version_id: input.rollback_version_id,
        version: input.baseline_version,
        artifact: input.plan.rollback_target,
        source_commit: input.baseline_source_commit,
      });
      await this.releases.propose({
        release_id: input.release_id,
        run_id: input.run_id,
        plugin_id: input.plugin_id,
        candidate_version_id: input.candidate_version_id,
        candidate_version: input.candidate_version,
        candidate_artifact: build.change_set.plugin_artifact,
        source_commit: build.change_set.patch_commit,
        rollback_version_id: input.rollback_version_id,
        change_set: build.change_set,
        authorized_task_id: input.authorized_task_id,
        canary_policy: input.canary_policy as unknown as JsonObject,
      });

      const startedAt = this.now();
      const sandbox = await sandboxRunner.run({
        run_id: input.run_id,
        worktree_path: build.worktree_path,
        owner_id: input.owner_id,
        checks: input.checks,
      });
      const completedAt = this.now();
      const verification = createVerificationReport({
        run_id: input.run_id,
        change_set: build.change_set,
        sandbox,
      });
      return await this.completePreparedRelease({
        release_id: input.release_id,
        run_id: input.run_id,
        change_set: build.change_set,
        verification,
        sandbox,
        started_at: startedAt,
        completed_at: completedAt,
      });
    } finally {
      await build?.cleanup();
    }
  }

  async prepareVerified(
    input: PrepareVerifiedPluginReleaseInput,
  ): Promise<PreparedPluginRelease> {
    this.assertVerifiedPreparation(input);
    await this.storeBuildArtifacts(input.run_id, input.change_set);
    await this.vertical.recordChangeSet(
      input.run_id,
      `result.${input.authorized_task_id}`,
      input.change_set,
    );
    await this.releases.registerBaseline({
      plugin_id: input.plugin_id,
      version_id: input.rollback_version_id,
      version: input.baseline_version,
      artifact: input.plan.rollback_target,
      source_commit: input.baseline_source_commit,
    });
    await this.releases.propose({
      release_id: input.release_id,
      run_id: input.run_id,
      plugin_id: input.plugin_id,
      candidate_version_id: input.candidate_version_id,
      candidate_version: input.candidate_version,
      candidate_artifact: input.change_set.plugin_artifact,
      source_commit: input.change_set.patch_commit,
      rollback_version_id: input.rollback_version_id,
      change_set: input.change_set,
      authorized_task_id: input.authorized_task_id,
      canary_policy: input.canary_policy as unknown as JsonObject,
    });
    const completedAt = input.completed_at ?? this.now();
    return await this.completePreparedRelease({
      release_id: input.release_id,
      run_id: input.run_id,
      change_set: input.change_set,
      verification: input.verification,
      sandbox: input.sandbox,
      started_at: input.sandbox_started_at ?? completedAt,
      completed_at: completedAt,
    });
  }

  async approveRelease(
    releaseId: string,
    approverId: string,
    reason: string,
  ): Promise<PluginReleaseRecord> {
    const release = await this.requireRelease(releaseId, "awaiting_approval");
    const approvalId = `approval.${releaseId}`;
    const now = this.now();
    await this.approvals.approveSubject(
      approvalId,
      "PluginRelease",
      releaseId,
      approverId,
      reason,
      now,
    );
    return (
      await this.releases.transition(releaseId, {
        event_id: `event.plugin-release.approved.${release.run_id}`,
        event: "approve",
        expected_version: release.version,
        occurred_at: now,
        approval_id: approvalId,
      })
    ).release;
  }

  async resolveCanary(releaseId: string, subjectId: string): Promise<CanaryResolution> {
    const release = await this.requireRelease(releaseId, "canary");
    const [baseline, candidate] = await Promise.all([
      this.releases.getVersionById(release.rollback_version_id),
      this.releases.getVersionById(release.candidate_version_id),
    ]);
    if (!baseline || !candidate) {
      throw new Error(`Plugin versions for ${releaseId} are missing`);
    }
    return resolveCanaryVersion({
      release_id: releaseId,
      subject_id: subjectId,
      baseline_digest: baseline.digest as `sha256:${string}`,
      candidate_digest: candidate.digest as `sha256:${string}`,
      policy: release.canary_policy as unknown as CanaryPolicy,
    });
  }

  async completeCanary(input: CanaryEvaluationInput): Promise<PluginReleaseRecord> {
    const release = await this.releases.findById(input.release_id);
    if (!release || !["canary", "active"].includes(release.state)) {
      throw new Error(`Plugin release ${input.release_id} is not accepting Canary evidence`);
    }
    if (input.decision === "needs_human") {
      throw new Error("needs_human Canary evidence requires a separate review decision");
    }
    const now = input.evaluated_at ?? this.now();
    await this.releases.recordCanaryEvaluation({ ...input, evaluated_at: now });
    const event =
      input.decision === "activate"
        ? "canary_succeeded"
        : release.state === "canary"
          ? "canary_degraded"
          : "rollback";
    return (
      await this.releases.transition(input.release_id, {
        event_id: `event.plugin-release.${event}.${input.evaluation_id}`,
        event,
        expected_version: release.version,
        occurred_at: now,
        evidence: { evaluation_id: input.evaluation_id },
      })
    ).release;
  }

  private assertPreparation(input: PreparePluginReleaseInput): void {
    assertContract("ImprovementPlan", input.plan);
    if (
      input.plan.status !== "approved" ||
      input.plan.rollback_target.digest !== input.plan.target_artifact.digest
    ) {
      throw new Error("Plugin release requires an approved plan with an immutable rollback target");
    }
    if (!sameNames(input.plan.verification_contract, input.checks.map((check) => check.name))) {
      throw new Error("Sandbox checks do not exactly match the approved verification contract");
    }
  }

  private assertVerifiedPreparation(input: PrepareVerifiedPluginReleaseInput): void {
    assertContract("ImprovementPlan", input.plan);
    assertContract("ChangeSet", input.change_set);
    assertContract("VerificationReport", input.verification);
    if (
      input.plan.status !== "approved" ||
      input.plan.rollback_target.digest !== input.plan.target_artifact.digest ||
      input.change_set.plan_id !== input.plan.plan_id ||
      input.change_set.source_snapshot.digest !== input.plan.target_artifact.digest ||
      input.verification.changeset_id !== input.change_set.changeset_id ||
      input.verification.baseline_snapshot.digest !== input.plan.target_artifact.digest ||
      input.verification.status !== input.sandbox.status
    ) {
      throw new Error("Verified release evidence is inconsistent with the approved plan");
    }
    if (
      input.sandbox.runner !== "docker" ||
      input.sandbox.network !== "none" ||
      input.sandbox.read_only !== true ||
      !/@sha256:[a-f0-9]{64}$/.test(input.sandbox.image) ||
      Object.values(input.sandbox.limits).some(
        (value) => typeof value !== "number" || !Number.isFinite(value) || value <= 0,
      ) ||
      input.change_set.changed_paths.some((path) => !input.plan.allowed_paths.includes(path))
    ) {
      throw new Error("Verified release violates the approved execution boundary");
    }
    const checks = new Map(input.sandbox.checks.map((check) => [check.name, check]));
    if (
      !sameNames(input.plan.verification_contract, input.sandbox.checks.map((check) => check.name)) ||
      !sameNames(input.plan.verification_contract, input.verification.checks.map((check) => check.name)) ||
      input.verification.checks.some((check) => {
        const sandboxCheck = checks.get(check.name);
        return (
          !sandboxCheck ||
          sandboxCheck.status !== check.status ||
          !check.evidence_refs.some(
            (artifact) =>
              artifact.artifact_id === sandboxCheck.evidence.artifact_id &&
              artifact.digest === sandboxCheck.evidence.digest,
          )
        );
      })
    ) {
      throw new Error("Verified release checks do not match the Sandbox evidence");
    }
  }

  private async completePreparedRelease(input: {
    readonly release_id: string;
    readonly run_id: string;
    readonly change_set: ChangeSet;
    readonly verification: VerificationReport;
    readonly sandbox: SandboxReleaseEvidence;
    readonly started_at: Date;
    readonly completed_at: Date;
  }): Promise<PreparedPluginRelease> {
    assertContract("VerificationReport", input.verification);
    for (const check of input.sandbox.checks) {
      await this.artifacts.store({
        ...check.evidence,
        lineage_ids: [input.change_set.plugin_artifact.artifact_id],
        metadata: { run_id: input.run_id, kind: "sandbox-evidence", check: check.name },
      });
    }
    await this.vertical.recordVerification(
      input.run_id,
      `event.sandbox-completed.${input.run_id}`,
      input.verification,
    );
    await this.releases.recordSandboxRun({
      sandbox_run_id: `sandbox.${input.run_id}`,
      release_id: input.release_id,
      status: input.sandbox.status,
      image: input.sandbox.image,
      limits: input.sandbox.limits as unknown as JsonObject,
      checks: input.sandbox.checks.map((check) => ({
        name: check.name,
        status: check.status,
        evidence_id: check.evidence.artifact_id,
      })),
      started_at: input.started_at,
      completed_at: input.completed_at,
    });

    if (input.sandbox.status !== "passed") {
      const release = (
        await this.releases.transition(input.release_id, {
          event_id: `event.plugin-release.sandbox-failed.${input.run_id}`,
          event: "sandbox_failed",
          expected_version: 0,
          occurred_at: input.completed_at,
        })
      ).release;
      return {
        release,
        change_set: input.change_set,
        verification: input.verification,
        sandbox: input.sandbox,
      };
    }

    await this.releases.transition(input.release_id, {
      event_id: `event.plugin-release.sandbox-passed.${input.run_id}`,
      event: "sandbox_passed",
      expected_version: 0,
      occurred_at: input.completed_at,
    });
    await this.releases.transition(input.release_id, {
      event_id: `event.plugin-release.verification-passed.${input.run_id}`,
      event: "verification_passed",
      expected_version: 1,
      occurred_at: input.completed_at,
      verification_report_id: input.verification.report_id,
    });
    const release = (
      await this.releases.transition(input.release_id, {
        event_id: `event.plugin-release.approval-requested.${input.run_id}`,
        event: "request_approval",
        expected_version: 2,
        occurred_at: input.completed_at,
      })
    ).release;
    const approvalId = `approval.${input.release_id}`;
    await this.approvals.request({
      id: approvalId,
      run_id: input.run_id,
      subject_type: "PluginRelease",
      subject_id: input.release_id,
      requested_by: "plugin-platform",
    });
    return {
      release,
      approval_id: approvalId,
      change_set: input.change_set,
      verification: input.verification,
      sandbox: input.sandbox,
    };
  }

  private async storeBuildArtifacts(runId: string, changeSet: ChangeSet): Promise<void> {
    await this.artifacts.store({
      ...changeSet.plugin_artifact,
      metadata: { run_id: runId, kind: "candidate-plugin" },
    });
    for (const generatedTest of changeSet.generated_tests) {
      await this.artifacts.store({
        ...generatedTest,
        metadata: { run_id: runId, kind: "gate-test" },
      });
    }
  }

  private async requireRelease(
    releaseId: string,
    expectedState: PluginReleaseRecord["state"],
  ): Promise<PluginReleaseRecord> {
    const release = await this.releases.findById(releaseId);
    if (!release || release.state !== expectedState) {
      throw new Error(`Plugin release ${releaseId} is not ${expectedState}`);
    }
    return release;
  }
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}
