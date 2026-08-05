import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { ArtifactRef, LearningEvent } from "@firefly/contracts";
import {
  WorkflowTaskRepository,
  createDatabase,
  migrateToLatest,
} from "@firefly/persistence";
import { sql } from "kysely";

import {
  AdminQueryService,
  ManualEvolutionWorkflow,
  createAdminApiServer,
  type ManualEvolutionInput,
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
      const input = createInput("run.manual.integration");
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
        } finally {
          server.close();
          await once(server, "close");
        }
      });

      await context.test("pending durable tasks can be canceled before lease", async () => {
        const tasks = new WorkflowTaskRepository(db);
        const now = clock();
        await tasks.enqueue({
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
    } finally {
      await db.destroy();
    }
  },
);

function createInput(runId: string): ManualEvolutionInput {
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
    plugin_exposure: {
      plugin_id: "solar-energy",
      version: "1.2.0",
      digest: sourcePlugin.digest,
    },
    artifact_refs: [evidenceArtifact],
  } as const;
  const learningEvents: readonly LearningEvent[] = [
    {
      ...baseEvent,
      event_id: `learning-event.challenge.${runId}`,
      event_type: "challenge_attempted",
      occurred_at: new Date().toISOString(),
      attributes: {
        misconception: "constant_solar_output",
        predicted_night_output_ratio: 1,
      },
    },
    {
      ...baseEvent,
      event_id: `learning-event.review.${runId}`,
      event_type: "delayed_review_completed",
      occurred_at: new Date(Date.now() + 1000).toISOString(),
      attributes: {
        misconception: "constant_solar_output",
        retained_incorrect_model: true,
      },
    },
  ];
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
