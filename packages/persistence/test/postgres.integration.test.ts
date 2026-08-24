import assert from "node:assert/strict";
import test from "node:test";

import { sql } from "kysely";

import {
  ArtifactDigestConflictError,
  ArtifactIdentityConflictError,
  ArtifactRepository,
  EvolutionRunRepository,
  InboxRepository,
  MemoryRepository,
  MemoryPolicyError,
  ModelInvocationIdentityConflictError,
  SentinelRepository,
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
          capability: "generate" as const,
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
        const task = await taskRepository.enqueueUngoverned({
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
        const replay = await taskRepository.enqueueUngoverned({
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

      await context.test("a failed attempt releases the lease and the last attempt is terminal", async () => {
        const deadline = new Date(now.getTime() + 60 * 60 * 1000);
        const task = await taskRepository.enqueueUngoverned({
          id: "task.integration.fail.01",
          run_id: "run.integration.01",
          task_type: "AnalyzeLearningOutcomeTask",
          subject: "learning-scientist.fail",
          payload: { cohort: "cohort.synthetic.beginner" },
          artifact_refs: [],
          idempotency_key: "task:analyze:integration.fail.01",
          available_at: now,
          deadline,
          max_attempts: 2,
        });

        const first = await taskRepository.claimNext("learning-scientist.fail", "worker.fail.01", 30_000, now);
        assert.equal(first?.attempt, 1);
        const released = await taskRepository.fail(
          task.id,
          "worker.fail.01",
          { reason: "agent_execution_failed" },
          { retry_after_ms: 0, now },
        );
        // Attempts remain, so the task must be claimable again rather than stuck as leased.
        assert.equal(released.status, "pending");
        assert.equal(released.lease_owner, null);

        const second = await taskRepository.claimNext("learning-scientist.fail", "worker.fail.02", 30_000, now);
        assert.equal(second?.attempt, 2);
        const exhausted = await taskRepository.fail(
          task.id,
          "worker.fail.02",
          { reason: "agent_execution_failed" },
          { now },
        );
        assert.equal(exhausted.status, "failed");
        assert.equal(exhausted.completed_at !== null, true);
        assert.equal(
          await taskRepository.claimNext("learning-scientist.fail", "worker.fail.03", 30_000, now),
          undefined,
        );
        await assert.rejects(
          () => taskRepository.fail(task.id, "worker.fail.02", { reason: "again" }, { now }),
          /holding the lease/u,
        );
      });

      /**
       * Reporting a failure is not more work on the task, it is the report, so an expired lease must
       * not block it. A slow failure is exactly when the lease has run out: a model call that hung for
       * 561 seconds outlived its 30-second lease, `fail()` was rejected, and the task was left `leased`
       * with `last_error` empty. `claimById` still reclaimed it so the run recovered, but the cause was
       * lost and an operator saw a stalled task with no recorded reason.
       */
      await context.test("a worker can report a failure after its own lease expired", async () => {
        const deadline = new Date(now.getTime() + 60 * 60 * 1000);
        const task = await taskRepository.enqueueUngoverned({
          id: "task.integration.fail.expired",
          run_id: "run.integration.01",
          task_type: "AnalyzeLearningOutcomeTask",
          subject: "learning-scientist.expired",
          payload: {},
          artifact_refs: [],
          idempotency_key: "task:analyze:integration.fail.expired",
          available_at: now,
          deadline,
          max_attempts: 2,
        });

        const claimed = await taskRepository.claimNext("learning-scientist.expired", "worker.expired.01", 1_000, now);
        assert.equal(claimed?.attempt, 1);

        // Well past the 1 second lease: the work took longer than the lease allowed, which is the
        // normal shape of a timeout.
        const afterExpiry = new Date(now.getTime() + 120_000);
        const released = await taskRepository.fail(
          task.id,
          "worker.expired.01",
          { reason: "agent_execution_failed", detail: "Connection error." },
          { now: afterExpiry },
        );
        assert.equal(released.status, "pending");
        assert.equal(released.lease_owner, null);
        // The point of the fix: the cause is on record rather than lost.
        assert.equal((released.last_error as { reason?: string } | null)?.reason, "agent_execution_failed");

        // Ownership is still enforced, so a stale worker cannot report on a task it no longer holds.
        const reclaimed = await taskRepository.claimNext("learning-scientist.expired", "worker.expired.02", 30_000, afterExpiry);
        assert.equal(reclaimed?.attempt, 2);
        await assert.rejects(
          () => taskRepository.fail(task.id, "worker.expired.01", { reason: "stale" }, { now: afterExpiry }),
          /holding the lease/u,
        );
      });

      await context.test("the reaper terminates tasks that claimNext can never pick up again", async () => {
        const deadline = new Date(now.getTime() + 60 * 60 * 1000);
        const stalled = await taskRepository.enqueueUngoverned({
          id: "task.integration.reap.01",
          run_id: "run.integration.01",
          task_type: "AnalyzeLearningOutcomeTask",
          subject: "learning-scientist.reap",
          payload: {},
          artifact_refs: [],
          idempotency_key: "task:analyze:integration.reap.01",
          available_at: now,
          deadline,
          max_attempts: 1,
        });
        const claimed = await taskRepository.claimNext("learning-scientist.reap", "worker.reap.01", 1_000, now);
        assert.equal(claimed?.attempt, 1);

        // The lease has expired and no attempts remain: claimNext skips this row forever.
        const afterLease = new Date(now.getTime() + 5_000);
        assert.equal(
          await taskRepository.claimNext("learning-scientist.reap", "worker.reap.02", 30_000, afterLease),
          undefined,
        );

        const reaped = await taskRepository.reapExpired({ now: afterLease });
        assert.equal(reaped.some((task) => task.id === stalled.id), true);
        const after = await taskRepository.findById(stalled.id);
        assert.equal(after?.status, "failed");
        assert.equal(after?.lease_owner, null);

        // Reaping is idempotent: a second pass finds nothing to do.
        assert.equal(
          (await taskRepository.reapExpired({ now: afterLease })).some((task) => task.id === stalled.id),
          false,
        );
      });

      await context.test("model invocation attribution settles run budget usage", async () => {

        const attributedRecord = {
          invocation_id: "model-invocation.integration.attributed.01",
          request_id: "model-request.integration.attributed.01",
          workload: "learning-scientist.analyze",
          capability: "generate" as const,
          route_id: "route.attributed.01",
          transport_id: "pi-ai",
          provider: "test-provider",
          model: "test-model",
          attempt: 1,
          status: "succeeded" as const,
          started_at_ms: now.getTime(),
          completed_at_ms: now.getTime() + 50,
          latency_ms: 50,
          usage: {
            input_tokens: 20,
            output_tokens: 10,
            cached_input_tokens: 0,
            total_tokens: 30,
            cost_usd: 0.001,
          },
          attribution: {
            run_id: "run.integration.01",
            task_id: "task.integration.01",
            agent_id: "learning-scientist" as const,
            tenant_id: "tenant.integration",
            user_id: "user.integration.01",
            origin: "business_agent" as const,
          },
          snapshots: {
            prompt: "prompt:attributed:v1",
            tools: "tools:none:v1",
            knowledge: "knowledge:attributed:v1",
            model: "model:test-provider/test-model:v1",
            routing: "routing:attributed:v1",
          },
        };
        await modelInvocationRepository.record(attributedRecord);
        await modelInvocationRepository.record(attributedRecord);
        await assert.rejects(
          modelInvocationRepository.record({
            ...attributedRecord,
            usage: { ...attributedRecord.usage, total_tokens: 31 },
          }),
          ModelInvocationIdentityConflictError,
        );

        const budget = await db
          .selectFrom("questlab.run_budget_usage")
          .select(["tokens_used", "cost_microusd"])
          .where("run_id", "=", "run.integration.01")
          .executeTakeFirstOrThrow();
        assert.equal(Number(budget.tokens_used), 30);
        assert.equal(Number(budget.cost_microusd), 1_000);
        assert.deepEqual(await modelInvocationRepository.aggregateByAgent("run.integration.01"), [
          {
            agent_id: "learning-scientist",
            calls: 1,
            failed_calls: 0,
            retry_calls: 0,
            input_tokens: 20,
            output_tokens: 10,
            cached_input_tokens: 0,
            total_tokens: 30,
            total_cost_microusd: 1_000,
            average_latency_ms: 50,
          },
        ]);
      });

      await context.test("a recurring Sentinel incident reopens after resolution", async () => {
        const sentinelRepository = new SentinelRepository(db);
        const report = {
          incident_id: "incident.integration.reopen.01",
          run_id: "run.integration.01",
          incident_type: "hop_limit" as const,
          severity: "high" as const,
          fingerprint: "fingerprint.integration.reopen",
          action: "pause" as const,
          details: { hop: 9 },
          observed_at: now,
        };
        const opened = await sentinelRepository.reportIncident(report);
        assert.equal(opened.status, "open");
        assert.equal(opened.occurrence_count, 1);

        await db
          .updateTable("questlab.sentinel_incident")
          .set({ status: "resolved" })
          .where("incident_id", "=", report.incident_id)
          .execute();

        // The condition came back. Leaving the row `resolved` drops it out of the open-incident
        // index, so operators would never be told it recurred.
        const recurred = await sentinelRepository.reportIncident({ ...report, details: { hop: 11 } });
        assert.equal(recurred.status, "open");
        assert.equal(recurred.occurrence_count, 2);
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

        // Same content under a new ID hits UNIQUE (digest, scope, owner_id), which onConflict("id")
        // does not cover; it must surface as a typed error naming the existing artifact.
        await assert.rejects(
          artifactRepository.store({
            artifact_id: "artifact.duplicate.integration.01",
            uri: "https://artifacts.firefly.local/duplicate/01.json",
            digest: source.digest as `sha256:${string}`,
            media_type: source.media_type,
            scope: source.scope,
            owner_id: source.owner_id,
            lineage_ids: [],
            metadata: { kind: "duplicate" },
          }),
          (error: unknown) => {
            assert.ok(error instanceof ArtifactDigestConflictError);
            assert.equal(error.digest, source.digest);
            assert.equal(error.message.includes(source.id), true);
            return true;
          },
        );
      });
    } finally {
      await db.destroy();
    }
  },
);
