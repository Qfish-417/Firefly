import assert from "node:assert/strict";
import test from "node:test";

import { sql } from "kysely";

import {
  ArtifactIdentityConflictError,
  ArtifactRepository,
  EvolutionRunRepository,
  InboxRepository,
  OutboxRepository,
  WorkflowTaskRepository,
  createDatabase,
  migrateToLatest,
} from "../src/index.ts";

const connectionString = process.env.TEST_DATABASE_URL;

test(
  "PostgreSQL fact layer preserves workflow, event and artifact invariants",
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

      const now = new Date();
      const runRepository = new EvolutionRunRepository(db);
      const taskRepository = new WorkflowTaskRepository(db);
      const outboxRepository = new OutboxRepository(db);
      const inboxRepository = new InboxRepository(db);
      const artifactRepository = new ArtifactRepository(db);

      await context.test("EvolutionRun transition and Outbox write are idempotent", async () => {
        await runRepository.create({
          id: "run.integration.01",
          correlation_id: "correlation.integration.01",
          goal: { concept: "physics.energy.power" },
          budget: { max_cost_usd: 5, max_duration_sec: 3600 },
          risk_level: "high",
        });

        const command = {
          event_id: "event.finding-created.integration.01",
          event: "finding_created" as const,
          expected_version: 0,
          trace_id: "trace.integration.01",
          producer: "learning-scientist",
          occurred_at: now,
        };
        const first = await runRepository.transition("run.integration.01", command);
        const replay = await runRepository.transition("run.integration.01", command);

        assert.equal(first.changed, true);
        assert.equal(first.run.state, "diagnosed");
        assert.equal(first.run.version, 1);
        assert.equal(replay.changed, false);
        assert.equal(replay.run.version, 1);

        const outboxCount = await db
          .selectFrom("questlab.outbox_event")
          .select((expression) => expression.fn.countAll<number>().as("count"))
          .executeTakeFirstOrThrow();
        assert.equal(Number(outboxCount.count), 1);

        const claimed = await outboxRepository.claimBatch("dispatcher.01", 10, 30_000, now);
        assert.equal(claimed.length, 1);
        assert.equal(claimed[0]?.attempts, 1);
        assert.equal(
          await outboxRepository.markPublished(claimed[0]!.event_id, "dispatcher.01", now),
          true,
        );
      });

      await context.test("workflow tasks use durable leases and checkpoints", async () => {
        const deadline = new Date(now.getTime() + 60 * 60 * 1000);
        const task = await taskRepository.enqueue({
          id: "task.integration.01",
          run_id: "run.integration.01",
          task_type: "AnalyzeLearningOutcomeTask",
          subject: "learning-scientist",
          payload: { cohort: "cohort.synthetic.beginner" },
          artifact_refs: [],
          idempotency_key: "task:analyze:integration.01",
          available_at: now,
          deadline,
          max_attempts: 3,
        });
        const replay = await taskRepository.enqueue({
          id: "task.integration.01",
          run_id: "run.integration.01",
          task_type: "AnalyzeLearningOutcomeTask",
          subject: "learning-scientist",
          payload: { cohort: "cohort.synthetic.beginner" },
          artifact_refs: [],
          idempotency_key: "task:analyze:integration.01",
          available_at: now,
          deadline,
          max_attempts: 3,
        });
        assert.equal(replay.id, task.id);

        const claimed = await taskRepository.claimNext(
          "learning-scientist",
          "worker.scientist.01",
          30_000,
          now,
        );
        assert.equal(claimed?.status, "leased");
        assert.equal(claimed?.attempt, 1);
        assert.equal(
          await taskRepository.claimNext(
            "learning-scientist",
            "worker.scientist.02",
            30_000,
            now,
          ),
          undefined,
        );

        assert.equal(
          await taskRepository.saveCheckpoint(
            task.id,
            "worker.scientist.01",
            1,
            { processed_events: 100 },
            now,
          ),
          true,
        );
        assert.equal(
          await taskRepository.saveCheckpoint(
            task.id,
            "worker.scientist.01",
            1,
            { processed_events: 100 },
            now,
          ),
          false,
        );

        const completed = await taskRepository.complete(
          task.id,
          "worker.scientist.01",
          { finding_id: "finding.integration.01" },
          now,
        );
        assert.equal(completed.status, "completed");
        assert.equal(completed.lease_owner, null);
      });

      await context.test("Inbox records each consumer event once", async () => {
        assert.equal(await inboxRepository.recordOnce("learning-scientist", "event.integration.01", now), true);
        assert.equal(await inboxRepository.recordOnce("learning-scientist", "event.integration.01", now), false);
        assert.equal(await inboxRepository.recordOnce("learning-director", "event.integration.01", now), true);
      });

      await context.test("Artifact identity, ACL and lineage are enforced", async () => {
        const source = await artifactRepository.store({
          artifact_id: "artifact.source.integration.01",
          uri: "https://artifacts.firefly.local/source/01.json",
          digest: `sha256:${"b".repeat(64)}`,
          media_type: "application/json",
          scope: "tenant",
          owner_id: "tenant.questlab",
          lineage_ids: [],
          metadata: { kind: "learning-evidence" },
        });
        const derived = await artifactRepository.store({
          artifact_id: "artifact.derived.integration.01",
          uri: "https://artifacts.firefly.local/derived/01.json",
          digest: `sha256:${"c".repeat(64)}`,
          media_type: "application/json",
          scope: "agent-private",
          owner_id: "learning-scientist",
          lineage_ids: [source.id],
          metadata: { kind: "evidence-pack" },
        });

        const director = { type: "agent" as const, id: "learning-director" };
        assert.equal(await artifactRepository.canRead(derived.id, director), false);
        await artifactRepository.grant(derived.id, director, "read");
        assert.equal(await artifactRepository.canRead(derived.id, director), true);

        const lineage = await db
          .selectFrom("questlab.artifact_lineage")
          .selectAll()
          .where("artifact_id", "=", derived.id)
          .executeTakeFirstOrThrow();
        assert.equal(lineage.source_artifact_id, source.id);

        await assert.rejects(
          artifactRepository.store({
            artifact_id: derived.id,
            uri: derived.uri,
            digest: `sha256:${"d".repeat(64)}`,
            media_type: derived.media_type,
            scope: derived.scope,
            owner_id: derived.owner_id,
            lineage_ids: [source.id],
            metadata: { kind: "mutated" },
          }),
          ArtifactIdentityConflictError,
        );
      });
    } finally {
      await db.destroy();
    }
  },
);
