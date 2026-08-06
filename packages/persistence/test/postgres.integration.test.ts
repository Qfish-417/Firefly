import assert from "node:assert/strict";
import test from "node:test";

import { sql } from "kysely";

import {
  ArtifactIdentityConflictError,
  ArtifactRepository,
  EvolutionRunRepository,
  InboxRepository,
  MemoryRepository,
  MemoryPolicyError,
  ModelInvocationRepository,
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
          questlab.artifact,
          questlab.model_invocation,
          questlab.structured_event,
          questlab.memory_record
        RESTART IDENTITY CASCADE
      `.execute(db);

      const now = new Date();
      const runRepository = new EvolutionRunRepository(db);
      const taskRepository = new WorkflowTaskRepository(db);
      const outboxRepository = new OutboxRepository(db);
      const inboxRepository = new InboxRepository(db);
      const artifactRepository = new ArtifactRepository(db);
      const modelInvocationRepository = new ModelInvocationRepository(db);
      const memoryRepository = new MemoryRepository(db);

      await context.test("model invocation projection is idempotent and aggregatable", async () => {
        const record = {
          invocation_id: "model-invocation.integration.01",
          request_id: "model-request.integration.01",
          workload: "learning-scientist.analyze",
          route_id: "route.01",
          transport_id: "pi-ai",
          provider: "test-provider",
          model: "test-model",
          attempt: 1,
          status: "succeeded" as const,
          started_at_ms: now.getTime(),
          completed_at_ms: now.getTime() + 42,
          latency_ms: 42,
          usage: {
            input_tokens: 20,
            output_tokens: 10,
            cached_input_tokens: 0,
            total_tokens: 30,
            cost_usd: 0.001,
          },
          snapshots: {
            prompt: "prompt:test:v1",
            tools: "tools:none:v1",
            knowledge: "knowledge:test:v1",
            model: "model:test-provider/test-model:v1",
            routing: "routing:test:v1",
          },
        };
        const first = await modelInvocationRepository.record(record);
        const replay = await modelInvocationRepository.record(record);
        assert.equal(first.invocation_id, replay.invocation_id);
        const aggregate = await modelInvocationRepository.aggregate({
          workload: "learning-scientist.analyze",
        });
        assert.deepEqual(aggregate, [
          {
            workload: "learning-scientist.analyze",
            provider: "test-provider",
            status: "succeeded",
            calls: 1,
            total_tokens: 30,
            total_cost_microusd: 1_000,
            average_latency_ms: 42,
          },
        ]);
      });

      await context.test("memory ACLs isolate users and structured aggregation counts distinct events", async () => {
        await memoryRepository.capture({
          memory_id: "memory.integration.public",
          tenant_id: "tenant.integration",
          owner_type: "platform",
          owner_id: "platform",
          scope: "public",
          stage: "structured",
          kind: "event",
          content_digest: "sha256:public",
          confidence: 1,
          sensitivity: "public",
          status: "active",
        });
        await memoryRepository.capture({
          memory_id: "memory.integration.user",
          tenant_id: "tenant.integration",
          owner_type: "user",
          owner_id: "user.integration.01",
          scope: "user_private",
          stage: "structured",
          kind: "event",
          content_digest: "sha256:user",
          confidence: 0.9,
          sensitivity: "private",
          status: "active",
        });
        await memoryRepository.capture({
          memory_id: "memory.integration.other-user",
          tenant_id: "tenant.integration",
          owner_type: "user",
          owner_id: "user.integration.02",
          scope: "user_private",
          stage: "structured",
          kind: "event",
          content_digest: "sha256:other",
          confidence: 0.9,
          sensitivity: "private",
          status: "active",
        });

        const principal = { tenant_id: "tenant.integration", user_id: "user.integration.01" };
        const readable = await memoryRepository.listReadable(principal);
        assert.deepEqual(readable.map((memory) => memory.memory_id).sort(), [
          "memory.integration.public",
          "memory.integration.user",
        ]);

        await memoryRepository.recordEvent({
          event_id: "event.integration.trip.01",
          tenant_id: "tenant.integration",
          subject_id: "user.integration.01",
          event_type: "travel",
          object: { country_code: "US" },
          scope: "user_private",
          owner_id: "user.integration.01",
          occurred_from: new Date("2026-05-10T00:00:00Z"),
          dedupe_key: "travel:user.integration.01:US:2026-05-10",
          source_memory_ids: ["memory.integration.user"],
          confidence: 0.9,
        });
        await memoryRepository.recordEvent({
          event_id: "event.integration.trip.01-duplicate",
          tenant_id: "tenant.integration",
          subject_id: "user.integration.01",
          event_type: "travel",
          object: { country_code: "US" },
          scope: "user_private",
          owner_id: "user.integration.01",
          occurred_from: new Date("2026-05-10T00:00:00Z"),
          dedupe_key: "travel:user.integration.01:US:2026-05-10-duplicate",
          source_memory_ids: ["memory.integration.user"],
          confidence: 0.9,
        });
        await memoryRepository.recordEvent({
          event_id: "event.integration.trip.other",
          tenant_id: "tenant.integration",
          subject_id: "user.integration.02",
          event_type: "travel",
          object: { country_code: "US" },
          scope: "user_private",
          owner_id: "user.integration.02",
          occurred_from: new Date("2026-05-11T00:00:00Z"),
          dedupe_key: "travel:user.integration.02:US:2026-05-11",
          source_memory_ids: ["memory.integration.other-user"],
          confidence: 0.9,
        });
        await assert.rejects(
          memoryRepository.recordEvent({
            event_id: "event.integration.private-leak",
            tenant_id: "tenant.integration",
            subject_id: "user.integration.01",
            event_type: "travel",
            object: { country_code: "US" },
            scope: "public",
            owner_id: "platform",
            occurred_from: new Date("2026-05-12T00:00:00Z"),
            dedupe_key: "travel:user.integration.01:US:private-leak",
            source_memory_ids: ["memory.integration.user"],
            confidence: 0.9,
          }),
          (error: unknown) => error instanceof MemoryPolicyError,
        );

        const aggregate = await memoryRepository.aggregateReadableEvents(principal, {
          subject_id: "user.integration.01",
          event_type: "travel",
        });
        assert.equal(aggregate.operation, "count_distinct");
        assert.equal(aggregate.value, 2);
        assert.deepEqual(aggregate.included_event_ids, [
          "event.integration.trip.01",
          "event.integration.trip.01-duplicate",
        ]);
      });

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
