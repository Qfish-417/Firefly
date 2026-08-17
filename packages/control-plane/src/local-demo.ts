import { pathToFileURL } from "node:url";

import { assertContract, type ArtifactRef, type LearningEvent } from "@firefly/contracts";
import { createDatabase, migrateToLatest, type QuestLabDatabase } from "@firefly/persistence";
import type { Kysely } from "kysely";

import { AdminQueryService } from "./admin-api.ts";
import { ManualEvolutionWorkflow, type ManualEvolutionInput } from "./manual-evolution-workflow.ts";

const localDatabaseUrl = "postgresql://questlab:questlab@127.0.0.1:55432/questlab";

export interface LocalDemoStartResult {
  readonly run_id: string;
  readonly state: "awaiting_approval";
  readonly approval_id: string;
  readonly plan_id: string;
}

export interface LocalDemoCompleteResult {
  readonly run_id: string;
  readonly state: "learned";
  readonly changeset_id: string;
  readonly verification_status: "passed";
  readonly outcome_decision: string;
  readonly task_count: number;
  readonly transition_count: number;
}

export async function startLocalDemo(
  db: Kysely<QuestLabDatabase>,
  runId: string,
): Promise<LocalDemoStartResult> {
  const result = await new ManualEvolutionWorkflow(db).start(createLocalDemoInput(runId));
  return {
    run_id: runId,
    state: "awaiting_approval",
    approval_id: result.approval_id,
    plan_id: result.plan.plan_id,
  };
}

export async function approveLocalDemo(
  db: Kysely<QuestLabDatabase>,
  runId: string,
  approverId: string,
  reason: string,
): Promise<LocalDemoCompleteResult> {
  if (!approverId.trim()) throw new TypeError("approver must be non-empty");
  if (!reason.trim()) throw new TypeError("reason must be non-empty");
  const result = await new ManualEvolutionWorkflow(db).approveAndComplete(
    createLocalDemoInput(runId),
    approverId,
    reason,
  );
  const trace = await new AdminQueryService(db).getEvolutionTrace(runId);
  if (!trace) throw new Error(`Evolution trace ${runId} was not found after completion`);
  return {
    run_id: runId,
    state: "learned",
    changeset_id: result.change_set.changeset_id,
    verification_status: "passed",
    outcome_decision: result.outcome.decision,
    task_count: trace.tasks.length,
    transition_count: trace.transitions.length,
  };
}

export function createLocalDemoInput(runId: string): ManualEvolutionInput {
  validateRunId(runId);
  const sourcePlugin: ArtifactRef = {
    artifact_id: `artifact.plugin-source.${runId}`,
    uri: `https://artifacts.firefly.local/plugins/solar-energy/${runId}/1.2.0.json`,
    digest: `sha256:${"a".repeat(64)}`,
    media_type: "application/vnd.firefly.plugin+json",
    scope: "tenant",
    owner_id: "tenant.questlab",
    lineage_ids: [],
  };
  const evidenceArtifact: ArtifactRef = {
    artifact_id: `artifact.evidence.${runId}`,
    uri: `https://artifacts.firefly.local/evidence/${runId}/attempts.json`,
    digest: `sha256:${"b".repeat(64)}`,
    media_type: "application/json",
    scope: "tenant",
    owner_id: "tenant.questlab",
    lineage_ids: [],
  };
  const baseEvent = {
    learner_id: "learner.synthetic.01",
    world_id: "world.mars.01",
    mission_id: "mission.solar-energy.01",
    plugin_exposure: { plugin_id: "solar-energy", version: "1.2.0", digest: sourcePlugin.digest },
    artifact_refs: [evidenceArtifact],
  } as const;
  const learningEvents: readonly LearningEvent[] = [
    {
      ...baseEvent,
      event_id: `learning-event.challenge.${runId}`,
      event_type: "challenge_attempted",
      occurred_at: "2026-01-01T00:00:00.000Z",
      attributes: { misconception: "constant_solar_output", predicted_night_output_ratio: 1 },
    },
    {
      ...baseEvent,
      event_id: `learning-event.review.${runId}`,
      event_type: "delayed_review_completed",
      occurred_at: "2026-01-01T00:00:01.000Z",
      attributes: { misconception: "constant_solar_output", retained_incorrect_model: true },
    },
  ];
  for (const event of learningEvents) assertContract("LearningEvent", event);
  return {
    run_id: runId,
    correlation_id: `correlation.${runId}`,
    trace_id: `trace.${runId}`,
    goal: "Explain how the Martian day-night cycle changes solar energy production.",
    cohort: "cohort.synthetic.beginner",
    learning_events: learningEvents,
    evidence_artifact: evidenceArtifact,
    source_plugin: sourcePlugin,
  };
}

function validateRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,79}$/u.test(runId)) {
    throw new TypeError("run-id must be 3 to 80 characters using letters, numbers, dot, underscore, colon or hyphen");
  }
}

function option(arguments_: readonly string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  if (index < 0) return undefined;
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) throw new TypeError(`${name} requires a value`);
  return value;
}

async function runCli(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  const command = arguments_[0];
  if (command !== "start" && command !== "approve") {
    throw new TypeError("Usage: local-demo <start|approve> [--run-id ID] [--approver ID] [--reason TEXT]");
  }
  const requestedRunId = option(arguments_, "--run-id");
  if (command === "approve" && !requestedRunId) throw new TypeError("approve requires --run-id");
  const runId = requestedRunId ?? `run.local.${Date.now()}`;
  validateRunId(runId);
  const connectionString = process.env.DATABASE_URL?.trim() || localDatabaseUrl;
  await migrateToLatest(connectionString);
  const db = createDatabase(connectionString);
  try {
    if (command === "start") {
      const result = await startLocalDemo(db, runId);
      process.stdout.write(`${JSON.stringify({
        ...result,
        next: `npm run demo:approve -- --run-id ${runId} --approver local.user --reason \"reviewed locally\"`,
      }, null, 2)}\n`);
      return;
    }
    const approver = option(arguments_, "--approver");
    const reason = option(arguments_, "--reason");
    if (!approver || !reason) throw new TypeError("approve requires --approver and --reason");
    process.stdout.write(`${JSON.stringify(await approveLocalDemo(db, runId, approver, reason), null, 2)}\n`);
  } finally {
    await db.destroy();
  }
}

const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entryPoint === import.meta.url) await runCli();
