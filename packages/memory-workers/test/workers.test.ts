import assert from "node:assert/strict";
import test from "node:test";

import type { DeletionPropagationTask, IndexBuildTask, IndexEvaluationSet } from "@firefly/contracts";
import type { PurgedRetrievalIndex } from "@firefly/persistence";
import type { IndexMemoryChunkInput } from "@firefly/retrieval-postgres";

import {
  AdvancedIndexReadyGate,
  createFixedIndexQualityProbes,
  DefaultIndexReadyGate,
  DeletionReconciliationScheduler,
  DeletionWorkerError,
  SourceWatermarkQualityProbe,
  ObjectStoreDeletionConsumer,
  MarkdownParentChildChunker,
  PdfLayoutChunker,
  CodeAstChunker,
  TableStructureChunker,
  ConversationTurnChunker,
  indexEvaluationSetDigest,
  PlainTextParagraphChunker,
  RetiredIndexGarbageCollector,
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

test("PDF layout chunking preserves page, heading and region locators", () => {
  const chunks = new PdfLayoutChunker().chunk({
    memory_id: "memory.worker.pdf",
    content: "parser output",
    source_type: "application/pdf",
    citation: { artifact_id: "artifact.worker.pdf", uri: "s3://unit/source.pdf", digest },
    structured: {
      kind: "pdf-layout",
      pages: [{
        page: 3,
        blocks: [
          { kind: "heading", heading_level: 1, text: "Findings" },
          { kind: "paragraph", text: "The first finding is reproducible.", bbox: [10, 20, 300, 60], region_id: "r-1" },
          { kind: "paragraph", text: "The second finding is independently cited." },
        ],
      }],
    },
  });

  assert.deepEqual(chunks.map((chunk) => chunk.chunk_level), ["parent", "child", "child"]);
  assert.deepEqual(chunks[1]?.structure_path, ["page 3", "Findings"]);
  assert.equal(chunks[1]?.citation.locator?.page, 3);
  assert.equal(chunks[1]?.citation.locator?.region_id, "r-1");
  assert.equal(chunks[1]?.citation.locator?.bbox_width, 300);
  assert.equal(chunks[2]?.parent_ordinal, 0);
});

test("code AST chunking uses symbol and line boundaries", () => {
  const chunks = new CodeAstChunker().chunk({
    memory_id: "memory.worker.code",
    content: "parser output",
    source_type: "text/typescript",
    citation: { artifact_id: "artifact.worker.code", uri: "s3://unit/source.ts", digest },
    structured: {
      kind: "code-ast",
      language: "typescript",
      nodes: [{
        kind: "function", name: "loadUser", signature: "async function loadUser()", text: "return repository.get();",
        start_line: 10, end_line: 14,
        children: [{ kind: "return", text: "return repository.get();", start_line: 13, end_line: 13 }],
      }],
    },
  });

  assert.deepEqual(chunks.map((chunk) => chunk.chunk_level), ["parent", "child"]);
  assert.deepEqual(chunks[1]?.structure_path, ["typescript", "loadUser", "1", "return", "1"]);
  assert.equal(chunks[1]?.citation.locator?.start_line, 13);
  assert.equal(chunks[1]?.parent_ordinal, 0);
});

test("table chunking keeps headers with row groups and coordinates", () => {
  const chunks = new TableStructureChunker({ max_child_characters: 128 }).chunk({
    memory_id: "memory.worker.table",
    content: "parser output",
    source_type: "text/csv",
    citation: { artifact_id: "artifact.worker.table", uri: "s3://unit/data.csv", digest },
    structured: {
      kind: "table",
      sheets: [{ name: "Trips", tables: [{ name: "Countries", headers: ["country", "year"], rows: [["US", "2024"], ["JP", "2025"]] }] }],
    },
  });

  assert.equal(chunks[0]?.chunk_level, "parent");
  assert.equal(chunks[1]?.chunk_level, "child");
  assert.deepEqual(chunks[1]?.structure_path, ["Trips", "Countries"]);
  assert.equal(chunks[1]?.citation.locator?.sheet, "Trips");
  assert.equal(chunks[1]?.citation.locator?.row_start, 0);
  assert.equal(chunks[1]?.parent_ordinal, 0);
});

test("structured chunkers fail closed when parser output is absent", () => {
  const document = {
    memory_id: "memory.worker.unparsed",
    content: "plain text",
    source_type: "application/pdf",
    citation: { artifact_id: "artifact.worker.unparsed", uri: "s3://unit/source.pdf", digest },
  };
  assert.throws(() => new PdfLayoutChunker().chunk(document), /parser output/);
  assert.throws(() => new CodeAstChunker().chunk(document), /parser output/);
  assert.throws(() => new TableStructureChunker().chunk(document), /parser output/);
});

test("structured chunkers support an explicit degraded text fallback", () => {
  const document = {
    memory_id: "memory.worker.degraded",
    content: "first paragraph\n\nsecond paragraph",
    source_type: "application/pdf",
    citation: { artifact_id: "artifact.worker.degraded", uri: "s3://unit/source.bin", digest },
  };
  const chunks = new PdfLayoutChunker({ fallback_mode: "degraded" }).chunk(document);

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]?.citation.locator?.parser_mode, "degraded");
  assert.equal(chunks[0]?.citation.locator?.expected_structure, "pdf-layout");
  assert.equal(chunks[0]?.citation.locator?.degradation, "parser-unavailable");
  assert.deepEqual(chunks[0]?.structure_path, []);
});

test("conversation chunking preserves turn order, speaker identity and time locators", () => {
  const chunks = new ConversationTurnChunker({ max_child_characters: 128, max_parent_characters: 180 }).chunk({
    memory_id: "memory.worker.conversation",
    content: "parser output",
    source_type: "conversation",
    citation: { artifact_id: "artifact.worker.conversation", uri: "s3://unit/session.json", digest },
    structured: {
      kind: "conversation",
      turns: [
        { turn_id: "turn-2", sequence: 2, speaker_id: "assistant", role: "assistant", content: "The result is ready.", started_at: "2026-08-11T10:01:00Z" },
        { turn_id: "turn-1", sequence: 1, speaker_id: "user", role: "user", content: "Please check the result.", started_at: "2026-08-11T10:00:00Z", ended_at: "2026-08-11T10:00:10Z" },
      ],
    },
  });

  assert.deepEqual(chunks.map((chunk) => chunk.chunk_level), ["parent", "child", "child"]);
  assert.match(chunks[1]?.content ?? "", /^\[user\/user #1\]/u);
  assert.equal(chunks[1]?.citation.locator?.turn_id, "turn-1");
  assert.equal(chunks[1]?.citation.locator?.started_at, "2026-08-11T10:00:00Z");
  assert.equal(chunks[1]?.parent_ordinal, 0);
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

test("deletion reconciliation coalesces concurrent cycles and exposes a stable snapshot", async () => {
  let calls = 0;
  let resolveRequeue!: (value: number) => void;
  const pending = new Promise<number>((resolve) => {
    resolveRequeue = resolve;
  });
  const observed: string[] = [];
  const scheduler = new DeletionReconciliationScheduler({
    scheduler_id: "scheduler.worker.unit",
    instance_id: "scheduler.worker.unit.instance-a",
    memories: {
      reconcileFailedDeletionTargets: async (input) => {
        calls += 1;
        assert.equal(input.stale_before.toISOString(), "2026-08-10T11:55:00.000Z");
        assert.equal(input.limit, 25);
        return pending;
      },
    },
    stale_after_ms: 300_000,
    batch_limit: 25,
    now: () => new Date("2026-08-10T12:00:00.000Z"),
    observe: (cycle) => observed.push(cycle.cycle_id),
  });

  const first = scheduler.runOnce();
  const second = scheduler.runOnce();
  assert.strictEqual(first, second);
  assert.equal(calls, 1);
  assert.equal(scheduler.snapshot().running, true);
  resolveRequeue(3);
  const cycle = await first;

  assert.equal(cycle.status, "completed");
  assert.equal(cycle.requeued_count, 3);
  await Promise.resolve();
  assert.equal(scheduler.snapshot().running, false);
  assert.equal(scheduler.snapshot().last_cycle?.cycle_id, cycle.cycle_id);
  assert.deepEqual(observed, [cycle.cycle_id]);
});

test("deletion reconciliation records failures and stops its loop on cancellation", async () => {
  const controller = new AbortController();
  let calls = 0;
  const scheduler = new DeletionReconciliationScheduler({
    scheduler_id: "scheduler.worker.failure",
    instance_id: "scheduler.worker.failure.instance-a",
    memories: {
      reconcileFailedDeletionTargets: async () => {
        calls += 1;
        throw new Error("database unavailable");
      },
    },
    interval_ms: 100,
    now: () => new Date("2026-08-10T12:00:00.000Z"),
    wait: async (_milliseconds, signal) => {
      controller.abort();
      const error = new Error("aborted");
      error.name = "AbortError";
      assert.equal(signal.aborted, true);
      throw error;
    },
    observe: () => {
      throw new Error("metrics unavailable");
    },
  });

  await scheduler.run(controller.signal);

  assert.equal(calls, 1);
  assert.equal(scheduler.snapshot().running, false);
  assert.equal(scheduler.snapshot().observer_failures, 1);
  assert.equal(scheduler.snapshot().last_cycle?.status, "failed");
  assert.match(scheduler.snapshot().last_cycle?.error?.message ?? "", /database unavailable/u);
});

test("retired-index garbage collection coalesces cycles and reports bounded purge totals", async () => {
  let calls = 0;
  let resolvePurge!: (value: readonly PurgedRetrievalIndex[]) => void;
  const pending = new Promise<readonly PurgedRetrievalIndex[]>((resolve) => {
    resolvePurge = resolve;
  });
  const collector = new RetiredIndexGarbageCollector({
    collector_id: "index-gc.worker.unit",
    instance_id: "index-gc.worker.unit.instance-a",
    indexes: {
      purgeRetiredIndexes: async (input) => {
        calls += 1;
        assert.equal(input.retired_before.toISOString(), "2026-08-03T12:00:00.000Z");
        assert.equal(input.limit, 25);
        return pending;
      },
    },
    retention_ms: 604_800_000,
    batch_limit: 25,
    now: () => new Date("2026-08-10T12:00:00.000Z"),
  });

  const first = collector.runOnce();
  const second = collector.runOnce();
  assert.strictEqual(first, second);
  assert.equal(calls, 1);
  resolvePurge([{
    index_version_id: "index.worker.retired",
    tenant_id: "tenant.worker",
    logical_name: "memory.hybrid",
    deleted_chunk_count: 7,
    retired_at: "2026-08-01T12:00:00.000Z",
    purged_at: "2026-08-10T12:00:00.000Z",
  }]);
  const cycle = await first;

  assert.equal(cycle.status, "completed");
  assert.equal(cycle.purged_index_count, 1);
  assert.equal(cycle.deleted_chunk_count, 7);
  assert.deepEqual(cycle.purged_index_ids, ["index.worker.retired"]);
  await Promise.resolve();
  assert.equal(collector.snapshot().running, false);
});

test("retired-index garbage collection records a failed cycle and honors cancellation", async () => {
  const controller = new AbortController();
  let calls = 0;
  const collector = new RetiredIndexGarbageCollector({
    collector_id: "index-gc.worker.failure",
    instance_id: "index-gc.worker.failure.instance-a",
    indexes: {
      purgeRetiredIndexes: async () => {
        calls += 1;
        throw new Error("database unavailable");
      },
    },
    interval_ms: 100,
    wait: async (_milliseconds, signal) => {
      controller.abort();
      const error = new Error("aborted");
      error.name = "AbortError";
      assert.equal(signal.aborted, true);
      throw error;
    },
  });

  await collector.run(controller.signal);

  assert.equal(calls, 1);
  assert.equal(collector.snapshot().last_cycle?.status, "failed");
  assert.match(collector.snapshot().last_cycle?.error?.message ?? "", /database unavailable/u);
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
