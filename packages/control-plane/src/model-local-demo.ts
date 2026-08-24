import { pathToFileURL } from "node:url";

import { createDatabase, migrateToLatest, type QuestLabDatabase } from "@firefly/persistence";
import { loadModelGatewayConfiguration, type TextGenerationPort } from "@firefly/model-gateway";
import type { TaskBudget } from "@firefly/contracts";
import type { AgentWorker } from "@firefly/agent-kernel";
import { LearningDirectorAgent } from "@firefly/learning-director";
import { LearningScientistAgent } from "@firefly/learning-scientist";
import { ExperienceEngineerStub } from "@firefly/experience-engineer";
import type { Kysely } from "kysely";

import { AdminQueryService } from "./admin-api.ts";
import { createAuditedPiAiModelGateway } from "./model-workers.ts";
import { createLocalDemoInput } from "./local-demo.ts";
import {
  ManualEvolutionWorkflow,
  modelBackedTasksPerRun,
  type ManualEvolutionExecutionOptions,
  type ManualEvolutionInput,
} from "./manual-evolution-workflow.ts";

export interface ModelDemoStartResult {
  readonly run_id: string;
  readonly state: "awaiting_approval";
  readonly approval_id: string;
  readonly plan_id: string;
  readonly model_calls: number;
  readonly total_tokens: number;
  readonly total_cost_microusd: number;
}

export interface ModelDemoCompleteResult {
  readonly run_id: string;
  readonly state: "learned";
  readonly changeset_id: string;
  readonly verification_status: "passed";
  readonly outcome_decision: string;
  readonly task_count: number;
  readonly transition_count: number;
  readonly model_calls: number;
  readonly failed_calls: number;
  readonly retry_calls: number;
  readonly total_tokens: number;
  readonly total_cost_microusd: number;
  readonly alerts: readonly string[];
}

/**
 * Builds the model-assisted worker set for the local SotaModel profile.
 *
 * Director and Scientist call the governed Model Gateway. Engineer intentionally stays
 * deterministic here: `ExperienceEngineerAgent` requires an injected `PluginEngineeringTool`
 * with a real Git worktree and a digest-pinned Docker Sandbox, which this profile does not start.
 * Substituting a model patch without those gates would produce unverified release evidence.
 */
export function createLocalModelWorkers(gateway: TextGenerationPort): readonly AgentWorker[] {
  return [
    new LearningDirectorAgent(gateway),
    new LearningScientistAgent(gateway),
    new ExperienceEngineerStub(),
  ];
}

/**
 * `QUESTLAB_MODEL_MAX_COST_USD` is the cap for the whole run, so the per-task budget is the run cap
 * divided across the model-backed tasks. Treating it as a per-task budget let one run legally spend
 * several times the advertised limit.
 */
export function modelExecutionOptions(
  environment: NodeJS.ProcessEnv = process.env,
): ManualEvolutionExecutionOptions {
  const runCostLimitUsd = modelRunCostLimitUsd(environment);
  return {
    task_budget: modelTaskBudget(environment, runCostLimitUsd),
    run_cost_limit_usd: runCostLimitUsd,
    worker_id_prefix: "sotamodel-worker",
    mode: "model-assisted",
  };
}

export function modelRunCostLimitUsd(environment: NodeJS.ProcessEnv = process.env): number {
  return positiveNumber(environment.QUESTLAB_MODEL_MAX_COST_USD, "QUESTLAB_MODEL_MAX_COST_USD", 2);
}

/**
 * The model profile reuses the deterministic fixture. `createLocalDemoInput` already derives
 * run-scoped artifact digests, which `questlab.artifact`'s `(digest, scope, owner_id)` unique
 * constraint requires for repeated local runs.
 */
export function createModelDemoInput(runId: string): ManualEvolutionInput {
  return createLocalDemoInput(runId);
}

function modelTaskBudget(environment: NodeJS.ProcessEnv, runCostLimitUsd: number): TaskBudget {
  return {
    max_tokens: positiveInteger(environment.QUESTLAB_MODEL_MAX_TOKENS, "QUESTLAB_MODEL_MAX_TOKENS", 120_000),
    max_cost_usd: runCostLimitUsd / modelBackedTasksPerRun,
    max_duration_sec: positiveInteger(
      environment.QUESTLAB_MODEL_MAX_DURATION_SEC,
      "QUESTLAB_MODEL_MAX_DURATION_SEC",
      1_800,
    ),
  };
}

function positiveInteger(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  if (!/^\d+$/u.test(raw.trim())) throw new TypeError(`${name} must be a positive integer`);
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function positiveNumber(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be a positive number`);
  return value;
}

export async function startModelDemo(
  db: Kysely<QuestLabDatabase>,
  runId: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ModelDemoStartResult> {
  const gateway = createAuditedPiAiModelGateway(loadModelGatewayConfiguration(environment), db, {
    run_cost_limit_usd: modelRunCostLimitUsd(environment),
  });
  const workflow = new ManualEvolutionWorkflow(
    db,
    () => new Date(),
    createLocalModelWorkers(gateway),
    undefined,
    modelExecutionOptions(environment),
  );
  const result = await workflow.start(createModelDemoInput(runId));
  const usage = await runUsage(db, runId);
  return {
    run_id: runId,
    state: "awaiting_approval",
    approval_id: result.approval_id,
    plan_id: result.plan.plan_id,
    ...usage,
  };
}

export async function approveModelDemo(
  db: Kysely<QuestLabDatabase>,
  runId: string,
  approverId: string,
  reason: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ModelDemoCompleteResult> {
  if (!approverId.trim()) throw new TypeError("approver must be non-empty");
  if (!reason.trim()) throw new TypeError("reason must be non-empty");
  const gateway = createAuditedPiAiModelGateway(loadModelGatewayConfiguration(environment), db, {
    run_cost_limit_usd: modelRunCostLimitUsd(environment),
  });
  const workflow = new ManualEvolutionWorkflow(
    db,
    () => new Date(),
    createLocalModelWorkers(gateway),
    undefined,
    modelExecutionOptions(environment),
  );
  const result = await workflow.approveAndComplete(createModelDemoInput(runId), approverId, reason);
  const admin = new AdminQueryService(db);
  const trace = await admin.getEvolutionTrace(runId);
  if (!trace) throw new Error(`Evolution trace ${runId} was not found after completion`);
  const report = await admin.getRunAudit(runId);
  return {
    run_id: runId,
    state: "learned",
    changeset_id: result.change_set.changeset_id,
    verification_status: "passed",
    outcome_decision: result.outcome.decision,
    task_count: trace.tasks.length,
    transition_count: trace.transitions.length,
    model_calls: report?.totals.model_calls ?? 0,
    failed_calls: report?.totals.failed_calls ?? 0,
    retry_calls: report?.totals.retry_calls ?? 0,
    total_tokens: report?.totals.total_tokens ?? 0,
    total_cost_microusd: report?.totals.total_cost_microusd ?? 0,
    alerts: report?.alerts.map((alert) => `${alert.severity}:${alert.code}`) ?? [],
  };
}

async function runUsage(
  db: Kysely<QuestLabDatabase>,
  runId: string,
): Promise<{ readonly model_calls: number; readonly total_tokens: number; readonly total_cost_microusd: number }> {
  const report = await new AdminQueryService(db).getRunAudit(runId);
  return {
    model_calls: report?.totals.model_calls ?? 0,
    total_tokens: report?.totals.total_tokens ?? 0,
    total_cost_microusd: report?.totals.total_cost_microusd ?? 0,
  };
}

async function runCli(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  const command = arguments_[0];
  if (command !== "start" && command !== "approve") {
    throw new TypeError(
      "Usage: model-local-demo <start|approve> --run-id ID [--approver ID --reason TEXT]",
    );
  }
  const runId = option(arguments_, "--run-id");
  if (!runId) throw new TypeError(`${command} requires --run-id`);
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new TypeError("DATABASE_URL is required");
  await migrateToLatest(connectionString);
  const db = createDatabase(connectionString);
  try {
    if (command === "start") {
      const result = await startModelDemo(db, runId);
      process.stdout.write(`${JSON.stringify({
        ...result,
        next: `npm run sotamodel:approve -- -RunId ${runId} -Approver local.user -Reason "reviewed locally"`,
      }, null, 2)}\n`);
      return;
    }
    const approver = option(arguments_, "--approver");
    const reason = option(arguments_, "--reason");
    if (!approver || !reason) throw new TypeError("approve requires --approver and --reason");
    process.stdout.write(`${JSON.stringify(await approveModelDemo(db, runId, approver, reason), null, 2)}\n`);
  } finally {
    await db.destroy();
  }
}

function option(arguments_: readonly string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  if (index < 0) return undefined;
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) throw new TypeError(`${name} requires a value`);
  return value;
}

const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entryPoint === import.meta.url) await runCli();
