import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

import {
  WorkflowTaskRepository,
  createDatabase,
  migrateToLatest,
} from "@firefly/persistence";
import { sql } from "kysely";

import {
  AdminQueryService,
  ManualEvolutionWorkflow,
  approveLocalDemo,
  createLocalDemoInput,
  createAdminApiServer,
  startLocalDemo,
} from "../src/index.ts";

const connectionString = process.env.TEST_DATABASE_URL;

test(
  "manual three-Agent loop produces a queryable causal chain",
  { skip: connectionString ? false : "TEST_DATABASE_URL is not configured" },
  async (context) => {
    assert.ok(connectionString);
    await migrateToLatest(connectionString);
    const db = createDatabase(connectionString);

    try {
      await sql`
        TRUNCATE TABLE
          questlab.evolution_run,
          questlab.outbox_event,
          questlab.inbox_receipt,
          questlab.artifact
        RESTART IDENTITY CASCADE
      `.execute(db);

      let clockValue = Date.now() + 60_000;
      const clock = (): Date => {
        clockValue += 1000;
        return new Date(clockValue);
      };
      const input = createLocalDemoInput("run.manual.integration");
      const workflow = new ManualEvolutionWorkflow(db, clock);

      await context.test("the workflow stops at the human approval boundary", async () => {
        const awaiting = await workflow.start(input);
        assert.equal(awaiting.run.state, "awaiting_approval");
        assert.equal(awaiting.run.version, 3);
        assert.equal(awaiting.plan.status, "proposed");

        const trace = await new AdminQueryService(db).getEvolutionTrace(input.run_id);
        assert.ok(trace);
        assert.equal(trace.transitions.length, 3);
        assert.equal(trace.tasks.length, 2);
        assert.equal(trace.approvals.length, 1);
        assert.equal(trace.outcome, undefined);
      });

      await context.test("approval resumes all three Agents and reaches learned", async () => {
        const completed = await workflow.approveAndComplete(
          input,
          "teacher.integration",
          "Synthetic cohort only; verification contract is locked.",
        );
        assert.equal(completed.run.state, "learned");
        assert.equal(completed.run.version, 9);
        assert.equal(completed.verification.status, "passed");
        assert.equal(completed.outcome.decision, "recommend_activate");

        const trace = await new AdminQueryService(db).getEvolutionTrace(input.run_id);
        assert.ok(trace);
        assert.equal(trace.transitions.length, 9);
        assert.equal(trace.tasks.length, 5);
        assert.equal(trace.agent_results.length, 5);
        assert.equal(trace.learning_events.length, 2);
        assert.equal(trace.artifacts.length, 5);
        assert.equal(trace.causal_edges.length, 4);
        assert.equal(trace.sentinel_incidents.length, 0);
        assert.equal(trace.quarantines.length, 0);
        const budget = trace.budget_usage as {
          readonly tasks_created: number;
          readonly transitions_applied: number;
        };
        assert.equal(budget.tasks_created, 5);
        assert.equal(budget.transitions_applied, 9);
        assert.deepEqual(
          (trace.tasks as readonly { readonly hop_count: number }[]).map((task) => task.hop_count),
          [0, 1, 2, 3, 4],
        );
        assert.deepEqual(
          new Set(
            (trace.tasks as readonly { readonly subject: string }[]).map((task) => task.subject),
          ),
          new Set(["learning-director", "learning-scientist", "experience-engineer"]),
        );
        const approval = (trace.approvals as readonly { readonly status: string }[])[0];
        assert.equal(approval?.status, "approved");
      });

      await context.test("Admin API exposes the persisted trace read-only", async () => {
        const server = createAdminApiServer(new AdminQueryService(db));
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        try {
          const address = server.address() as AddressInfo;
          const response = await fetch(
            `http://127.0.0.1:${address.port}/admin/evolution-runs/${input.run_id}`,
          );
          assert.equal(response.status, 200);
          const body = (await response.json()) as {
            readonly run: { readonly state: string };
            readonly tasks: readonly unknown[];
          };
          assert.equal(body.run.state, "learned");
          assert.equal(body.tasks.length, 5);

          const usageResponse = await fetch(
            `http://127.0.0.1:${address.port}/admin/audit/agents`,
          );
          assert.equal(usageResponse.status, 200);
          const usageBody = (await usageResponse.json()) as {
            readonly agents: readonly { readonly agent_id: string; readonly task_count: number }[];
          };
          assert.deepEqual(
            usageBody.agents.map((agent) => [agent.agent_id, agent.task_count]),
            [
              ["learning-director", 2],
              ["learning-scientist", 2],
              ["experience-engineer", 1],
            ],
          );

          const auditResponse = await fetch(
            `http://127.0.0.1:${address.port}/admin/audit/runs/${input.run_id}`,
          );
          assert.equal(auditResponse.status, 200);
          const auditBody = (await auditResponse.json()) as {
            readonly run_id: string;
            readonly totals: { readonly task_count: number; readonly model_calls: number };
            readonly privacy: string;
          };
          assert.equal(auditBody.run_id, input.run_id);
          assert.equal(auditBody.totals.task_count, 5);
          assert.equal(auditBody.totals.model_calls, 0);
          assert.equal(auditBody.privacy, "metadata_and_digests_only");
        } finally {
          server.close();
          await once(server, "close");
        }
      });

      await context.test("pending durable tasks can be canceled before lease", async () => {
        const tasks = new WorkflowTaskRepository(db);
        const now = clock();
        await tasks.enqueueUngoverned({
          id: "task.cancel.integration",
          run_id: input.run_id,
          task_type: "AnalyzeLearningOutcomeTask",
          subject: "learning-scientist",
          payload: { reason: "cancellation-test" },
          artifact_refs: [],
          idempotency_key: "cancel-test:run.manual.integration",
          available_at: now,
          deadline: new Date(now.getTime() + 60_000),
          max_attempts: 3,
        });
        assert.equal(await tasks.requestCancellation("task.cancel.integration", clock()), true);
        assert.equal((await tasks.findById("task.cancel.integration"))?.status, "canceled");
        assert.equal(
          await tasks.claimNext("learning-scientist", "worker.cancel.integration", 30_000, clock()),
          undefined,
        );
      });

      await context.test("local CLI operations preserve the manual approval boundary", async () => {
        const runId = "run.local.cli.integration";
        const awaiting = await startLocalDemo(db, runId);
        assert.equal(awaiting.state, "awaiting_approval");
        assert.equal(awaiting.approval_id, `approval.${runId}`);

        const completed = await approveLocalDemo(
          db,
          runId,
          "teacher.local.integration",
          "Reviewed the persisted local plan.",
        );
        assert.equal(completed.state, "learned");
        assert.equal(completed.verification_status, "passed");
        assert.equal(completed.task_count, 5);
        assert.equal(completed.transition_count, 9);
      });

      await context.test("concurrent runs do not steal each other's Agent tasks", async () => {
        // `subject` is the Agent id and carries no run dimension, so every concurrent run competes
        // for the same queue head. Leasing by task identity is what keeps them isolated; leasing by
        // subject made 75 percent of runs fail at concurrency 4 and all of them at concurrency 8.
        const taskRepository = new WorkflowTaskRepository(db);
        const runIds = Array.from({ length: 6 }, (_, index) => `run.concurrent.integration.${index}`);
        const outcomes = await Promise.allSettled(
          runIds.map(async (runId) => {
            await startLocalDemo(db, runId);
            return approveLocalDemo(db, runId, "teacher.concurrent", "Concurrent isolation check.");
          }),
        );

        assert.deepEqual(
          outcomes
            .filter((outcome) => outcome.status === "rejected")
            .map((outcome) => String((outcome as PromiseRejectedResult).reason?.message)),
          [],
          "no concurrent run may fail",
        );
        for (const outcome of outcomes) {
          assert.equal((outcome as PromiseFulfilledResult<{ state: string }>).value.state, "learned");
        }

        // Each run must own exactly its own five tasks. A stolen task surfaces as a run missing a
        // task rather than as an error, so reaching `learned` is not sufficient evidence on its own.
        for (const runId of runIds) {
          const owned = await taskRepository.findByRunId(runId);
          assert.equal(owned.length, 5, `${runId} must own five tasks`);
          assert.ok(
            owned.every((task) => task.status === "completed"),
            `${runId} tasks must all be completed`,
          );
        }
      });

    } finally {
      await db.destroy();
    }
  },
);
