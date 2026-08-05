import { createHash } from "node:crypto";

import type { AgentId, AgentTaskType, AgentWorker } from "@firefly/agent-kernel";
import {
  assertContract,
  type AgentResult,
  type ArtifactRef,
  type ChangeSet,
  type ImprovementPlan,
  type JsonObject,
  type LearningEvent,
  type LearningFinding,
  type LearningOutcome,
  type TaskEnvelope,
  type VerificationReport,
} from "@firefly/contracts";
import { ExperienceEngineerStub } from "@firefly/experience-engineer";
import { LearningDirectorStub } from "@firefly/learning-director";
import { LearningScientistStub } from "@firefly/learning-scientist";
import {
  ApprovalRepository,
  ArtifactRepository,
  EvolutionRunRepository,
  VerticalSliceRepository,
  WorkflowTaskRepository,
  type EvolutionRunRecord,
  type QuestLabDatabase,
} from "@firefly/persistence";
import type { Kysely } from "kysely";

import { AgentRegistry } from "./agent-registry.ts";

export interface ManualEvolutionInput {
  readonly run_id: string;
  readonly correlation_id: string;
  readonly trace_id: string;
  readonly goal: string;
  readonly cohort: string;
  readonly learning_events: readonly LearningEvent[];
  readonly evidence_artifact: ArtifactRef;
  readonly source_plugin: ArtifactRef;
}

export interface AwaitingApprovalResult {
  readonly run: EvolutionRunRecord;
  readonly plan: ImprovementPlan;
  readonly approval_id: string;
}

export interface CompletedEvolutionResult {
  readonly run: EvolutionRunRecord;
  readonly change_set: ChangeSet;
  readonly verification: VerificationReport;
  readonly outcome: LearningOutcome;
}

export class ManualEvolutionWorkflow {
  private readonly runRepository: EvolutionRunRepository;
  private readonly taskRepository: WorkflowTaskRepository;
  private readonly approvalRepository: ApprovalRepository;
  private readonly artifactRepository: ArtifactRepository;
  private readonly verticalRepository: VerticalSliceRepository;
  private readonly agents: AgentRegistry;
  private readonly now: () => Date;

  constructor(
    db: Kysely<QuestLabDatabase>,
    now: () => Date = () => new Date(),
    workers: readonly AgentWorker[] = [
      new LearningDirectorStub(),
      new LearningScientistStub(),
      new ExperienceEngineerStub(),
    ],
  ) {
    this.runRepository = new EvolutionRunRepository(db);
    this.taskRepository = new WorkflowTaskRepository(db);
    this.approvalRepository = new ApprovalRepository(db);
    this.artifactRepository = new ArtifactRepository(db);
    this.verticalRepository = new VerticalSliceRepository(db);
    this.agents = new AgentRegistry(workers);
    this.now = now;
  }

  async start(input: ManualEvolutionInput): Promise<AwaitingApprovalResult> {
    this.assertInput(input);
    const startedAt = this.now();
    await this.runRepository.create({
      id: input.run_id,
      correlation_id: input.correlation_id,
      goal: { description: input.goal, cohort: input.cohort },
      budget: { max_cost_usd: 0, max_duration_sec: 3600, mode: "deterministic-stub" },
      risk_level: "high",
    });
    await this.artifactRepository.store({
      ...input.source_plugin,
      metadata: { run_id: input.run_id, kind: "source-plugin" },
    });
    await this.artifactRepository.store({
      ...input.evidence_artifact,
      metadata: { run_id: input.run_id, kind: "learning-evidence" },
    });

    const firstEvent = input.learning_events[0]!;
    await this.executeTask(
      input,
      "learning-director",
      "GenerateMissionPlanTask",
      {
        world_id: firstEvent.world_id,
        mission_id: firstEvent.mission_id,
        goal: input.goal,
        plugin_exposure: firstEvent.plugin_exposure as unknown as JsonObject,
      },
      [],
      "learning-events-observed",
    );

    await this.verticalRepository.recordLearningEvents(
      input.run_id,
      input.learning_events,
      `result.task.generatemissionplan.${input.run_id}`,
    );
    const scientistResult = await this.executeTask(
      input,
      "learning-scientist",
      "AnalyzeLearningOutcomeTask",
      {
        learning_events: input.learning_events as unknown as readonly JsonObject[],
        cohort: input.cohort,
      },
      [input.evidence_artifact],
      input.learning_events.at(-1)!.event_id,
    );
    const finding = extractContract<LearningFinding>(scientistResult, "finding", "LearningFinding");
    await this.verticalRepository.recordFinding(input.run_id, scientistResult.result_id, finding);

    let run = await this.transition(input, "finding_created", 0, "finding-created");
    const plan: ImprovementPlan = {
      plan_id: `plan.${input.run_id}`,
      finding_id: finding.finding_id,
      status: "proposed",
      change_class: "A3",
      target_artifact: input.source_plugin,
      allowed_paths: [
        "plugins/solar-energy/src/daylight.ts",
        "plugins/solar-energy/test/daylight.test.ts",
      ],
      risk_level: "high",
      verification_contract: [
        "physics_invariants",
        "assessment_invariance",
        "accessibility",
        "historical_replay",
      ],
      rollback_target: input.source_plugin,
    };
    assertContract("ImprovementPlan", plan);
    await this.verticalRepository.recordPlan(input.run_id, finding.finding_id, plan);
    run = await this.transition(input, "plan_created", run.version, "plan-created");
    run = await this.transition(input, "approval_requested", run.version, "approval-requested");

    const approvalId = `approval.${input.run_id}`;
    await this.approvalRepository.request({
      id: approvalId,
      run_id: input.run_id,
      subject_type: "ImprovementPlan",
      subject_id: plan.plan_id,
      requested_by: "control-plane",
    });
    return { run, plan, approval_id: approvalId };
  }

  async approveAndComplete(
    input: ManualEvolutionInput,
    approverId: string,
    reason: string,
  ): Promise<CompletedEvolutionResult> {
    const current = await this.runRepository.findById(input.run_id);
    if (!current || current.state !== "awaiting_approval") {
      throw new Error(`Evolution run ${input.run_id} is not awaiting approval`);
    }
    const proposed = await this.verticalRepository.findPlanByRunId(input.run_id);
    if (!proposed || proposed.status !== "proposed") {
      throw new Error(`Proposed plan for ${input.run_id} was not found`);
    }
    const approvedAt = this.now();
    const approvedPlan: ImprovementPlan = {
      ...proposed,
      status: "approved",
      approved_by: approverId,
      approved_at: approvedAt.toISOString(),
    };
    assertContract("ImprovementPlan", approvedPlan);
    await this.approvalRepository.approvePlan(
      `approval.${input.run_id}`,
      approvedPlan,
      approverId,
      reason,
      approvedAt,
    );

    let run = await this.transition(input, "plan_approved", current.version, "plan-approved");
    const engineerResult = await this.executeTask(
      input,
      "experience-engineer",
      "BuildPluginChangeTask",
      { plan: approvedPlan as unknown as JsonObject },
      [input.source_plugin],
      `event.plan-approved.${input.run_id}`,
    );
    const changeSet = extractContract<ChangeSet>(engineerResult, "change_set", "ChangeSet");
    await this.artifactRepository.store({
      ...changeSet.plugin_artifact,
      metadata: { run_id: input.run_id, kind: "candidate-plugin" },
    });
    for (const testArtifact of changeSet.generated_tests) {
      await this.artifactRepository.store({
        ...testArtifact,
        metadata: { run_id: input.run_id, kind: "generated-test" },
      });
    }
    await this.verticalRepository.recordChangeSet(input.run_id, engineerResult.result_id, changeSet);
    run = await this.transition(input, "change_built", run.version, "change-built");

    const verificationArtifact = createVerificationArtifact(input.run_id, changeSet);
    await this.artifactRepository.store({
      ...verificationArtifact,
      metadata: { run_id: input.run_id, kind: "verification-evidence" },
    });
    const verification: VerificationReport = {
      report_id: `verification.${input.run_id}`,
      changeset_id: changeSet.changeset_id,
      status: "passed",
      baseline_snapshot: input.source_plugin,
      checks: approvedPlan.verification_contract.map((name) => ({
        name,
        status: "passed",
        evidence_refs: [verificationArtifact],
      })),
    };
    assertContract("VerificationReport", verification);
    await this.verticalRepository.recordVerification(
      input.run_id,
      `event.change-built.${input.run_id}`,
      verification,
    );
    run = await this.transition(input, "verification_passed", run.version, "verification-passed");

    await this.executeTask(
      input,
      "learning-director",
      "ActivateCanaryMissionTask",
      {
        plan_id: approvedPlan.plan_id,
        cohort: input.cohort,
        plugin_artifact: changeSet.plugin_artifact as unknown as JsonObject,
      },
      [changeSet.plugin_artifact],
      `event.verification-passed.${input.run_id}`,
    );
    run = await this.transition(input, "canary_started", run.version, "canary-started");

    const outcomeResult = await this.executeTask(
      input,
      "learning-scientist",
      "EvaluateCanaryTask",
      {
        plan_id: approvedPlan.plan_id,
        cohort: input.cohort,
        plugin_artifact: changeSet.plugin_artifact as unknown as JsonObject,
      },
      [verificationArtifact],
      `event.canary-started.${input.run_id}`,
    );
    const outcome = extractContract<LearningOutcome>(outcomeResult, "outcome", "LearningOutcome");
    await this.verticalRepository.recordOutcome(input.run_id, outcomeResult.result_id, outcome);
    run = await this.transition(input, "canary_succeeded", run.version, "canary-succeeded");
    run = await this.transition(input, "outcome_recorded", run.version, "outcome-recorded");
    return { run, change_set: changeSet, verification, outcome };
  }

  private assertInput(input: ManualEvolutionInput): void {
    if (input.learning_events.length === 0) {
      throw new TypeError("At least one LearningEvent is required");
    }
    assertContract("ArtifactRef", input.evidence_artifact);
    assertContract("ArtifactRef", input.source_plugin);
    for (const event of input.learning_events) {
      assertContract("LearningEvent", event);
    }
  }

  private async executeTask(
    input: ManualEvolutionInput,
    agentId: AgentId,
    taskType: AgentTaskType,
    payload: JsonObject,
    artifactRefs: readonly ArtifactRef[],
    causationId: string,
  ): Promise<AgentResult> {
    const createdAt = this.now();
    const taskId = `task.${taskType.replace(/Task$/, "").toLowerCase()}.${input.run_id}`;
    const task: TaskEnvelope = {
      message_id: taskId,
      message_type: taskType,
      schema_version: 1,
      correlation_id: input.run_id,
      causation_id: causationId,
      trace_id: input.trace_id,
      producer: "control-plane",
      subject: agentId,
      idempotency_key: `${taskType}:${input.run_id}`,
      created_at: createdAt.toISOString(),
      deadline: new Date(createdAt.getTime() + 30 * 60_000).toISOString(),
      cancellation_token: `cancel.${taskId}`,
      lease: { duration_sec: 300, heartbeat_sec: 30 },
      retry_policy: { max_attempts: 3, initial_backoff_ms: 1000, max_backoff_ms: 30_000 },
      budget: { max_tokens: 0, max_cost_usd: 0, max_duration_sec: 1800 },
      artifact_refs: artifactRefs,
      payload,
    };
    assertContract("TaskEnvelope", task);
    await this.taskRepository.enqueue({
      id: task.message_id,
      run_id: input.run_id,
      task_type: task.message_type,
      subject: task.subject,
      payload: task.payload,
      artifact_refs: task.artifact_refs as unknown as readonly JsonObject[],
      idempotency_key: task.idempotency_key,
      available_at: createdAt,
      deadline: new Date(task.deadline),
      max_attempts: task.retry_policy.max_attempts,
    });
    const claimed = await this.taskRepository.claimNext(
      agentId,
      `stub-worker.${agentId}`,
      task.lease.duration_sec * 1000,
      createdAt,
    );
    if (!claimed || claimed.id !== taskId) {
      throw new Error(`Task ${taskId} could not be leased by ${agentId}`);
    }
    const worker = this.agents.get(agentId);
    const result = await worker.execute(task, { now: this.now });
    assertContract("AgentResult", result);
    await this.taskRepository.completeWithAgentResult(
      input.run_id,
      agentId,
      `stub-worker.${agentId}`,
      result,
      this.now(),
    );
    return result;
  }

  private async transition(
    input: ManualEvolutionInput,
    event: Parameters<EvolutionRunRepository["transition"]>[1]["event"],
    expectedVersion: number,
    eventName: string,
  ): Promise<EvolutionRunRecord> {
    const result = await this.runRepository.transition(input.run_id, {
      event_id: `event.${eventName}.${input.run_id}`,
      event,
      expected_version: expectedVersion,
      trace_id: input.trace_id,
      producer: "control-plane",
      occurred_at: this.now(),
    });
    return result.run;
  }
}

function extractContract<T>(
  result: AgentResult,
  field: string,
  contract: "LearningFinding" | "ChangeSet" | "LearningOutcome",
): T {
  const value = result.output[field];
  assertContract(contract, value);
  return value as unknown as T;
}

function createVerificationArtifact(runId: string, changeSet: ChangeSet): ArtifactRef {
  const digest = createHash("sha256")
    .update(`${changeSet.changeset_id}:deterministic-verification`)
    .digest("hex");
  return {
    artifact_id: `artifact.verification.${runId}`,
    uri: `https://artifacts.firefly.local/verification/${runId}/report.json`,
    digest: `sha256:${digest}`,
    media_type: "application/json",
    scope: "tenant",
    owner_id: "tenant.questlab",
    lineage_ids: [changeSet.plugin_artifact.artifact_id],
  };
}
