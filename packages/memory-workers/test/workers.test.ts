import assert from "node:assert/strict";
import test from "node:test";

import type { DeletionPropagationTask, IndexBuildTask, IndexEvaluationSet } from "@firefly/contracts";
import type { IndexMemoryChunkInput } from "@firefly/retrieval-postgres";

import {
  AdvancedIndexReadyGate,
  createFixedIndexQualityProbes,
  DefaultIndexReadyGate,
  DeletionWorkerError,
  SourceWatermarkQualityProbe,
  ObjectStoreDeletionConsumer,
  MarkdownParentChildChunker,
  indexEvaluationSetDigest,
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

test("fixed evaluation probes share one immutable dataset run and score ACL, Recall and Citation", async () => {
  const payload = {
    schema_version: 1,
    evaluation_set_id: "index-eval.worker.unit",
    logical_name: "memory-default",
    thresholds: { acl: 1, recall: 1, citation: 1 },
    cases: [{
      case_id: "index-eval-case.worker.unit",
      stage: "lexical",
      query: "solar daylight",
      purpose: "index_quality_gate",
      principal: { tenant_id: "tenant.worker", user_id: "user.worker" },
      max_results: 5,
      expected_memory_ids: ["memory.worker.allowed"],
      forbidden_memory_ids: ["memory.worker.denied"],
      expected_citations: [{
        memory_id: "memory.worker.allowed",
        artifact_id: "artifact.worker.allowed",
        uri: "s3://unit/allowed.md",
        digest,
        locator: { section_path: "Solar" },
      }],
    }],
  } as const;
  const evaluationSet: IndexEvaluationSet = {
    ...payload,
    artifact_ref: {
      artifact_id: "artifact.index-eval.worker.unit",
      uri: "s3://unit/index-eval.worker.unit.json",
      digest: indexEvaluationSetDigest(payload),
      media_type: "application/vnd.firefly.index-evaluation-set+json",
      scope: "tenant",
      owner_id: "tenant.worker",
      lineage_ids: [],
    },
  };
  let searches = 0;
  const probes = createFixedIndexQualityProbes(evaluationSet, {
    search: async () => {
      searches += 1;
      return [{
        chunk_id: "chunk.worker.allowed",
        memory_id: "memory.worker.allowed",
        score: 0.9,
        citation: {
          artifact_id: "artifact.worker.allowed",
          uri: "s3://unit/allowed.md",
          digest,
          locator: { section_path: "Solar", chunk_level: "child" },
        },
      }];
    },
  });
  const input = { task: indexBuildTask(), documents: [], chunks: [] };
  const checks = await Promise.all(probes.map((probe) => probe.evaluate(input)));

  assert.equal(searches, 1);
  assert.deepEqual(checks.map((check) => check.score), [1, 1, 1]);
  assert.ok(checks.every((check) => check.evidence_refs[0]?.artifact_id === evaluationSet.artifact_ref.artifact_id));
});

test("fixed evaluation probes reject a dataset whose Artifact Digest does not match its payload", () => {
  const evaluationSet = {
    schema_version: 1,
    evaluation_set_id: "index-eval.worker.tampered",
    logical_name: "memory.hybrid",
    thresholds: { acl: 1, recall: 1, citation: 1 },
    cases: [{
      case_id: "index-eval-case.worker.tampered",
      stage: "lexical",
      query: "solar",
      purpose: "index_quality_gate",
      principal: { tenant_id: "tenant.worker" },
      max_results: 5,
      expected_memory_ids: ["memory.worker.allowed"],
      forbidden_memory_ids: ["memory.worker.denied"],
      expected_citations: [{
        memory_id: "memory.worker.allowed",
        artifact_id: "artifact.worker.allowed",
        uri: "s3://unit/allowed.md",
        digest,
      }],
    }],
    artifact_ref: {
      artifact_id: "artifact.index-eval.worker.tampered",
      uri: "s3://unit/index-eval.worker.tampered.json",
      digest,
      media_type: "application/vnd.firefly.index-evaluation-set+json",
      scope: "tenant",
      owner_id: "tenant.worker",
      lineage_ids: [],
    },
  } satisfies IndexEvaluationSet;

  assert.throws(
    () => createFixedIndexQualityProbes(evaluationSet, { search: async () => [] }),
    /Artifact Digest does not match/u,
  );
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
