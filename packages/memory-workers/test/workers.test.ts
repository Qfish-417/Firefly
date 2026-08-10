import assert from "node:assert/strict";
import test from "node:test";

import type { DeletionPropagationTask, IndexBuildTask } from "@firefly/contracts";
import type { IndexMemoryChunkInput } from "@firefly/retrieval-postgres";

import {
  DefaultIndexReadyGate,
  DeletionWorkerError,
  ObjectStoreDeletionConsumer,
  PlainTextParagraphChunker,
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
