import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { ArtifactRef, IndexBuildTask } from "@firefly/contracts";
import type { EmbeddingPort } from "@firefly/model-gateway";
import {
  MemoryRepository,
  OutboxRepository,
  RetrievalIndexRepository,
  createDatabase,
  migrateToLatest,
} from "@firefly/persistence";
import {
  PostgresLexicalRetriever,
  PostgresMemoryIndexer,
  PostgresParentChildExpander,
  PostgresVectorRetriever,
} from "@firefly/retrieval-postgres";
import { sql } from "kysely";

import {
  AdvancedIndexReadyGate,
  DeletionPropagationWorker,
  MarkdownParentChildChunker,
  ObjectStoreDeletionConsumer,
  RetrievalIndexBuildWorker,
  SourceWatermarkQualityProbe,
  type IndexQualityProbe,
} from "../src/index.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const digest = (character: string) => `sha256:${character.repeat(64)}` as const;

test(
  "memory workers build active indexes and recover deletion propagation",
  { skip: connectionString ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    assert.ok(connectionString);
    await migrateToLatest(connectionString);
    const db = createDatabase(connectionString);
    try {
      await sql`
        TRUNCATE TABLE
          questlab.outbox_event,
          questlab.structured_event,
          questlab.retrieval_index_version,
          questlab.memory_record
        RESTART IDENTITY CASCADE
      `.execute(db);
      const memories = new MemoryRepository(db);
      const indexes = new RetrievalIndexRepository(db);
      const outbox = new OutboxRepository(db);
      const indexer = new PostgresMemoryIndexer(db);
      const sourceArtifact = artifact("artifact.worker.source", "s3://questlab/memories/source.txt");
      await memories.capture({
        memory_id: "memory.worker.source",
        tenant_id: "tenant.worker",
        owner_type: "tenant",
        owner_id: "tenant.worker",
        scope: "tenant",
        stage: "structured",
        kind: "document",
        content_digest: sourceArtifact.digest,
        source_refs: [sourceArtifact],
        confidence: 1,
        sensitivity: "internal",
        status: "active",
      });

      const readyBuild = buildTask("ready");
      await indexes.createBuild(readyBuild);
      const embeddings: EmbeddingPort = {
        embed: async ({ inputs }) => ({
          vectors: inputs.map(() => [1, 0, 0]),
          usage: { input_tokens: inputs.length * 4, output_tokens: 0, cached_input_tokens: 0, total_tokens: inputs.length * 4, cost_usd: 0 },
        }),
      };
      let clock = new Date("2026-08-10T12:01:00.000Z");
      const buildWorker = new RetrievalIndexBuildWorker({
        worker_id: "worker.index.integration",
        outbox,
        indexes,
        indexer,
        embeddings,
        embedding_budget: { max_tokens: 1_000, max_cost_usd: 0.01, max_duration_ms: 10_000 },
        ready_gate: new AdvancedIndexReadyGate([
          new SourceWatermarkQualityProbe((task) => task.source_watermark),
          passingProbe("acl"),
          passingProbe("recall"),
          passingProbe("citation"),
        ]),
        chunker: new MarkdownParentChildChunker(),
        auto_activate: true,
        now: () => clock,
        source: {
          load: async (task) => task.build_id.endsWith("empty")
            ? []
            : [{
                memory_id: "memory.worker.source",
                content: "# Solar Systems\n\nOutput follows daylight.\n\nBattery storage supports the night cycle.",
                source_type: "memory.document",
                entity_keys: ["concept.solar", "concept.storage"],
                citation: { artifact_id: sourceArtifact.artifact_id, uri: sourceArtifact.uri, digest: sourceArtifact.digest },
              }],
        },
      });
      assert.deepEqual(await buildWorker.runBatch(), { claimed: 1, completed: 1, failed: 0, released: 0 });
      const activeVersion = await indexes.getById(readyBuild.index_version_id);
      assert.equal(activeVersion?.status, "active");
      const qualityReport = activeVersion?.quality_report as { passed?: boolean; checks?: readonly { name?: string }[] };
      assert.equal(qualityReport.passed, true);
      assert.deepEqual(qualityReport.checks?.map((check) => check.name), [
        "structure",
        "source_watermark",
        "acl",
        "recall",
        "citation",
      ]);
      const chunkLevels = await db
        .selectFrom("questlab.memory_chunk")
        .select(["chunk_level", "parent_chunk_id", "embedding"])
        .where("index_version_id", "=", readyBuild.index_version_id)
        .orderBy("ordinal")
        .execute();
      assert.deepEqual(chunkLevels.map((chunk) => chunk.chunk_level), ["parent", "child", "child"]);
      assert.equal(chunkLevels[0]?.embedding, null);
      assert.ok(chunkLevels.slice(1).every((chunk) => chunk.embedding !== null && chunk.parent_chunk_id !== null));
      const lexical = new PostgresLexicalRetriever(db);
      const hits = await lexical.retrieve({
        query_id: "query.worker.integration",
        query: "solar daylight",
        principal: { tenant_id: "tenant.worker" },
        purpose: "integration_test",
        max_results: 10,
        filters: {},
      });
      assert.equal(hits.length, 1);
      const vector = new PostgresVectorRetriever({
        db,
        embeddings,
        embedding_model: "embedding.worker.v1",
        embedding_budget: { max_tokens: 100, max_cost_usd: 0.01, max_duration_ms: 1_000 },
      });
      const childHits = await vector.retrieve({
        query_id: "query.worker.parent",
        query: "solar battery",
        principal: { tenant_id: "tenant.worker" },
        purpose: "integration_test",
        max_results: 10,
        filters: {},
      });
      assert.equal(childHits.length, 2);
      const expandedHits = await new PostgresParentChildExpander(db).expand({
        hits: childHits,
        principal: { tenant_id: "tenant.worker" },
        purpose: "integration_test",
        max_tokens: 1_000,
      });
      assert.equal(expandedHits.length, 1);
      assert.match(expandedHits[0]?.content ?? "", /Battery storage supports the night cycle/);

      const emptyBuild = buildTask("empty");
      await indexes.createBuild(emptyBuild);
      clock = new Date("2026-08-10T12:02:00.000Z");
      assert.deepEqual(await buildWorker.runBatch(), { claimed: 1, completed: 0, failed: 1, released: 0 });
      assert.equal((await indexes.getById(emptyBuild.index_version_id))?.status, "failed");
      assert.equal((await indexes.getActive("tenant.worker", "memory.hybrid"))?.index_version_id, readyBuild.index_version_id);

      const deletionArtifact = artifact("artifact.worker.delete", "s3://questlab/memories/delete.json");
      await memories.capture({
        memory_id: "memory.worker.delete",
        tenant_id: "tenant.worker",
        owner_type: "user",
        owner_id: "user.worker",
        scope: "user_private",
        stage: "structured",
        kind: "observation",
        content_digest: deletionArtifact.digest,
        source_refs: [deletionArtifact],
        confidence: 1,
        sensitivity: "private",
        status: "active",
      });
      await memories.deleteMemory({
        deletion_id: "deletion.worker.retry",
        memory_id: "memory.worker.delete",
        principal: { tenant_id: "tenant.worker", user_id: "user.worker" },
        requested_by: "user.worker",
        reason: "integration deletion",
        propagation_targets: ["object_store"],
        occurred_at: clock,
      });
      const deleted: string[] = [];
      let providerCalls = 0;
      const deletionWorker = new DeletionPropagationWorker({
        worker_id: "worker.deletion.integration",
        outbox,
        memories,
        consumer: new ObjectStoreDeletionConsumer({
          deleteObject: async ({ bucket, key }) => {
            providerCalls += 1;
            if (providerCalls === 1) throw new Error("temporary object-store outage");
            deleted.push(`${bucket}/${key}`);
          },
        }),
        initial_backoff_ms: 1_000,
        now: () => clock,
      });
      assert.deepEqual(await deletionWorker.runBatch(), { claimed: 1, completed: 0, failed: 0, released: 1 });
      assert.equal((await memories.getDeletionStatus("deletion.worker.retry"))?.receipt.propagation_status, "failed");
      clock = new Date("2026-08-10T12:02:02.000Z");
      assert.deepEqual(await deletionWorker.runBatch(), { claimed: 1, completed: 1, failed: 0, released: 0 });
      assert.deepEqual(deleted, ["questlab/memories/delete.json"]);
      assert.equal((await memories.getDeletionStatus("deletion.worker.retry"))?.receipt.propagation_status, "completed");

      const reconcileArtifact = artifact("artifact.worker.reconcile", "s3://questlab/memories/reconcile.json");
      await memories.capture({
        memory_id: "memory.worker.reconcile",
        tenant_id: "tenant.worker",
        owner_type: "user",
        owner_id: "user.worker",
        scope: "user_private",
        stage: "structured",
        kind: "observation",
        content_digest: reconcileArtifact.digest,
        source_refs: [reconcileArtifact],
        confidence: 1,
        sensitivity: "private",
        status: "active",
      });
      await memories.deleteMemory({
        deletion_id: "deletion.worker.reconcile",
        memory_id: "memory.worker.reconcile",
        principal: { tenant_id: "tenant.worker", user_id: "user.worker" },
        requested_by: "user.worker",
        reason: "reconciliation test",
        propagation_targets: ["object_store"],
        occurred_at: clock,
      });
      const failingWorker = new DeletionPropagationWorker({
        worker_id: "worker.deletion.fail",
        outbox,
        memories,
        consumer: new ObjectStoreDeletionConsumer({ deleteObject: async () => { throw new Error("persistent outage"); } }),
        max_attempts: 1,
        now: () => clock,
      });
      assert.deepEqual(await failingWorker.runBatch(), { claimed: 1, completed: 0, failed: 1, released: 0 });
      clock = new Date("2026-08-10T12:05:00.000Z");
      assert.equal(await memories.reconcileFailedDeletionTargets({ stale_before: clock, limit: 10, now: clock }), 1);
      const recoveryWorker = new DeletionPropagationWorker({
        worker_id: "worker.deletion.recovery",
        outbox,
        memories,
        consumer: new ObjectStoreDeletionConsumer({ deleteObject: async () => undefined }),
        now: () => clock,
      });
      assert.deepEqual(await recoveryWorker.runBatch(), { claimed: 1, completed: 1, failed: 0, released: 0 });
      const reconciled = await memories.getDeletionStatus("deletion.worker.reconcile");
      assert.equal(reconciled?.receipt.propagation_status, "completed");
      assert.equal(reconciled?.targets[0]?.attempt, 2);

      const mismatchedBuild = buildTask("quality-identity");
      await indexes.createBuild(mismatchedBuild);
      await assert.rejects(indexes.completeBuild({
        schema_version: 1,
        build_id: mismatchedBuild.build_id,
        index_version_id: mismatchedBuild.index_version_id,
        status: "ready",
        document_count: 1,
        chunk_count: 1,
        source_watermark: mismatchedBuild.source_watermark,
        completed_at: clock.toISOString(),
        quality_report: {
          schema_version: 1,
          report_id: "quality.worker.mismatched",
          build_id: mismatchedBuild.build_id,
          index_version_id: mismatchedBuild.index_version_id,
          source_watermark: mismatchedBuild.source_watermark,
          configuration_digest: digest("b"),
          passed: true,
          checks: [{
            name: "structure",
            passed: true,
            score: 1,
            threshold: 1,
            sample_size: 1,
            summary: "structure passed",
            evidence_refs: [],
          }],
          evaluated_at: clock.toISOString(),
        },
      }), /quality report does not match/);
      assert.equal((await indexes.getById(mismatchedBuild.index_version_id))?.status, "building");

      const reportlessBuild = buildTask("quality-missing");
      await indexes.createBuild(reportlessBuild);
      await indexes.completeBuild({
        schema_version: 1,
        build_id: reportlessBuild.build_id,
        index_version_id: reportlessBuild.index_version_id,
        status: "ready",
        document_count: 1,
        chunk_count: 1,
        source_watermark: reportlessBuild.source_watermark,
        completed_at: clock.toISOString(),
      });
      await assert.rejects(
        indexes.activate(reportlessBuild.index_version_id, clock),
        /quality report is required for activation/,
      );
      assert.equal((await indexes.getById(reportlessBuild.index_version_id))?.status, "ready");
    } finally {
      await db.destroy();
    }
  },
);

function buildTask(suffix: string): IndexBuildTask {
  return {
    schema_version: 1,
    build_id: `build.worker.${suffix}`,
    index_version_id: `index.worker.${suffix}`,
    tenant_id: "tenant.worker",
    logical_name: "memory.hybrid",
    index_kind: "hybrid",
    provider: "postgres",
    source_watermark: `watermark.${suffix}`,
    configuration_digest: digest("a"),
    embedding_model: "embedding.worker.v1",
    embedding_dimensions: 3,
    requested_at: "2026-08-10T12:00:00.000Z",
  };
}

function artifact(id: string, uri: string): ArtifactRef {
  return {
    artifact_id: id,
    uri,
    digest: `sha256:${createHash("sha256").update(id).digest("hex")}`,
    media_type: "application/json",
    scope: "tenant",
    owner_id: "tenant.worker",
    lineage_ids: [id.replace("artifact", "memory")],
  };
}

function passingProbe(name: IndexQualityProbe["name"]): IndexQualityProbe {
  return {
    name,
    evaluate: () => ({
      passed: true,
      score: 1,
      threshold: 0.9,
      sample_size: 10,
      summary: `${name} integration quality passed`,
      evidence_refs: [],
    }),
  };
}
