import assert from "node:assert/strict";
import test from "node:test";

import type { DeletionPropagationTask, IndexBuildTask } from "@firefly/contracts";
import type { IndexMemoryChunkInput } from "@firefly/retrieval-postgres";

import {
  AdvancedIndexReadyGate,
  DefaultIndexReadyGate,
  DeletionWorkerError,
  SourceWatermarkQualityProbe,
  ObjectStoreDeletionConsumer,
  MarkdownParentChildChunker,
  PlainTextParagraphChunker,
  type IndexQualityProbe,
} from "../src/index.ts";

const digest = `sha256:${"a".repeat(64)}` as const;

test("plain-text chunking is deterministic and preserves paragraph order", () => {
  const chunker = new PlainTextParagraphChunker(128);
  const chunks = chunker.chunk({
    memory_id: "memory.worker.unit",
    content: `${"a".repeat(140)}\n\nsecond paragraph`,
    source_type: "memory.document",
    citation: { artifact_id: "artifact.worker.unit", uri: "s3://unit/source.txt", digest },
  });

  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map((chunk) => chunk.ordinal), [0, 1, 2]);
  assert.equal(chunks[2]?.content, "second paragraph");
});

test("Markdown chunking creates deterministic Parent/Child sections with structural locators", () => {
  const chunker = new MarkdownParentChildChunker();
  const chunks = chunker.chunk({
    memory_id: "memory.worker.markdown",
    content: "# Solar Output\n\nDaylight changes generation.\n\nBatteries support the night.\n\n## Safety\n\nReserve capacity prevents outages.",
    source_type: "memory.document",
    citation: { artifact_id: "artifact.worker.markdown", uri: "s3://unit/solar.md", digest },
  });

  assert.deepEqual(chunks.map((chunk) => chunk.chunk_level), ["parent", "child", "child", "parent", "child"]);
  assert.deepEqual(chunks.map((chunk) => chunk.ordinal), [0, 1, 2, 3, 4]);
  assert.deepEqual(chunks.filter((chunk) => chunk.chunk_level === "child").map((chunk) => chunk.parent_ordinal), [0, 0, 3]);
  assert.deepEqual(chunks[3]?.structure_path, ["Solar Output", "Safety"]);
  assert.match(chunks[4]?.content ?? "", /^Solar Output > Safety\n\nReserve capacity/u);
  assert.ok((chunks[4]?.content.length ?? Infinity) <= 1_200);
  assert.equal(chunks[4]?.citation.locator?.section_path, "Solar Output > Safety");
});

test("ready gate requires every source document to produce a Chunk", () => {
  const gate = new DefaultIndexReadyGate();
  const documents = ["memory.worker.first", "memory.worker.empty"].map((memory_id) => ({
    memory_id,
    content: "source",
    source_type: "memory.document",
    citation: { artifact_id: `artifact.${memory_id}`, uri: `s3://unit/${memory_id}.txt`, digest },
  }));
  const chunks = [0, 1].map((ordinal): IndexMemoryChunkInput => ({
    chunk_id: `chunk.${ordinal}`,
    memory_id: "memory.worker.first",
    index_version_id: "index.worker.unit",
    ordinal,
    content: `chunk ${ordinal}`,
    chunk_digest: digest,
    token_count: 2,
    source_type: "memory.document",
    citation: documents[0]!.citation,
  }));

  const result = gate.evaluate({ task: indexBuildTask(), documents, chunks });

  assert.equal(result.passed, false);
  assert.deepEqual(result.reasons, ["one or more documents produced no Chunk"]);
});

test("advanced ready gate requires every governed quality probe", () => {
  assert.throws(
    () => new AdvancedIndexReadyGate([passingProbe("acl")]),
    /Missing required index quality probes: source_watermark, recall, citation/,
  );
});

test("advanced ready gate rejects a stale source watermark and preserves every check", async () => {
  const gate = new AdvancedIndexReadyGate([
    passingProbe("citation"),
    passingProbe("recall"),
    new SourceWatermarkQualityProbe(() => "watermark.worker.changed"),
    passingProbe("acl"),
  ]);
  const document = {
    memory_id: "memory.worker.unit",
    content: "source",
    source_type: "memory.document",
    citation: { artifact_id: "artifact.worker.unit", uri: "s3://unit/source.txt", digest },
  };
  const chunk: IndexMemoryChunkInput = {
    chunk_id: "chunk.worker.unit",
    memory_id: document.memory_id,
    index_version_id: "index.worker.unit",
    ordinal: 0,
    content: document.content,
    chunk_digest: digest,
    token_count: 2,
    source_type: document.source_type,
    citation: document.citation,
  };

  const result = await gate.evaluate({ task: indexBuildTask(), documents: [document], chunks: [chunk] });

  assert.equal(result.passed, false);
  assert.deepEqual(result.checks.map((check) => check.name), [
    "structure",
    "source_watermark",
    "acl",
    "recall",
    "citation",
  ]);
  assert.match(result.reasons[0] ?? "", /^source_watermark:/);
});

test("object deletion deduplicates S3 locations and rejects missing resources", async () => {
  const deleted: string[] = [];
  const consumer = new ObjectStoreDeletionConsumer({
    deleteObject: async ({ bucket, key }) => {
      deleted.push(`${bucket}/${key}`);
    },
  });
  const resource = {
    artifact_id: "artifact.worker.object",
    uri: "s3://questlab/users/user-01/memory.json",
    digest,
    media_type: "application/json",
    scope: "user-private",
    owner_id: "user.01",
    lineage_ids: ["memory.worker.object"],
  } as const;
  await consumer.delete(deletionTask([resource, resource]));
  assert.deepEqual(deleted, ["questlab/users/user-01/memory.json"]);

  await assert.rejects(
    consumer.delete(deletionTask([])),
    (error: unknown) => error instanceof DeletionWorkerError && !error.retryable,
  );
});

function deletionTask(resourceRefs: DeletionPropagationTask["resource_refs"]): DeletionPropagationTask {
  return {
    schema_version: 1,
    deletion_id: "deletion.worker.unit",
    memory_id: "memory.worker.unit",
    tenant_id: "tenant.worker",
    target: "object_store",
    content_digest: digest,
    resource_refs: resourceRefs,
    requested_at: "2026-08-10T12:00:00.000Z",
  };
}

function indexBuildTask(): IndexBuildTask {
  return {
    schema_version: 1,
    build_id: "build.worker.unit",
    index_version_id: "index.worker.unit",
    tenant_id: "tenant.worker",
    logical_name: "memory-default",
    index_kind: "hybrid",
    provider: "postgres",
    source_watermark: "watermark.worker.unit",
    configuration_digest: digest,
    requested_at: "2026-08-10T12:00:00.000Z",
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
      summary: `${name} quality threshold passed`,
      evidence_refs: [],
    }),
  };
}
