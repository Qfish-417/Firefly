import assert from "node:assert/strict";
import test from "node:test";

import type { JsonObject, TaskEnvelope } from "@firefly/contracts";
import {
  EventStormError,
  LoopSentinel,
  defaultGovernancePolicy,
  fingerprintTask,
  type GovernancePolicy,
} from "@firefly/governance";
import {
  CausalCycleError,
  EvolutionRunRepository,
  EvolutionTransitionBudgetError,
  SentinelRepository,
  TaskGovernanceError,
  createDatabase,
  migrateToLatest,
  type QuestLabDatabase,
  type WorkflowTaskRecord,
} from "@firefly/persistence";
import { sql, type Kysely } from "kysely";

const connectionString = process.env.TEST_DATABASE_URL;

test(
  "governance sentinel blocks loops, storms and exhausted runs",
  { skip: connectionString ? false : "TEST_DATABASE_URL is not configured" },
  async (context) => {
    assert.ok(connectionString);
    await migrateToLatest(connectionString);
    const db = createDatabase(connectionString);
    try {
      await sql`
        TRUNCATE TABLE questlab.evolution_run, questlab.artifact
        RESTART IDENTITY CASCADE
      `.execute(db);

      await context.test("repeated task fingerprints are rejected and deduplicated", async () => {
        const runId = "run.governance.repetition";
        await createRun(db, runId);
        const sentinel = new LoopSentinel(db);
        const first = createTask(runId, "task.repetition.root", "learning-director", { step: "same" });
        await dispatch(sentinel, first);

        for (const suffix of ["second", "third"]) {
          const repeated = createTask(
            runId,
            `task.repetition.${suffix}`,
            "learning-director",
            { step: "same" },
          );
          await assert.rejects(dispatch(sentinel, repeated), (error: unknown) => {
            return error instanceof TaskGovernanceError && error.violation === "task_repetition";
          });
        }

        const incidents = await new SentinelRepository(db).listIncidents(runId);
        assert.equal(incidents.length, 1);
        assert.equal(incidents[0]?.occurrence_count, 2);
        assert.equal(
          await new SentinelRepository(db).isQuarantined(runId, "run", runId),
          false,
        );
      });

      await context.test("self-delegation quarantines the offending Agent", async () => {
        const runId = "run.governance.delegation";
        await createRun(db, runId);
        const sentinel = new LoopSentinel(db);
        const root = createTask(runId, "task.delegation.root", "learning-director", { step: "root" });
        await dispatch(sentinel, root);
        const child = createTask(
          runId,
          "task.delegation.child",
          "learning-director",
          { step: "child" },
          root.message_id,
          1,
        );
        await assert.rejects(dispatch(sentinel, child), TaskGovernanceError);
        assert.equal(
          await new SentinelRepository(db).isQuarantined(
            runId,
            "agent",
            "learning-director",
          ),
          true,
        );
      });

      await context.test("causal cycles quarantine the whole run", async () => {
        const runId = "run.governance.cycle";
        await createRun(db, runId);
        const sentinel = new LoopSentinel(db);
        await sentinel.link({ run_id: runId, parent_node_id: "node.a", child_node_id: "node.b", edge_type: "event" });
        await sentinel.link({ run_id: runId, parent_node_id: "node.b", child_node_id: "node.c", edge_type: "event" });
        await assert.rejects(
          sentinel.link({ run_id: runId, parent_node_id: "node.c", child_node_id: "node.a", edge_type: "event" }),
          CausalCycleError,
        );
        assert.equal(
          await new SentinelRepository(db).isQuarantined(runId, "run", runId),
          true,
        );
      });

      await context.test("concurrent opposite causal edges cannot form a cycle", async () => {
        const runId = "run.governance.concurrent-cycle";
        await createRun(db, runId);
        const sentinel = new LoopSentinel(db);
        const results = await Promise.allSettled([
          sentinel.link({ run_id: runId, parent_node_id: "node.left", child_node_id: "node.right", edge_type: "event" }),
          sentinel.link({ run_id: runId, parent_node_id: "node.right", child_node_id: "node.left", edge_type: "event" }),
        ]);
        assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
        const rejected = results.find((result) => result.status === "rejected");
        assert.ok(rejected && rejected.status === "rejected");
        assert.ok(rejected.reason instanceof CausalCycleError);
        assert.equal(
          await new SentinelRepository(db).isQuarantined(runId, "run", runId),
          true,
        );
      });

      await context.test("the sentinel owns retry caps and persisted task identity", async () => {
        const retryRun = "run.governance.retry-cap";
        await createRun(db, retryRun);
        const limitedPolicy: GovernancePolicy = {
          ...defaultGovernancePolicy,
          snapshot: "governance.test.retry-cap",
          max_retries_per_task: 1,
        };
        const retrySentinel = new LoopSentinel(db, limitedPolicy);
        const task = createTask(
          retryRun,
          "task.retry-cap.root",
          "learning-director",
          { step: "root" },
          undefined,
          0,
          limitedPolicy,
        );
        const persisted = await dispatch(retrySentinel, task);
        assert.equal(persisted.max_attempts, 1);

        const mismatchRun = "run.governance.identity-mismatch";
        await createRun(db, mismatchRun);
        const mismatchTask = createTask(
          mismatchRun,
          "task.identity-mismatch.root",
          "learning-director",
          { step: "root" },
        );
        await assert.rejects(
          new LoopSentinel(db).dispatch(mismatchTask, {
            id: mismatchTask.message_id,
            run_id: mismatchRun,
            task_type: mismatchTask.message_type,
            subject: "learning-scientist",
            payload: mismatchTask.payload,
            artifact_refs: [],
            idempotency_key: mismatchTask.idempotency_key,
            available_at: new Date(mismatchTask.created_at),
            deadline: new Date(mismatchTask.deadline),
            max_attempts: mismatchTask.retry_policy.max_attempts,
          }),
          (error: unknown) =>
            error instanceof TaskGovernanceError && error.violation === "delegation_violation",
        );
      });

      await context.test("task budget and hop limits stop unbounded delegation", async () => {
        const budgetRun = "run.governance.budget";
        await createRun(db, budgetRun);
        const limitedPolicy: GovernancePolicy = {
          ...defaultGovernancePolicy,
          snapshot: "governance.test.budget",
          max_tasks_per_run: 1,
        };
        const budgetSentinel = new LoopSentinel(db, limitedPolicy);
        const root = createTask(
          budgetRun,
          "task.budget.root",
          "learning-director",
          { step: "root" },
          undefined,
          0,
          limitedPolicy,
        );
        await dispatch(budgetSentinel, root);
        const child = createTask(
          budgetRun,
          "task.budget.child",
          "learning-scientist",
          { step: "child" },
          root.message_id,
          1,
          limitedPolicy,
        );
        await assert.rejects(dispatch(budgetSentinel, child), (error: unknown) => {
          return error instanceof TaskGovernanceError && error.violation === "budget_exhausted";
        });

        const hopRun = "run.governance.hops";
        await createRun(db, hopRun);
        const hopPolicy: GovernancePolicy = {
          ...defaultGovernancePolicy,
          snapshot: "governance.test.hops",
          max_hops: 1,
        };
        const hopSentinel = new LoopSentinel(db, hopPolicy);
        const hopRoot = createTask(
          hopRun,
          "task.hops.root",
          "learning-director",
          { step: "root" },
          undefined,
          0,
          hopPolicy,
        );
        await dispatch(hopSentinel, hopRoot);
        const tooDeep = createTask(
          hopRun,
          "task.hops.deep",
          "learning-scientist",
          { step: "deep" },
          hopRoot.message_id,
          2,
          hopPolicy,
        );
        await assert.rejects(dispatch(hopSentinel, tooDeep), (error: unknown) => {
          return error instanceof TaskGovernanceError && error.violation === "hop_limit";
        });
      });

      await context.test("event storms create one incident and quarantine the run", async () => {
        const runId = "run.governance.storm";
        await createRun(db, runId);
        let tick = Date.now();
        const sentinel = new LoopSentinel(db, defaultGovernancePolicy, () => new Date(++tick));
        const fingerprint = `sha256:${"f".repeat(64)}`;
        for (let index = 1; index <= 3; index += 1) {
          assert.equal(
            await sentinel.observeEvent({
              observation_id: `observation.storm.${index}`,
              run_id: runId,
              event_type: "LearningFindingCreated",
              fingerprint,
              max_occurrences: 3,
              window_ms: 60_000,
            }),
            index,
          );
        }
        await assert.rejects(
          sentinel.observeEvent({
            observation_id: "observation.storm.4",
            run_id: runId,
            event_type: "LearningFindingCreated",
            fingerprint,
            max_occurrences: 3,
            window_ms: 60_000,
          }),
          EventStormError,
        );
        const repository = new SentinelRepository(db);
        assert.equal((await repository.listIncidents(runId)).length, 1);
        assert.equal(await repository.isQuarantined(runId, "run", runId), true);
      });

      await context.test("state transition budgets cap self-sustaining workflows", async () => {
        const runId = "run.governance.transitions";
        await createRun(db, runId);
        const runs = new EvolutionRunRepository(db);
        const now = new Date();
        const first = await runs.transition(runId, {
          event_id: "event.transitions.finding",
          event: "finding_created",
          expected_version: 0,
          trace_id: "trace.governance.transitions",
          producer: "control-plane",
          occurred_at: now,
          max_transitions: 1,
        });
        assert.equal(first.run.state, "diagnosed");
        await assert.rejects(
          runs.transition(runId, {
            event_id: "event.transitions.plan",
            event: "plan_created",
            expected_version: 1,
            trace_id: "trace.governance.transitions",
            producer: "control-plane",
            occurred_at: new Date(now.getTime() + 1),
            max_transitions: 1,
          }),
          EvolutionTransitionBudgetError,
        );
        assert.equal((await runs.findById(runId))?.state, "diagnosed");
      });
    } finally {
      await db.destroy();
    }
  },
);

async function createRun(db: Kysely<QuestLabDatabase>, runId: string): Promise<void> {
  await new EvolutionRunRepository(db).create({
    id: runId,
    correlation_id: `correlation.${runId}`,
    goal: { purpose: "governance-test" },
    budget: { max_tasks: 32, max_transitions: 24 },
    risk_level: "high",
  });
}

function createTask(
  runId: string,
  taskId: string,
  subject: string,
  payload: JsonObject,
  parentTaskId?: string,
  hopCount = 0,
  policy: GovernancePolicy = defaultGovernancePolicy,
): TaskEnvelope {
  const taskType = "AnalyzeLearningOutcomeTask";
  const fingerprint = fingerprintTask({
    task_type: taskType,
    subject,
    payload,
    artifact_refs: [],
  });
  const now = new Date();
  return {
    message_id: taskId,
    message_type: taskType,
    schema_version: 1,
    correlation_id: runId,
    trace_id: `trace.${runId}`,
    producer: "control-plane",
    subject,
    idempotency_key: `dispatch:${taskId}`,
    created_at: now.toISOString(),
    deadline: new Date(now.getTime() + 60_000).toISOString(),
    cancellation_token: `cancel.${taskId}`,
    lease: { duration_sec: 30, heartbeat_sec: 5 },
    retry_policy: { max_attempts: 3, initial_backoff_ms: 100, max_backoff_ms: 1000 },
    budget: { max_tokens: 0, max_cost_usd: 0, max_duration_sec: 60 },
    governance: {
      root_run_id: runId,
      ...(parentTaskId ? { parent_task_id: parentTaskId } : {}),
      hop_count: hopCount,
      max_hops: policy.max_hops,
      task_fingerprint: fingerprint,
      policy_snapshot: policy.snapshot,
      epoch: 0,
    },
    artifact_refs: [],
    payload,
  };
}

async function dispatch(sentinel: LoopSentinel, task: TaskEnvelope): Promise<WorkflowTaskRecord> {
  return sentinel.dispatch(task, {
    id: task.message_id,
    run_id: task.correlation_id,
    task_type: task.message_type,
    subject: task.subject,
    payload: task.payload,
    artifact_refs: [],
    idempotency_key: task.idempotency_key,
    available_at: new Date(task.created_at),
    deadline: new Date(task.deadline),
    max_attempts: task.retry_policy.max_attempts,
  });
}
