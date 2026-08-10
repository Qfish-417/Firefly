import { createHash } from "node:crypto";

import {
  assertContract,
  type EvidenceCitation,
  type IndexBuildResult,
  type IndexBuildTask,
} from "@firefly/contracts";
import type { EmbeddingPort, ModelBudget } from "@firefly/model-gateway";
import type {
  OutboxEventRecord,
  OutboxRepository,
  RetrievalIndexRepository,
  RetrievalIndexVersion,
} from "@firefly/persistence";
import type { IndexMemoryChunkInput, PostgresMemoryIndexer } from "@firefly/retrieval-postgres";

export interface IndexSourceDocument {
  readonly memory_id: string;
  readonly content: string;
  readonly source_type: string;
  readonly entity_keys?: readonly string[];
  readonly citation: EvidenceCitation;
}

export interface IndexSourcePort {
  load(task: IndexBuildTask): Promise<readonly IndexSourceDocument[]>;
}

export interface IndexChunkDraft {
  readonly memory_id: string;
  readonly ordinal: number;
  readonly content: string;
  readonly source_type: string;
  readonly entity_keys: readonly string[];
  readonly citation: EvidenceCitation;
  readonly token_count: number;
}

export interface IndexChunkerPort {
  chunk(document: IndexSourceDocument): readonly IndexChunkDraft[];
}

export interface IndexReadyGateResult {
  readonly passed: boolean;
  readonly reasons: readonly string[];
}

export interface IndexReadyGatePort {
  evaluate(input: {
    readonly task: IndexBuildTask;
    readonly documents: readonly IndexSourceDocument[];
    readonly chunks: readonly IndexMemoryChunkInput[];
  }): Promise<IndexReadyGateResult> | IndexReadyGateResult;
}

export interface WorkerBatchResult {
  readonly claimed: number;
  readonly completed: number;
  readonly failed: number;
  readonly released: number;
}

export interface IndexBuildWorkerOptions {
  readonly worker_id: string;
  readonly outbox: Pick<OutboxRepository, "claimBatchByTypes" | "markPublished" | "markDiscarded" | "releaseWithError">;
  readonly indexes: Pick<RetrievalIndexRepository, "getById" | "completeBuild" | "activate">;
  readonly indexer: Pick<PostgresMemoryIndexer, "index">;
  readonly source: IndexSourcePort;
  readonly chunker?: IndexChunkerPort;
  readonly embeddings?: EmbeddingPort;
  readonly embedding_budget?: ModelBudget;
  readonly ready_gate?: IndexReadyGatePort;
  readonly auto_activate: boolean;
  readonly batch_size?: number;
  readonly lease_duration_ms?: number;
  readonly max_attempts?: number;
  readonly initial_backoff_ms?: number;
  readonly max_backoff_ms?: number;
  readonly now?: () => Date;
}

export class RetrievalIndexBuildWorker {
  private readonly options: IndexBuildWorkerOptions;
  private readonly chunker: IndexChunkerPort;
  private readonly readyGate: IndexReadyGatePort;

  constructor(options: IndexBuildWorkerOptions) {
    this.options = options;
    this.chunker = options.chunker ?? new PlainTextParagraphChunker();
    this.readyGate = options.ready_gate ?? new DefaultIndexReadyGate();
  }

  async runBatch(): Promise<WorkerBatchResult> {
    const now = this.options.now?.() ?? new Date();
    const events = await this.options.outbox.claimBatchByTypes(
      this.options.worker_id,
      ["RetrievalIndexBuildRequested"],
      this.options.batch_size ?? 10,
      this.options.lease_duration_ms ?? 30_000,
      now,
    );
    let completed = 0;
    let failed = 0;
    let released = 0;
    for (const event of events) {
      let task: IndexBuildTask | undefined;
      try {
        task = parseIndexBuildTask(event.payload);
        const outcome = await this.process(task);
        await this.options.outbox.markPublished(event.event_id, this.options.worker_id, this.now());
        if (outcome === "failed") failed += 1;
        else completed += 1;
      } catch (error) {
        const retryable = !(error instanceof IndexBuildWorkerError) || error.retryable;
        if (retryable && event.attempts < (this.options.max_attempts ?? 3)) {
          await this.options.outbox.releaseWithError(
            event.event_id,
            this.options.worker_id,
            errorMessage(error),
            new Date(this.now().getTime() + retryDelay(event.attempts, this.options)),
          );
          released += 1;
          continue;
        }
        if (task) await this.failBuildingVersion(task, error, retryable);
        await this.options.outbox.markDiscarded(
          event.event_id,
          this.options.worker_id,
          errorMessage(error),
          this.now(),
        );
        failed += 1;
      }
    }
    return { claimed: events.length, completed, failed, released };
  }

  private async process(task: IndexBuildTask): Promise<"completed" | "failed"> {
    const version = await this.options.indexes.getById(task.index_version_id);
    if (!version) throw new IndexBuildWorkerError("INDEX_VERSION_MISSING", "Index version does not exist", false);
    if (version.status === "failed") return "failed";
    if (version.status === "active" || version.status === "retired") return "completed";
    if (version.status === "ready") {
      if (this.options.auto_activate) await this.options.indexes.activate(task.index_version_id, this.now());
      return "completed";
    }

    const documents = await this.options.source.load(task);
    validateDocuments(documents);
    const drafts = documents.flatMap((document) => this.chunker.chunk(document));
    const vectors = await this.embed(task, drafts);
    const chunks = drafts.map((draft, index) => toIndexChunk(task, draft, vectors?.[index]));
    for (const chunk of chunks) await this.options.indexer.index(chunk);

    const gate = await this.readyGate.evaluate({ task, documents, chunks });
    if (!gate.passed) {
      await this.complete(task, "failed", documents.length, chunks.length, {
        code: "READY_GATE_FAILED",
        message: gate.reasons.join("; ").slice(0, 2_048) || "Index Ready Gate rejected the build",
        retryable: false,
      });
      return "failed";
    }
    await this.complete(task, "ready", documents.length, chunks.length);
    if (this.options.auto_activate) await this.options.indexes.activate(task.index_version_id, this.now());
    return "completed";
  }

  private async embed(
    task: IndexBuildTask,
    chunks: readonly IndexChunkDraft[],
  ): Promise<readonly (readonly number[])[] | undefined> {
    if (!task.embedding_model) return undefined;
    if (!this.options.embeddings || !this.options.embedding_budget) {
      throw new IndexBuildWorkerError(
        "EMBEDDING_PROVIDER_MISSING",
        "An embedding provider and budget are required for this index build",
        false,
      );
    }
    if (chunks.length === 0) return [];
    const result = await this.options.embeddings.embed({
      request_id: `${task.build_id}:documents`,
      workload: "retrieval.index.embed",
      inputs: chunks.map((chunk) => chunk.content),
      budget: this.options.embedding_budget,
    });
    if (result.vectors.length !== chunks.length) {
      throw new IndexBuildWorkerError("EMBEDDING_COUNT_MISMATCH", "Embedding count differs from Chunk count", false);
    }
    for (const vector of result.vectors) {
      if (vector.length !== task.embedding_dimensions) {
        throw new IndexBuildWorkerError("EMBEDDING_SHAPE_MISMATCH", "Embedding dimensions differ from build snapshot", false);
      }
    }
    return result.vectors;
  }

  private async complete(
    task: IndexBuildTask,
    status: IndexBuildResult["status"],
    documentCount: number,
    chunkCount: number,
    error?: IndexBuildResult["error"],
  ): Promise<RetrievalIndexVersion> {
    return this.options.indexes.completeBuild({
      schema_version: 1,
      build_id: task.build_id,
      index_version_id: task.index_version_id,
      status,
      document_count: documentCount,
      chunk_count: chunkCount,
      source_watermark: task.source_watermark,
      completed_at: this.now().toISOString(),
      ...(error ? { error } : {}),
    });
  }

  private async failBuildingVersion(task: IndexBuildTask, error: unknown, retryable: boolean): Promise<void> {
    const version = await this.options.indexes.getById(task.index_version_id);
    if (!version || version.status !== "building") return;
    await this.complete(task, "failed", version.document_count, version.chunk_count, {
      code: error instanceof IndexBuildWorkerError ? error.code : "INDEX_BUILD_FAILED",
      message: errorMessage(error).slice(0, 2_048),
      retryable,
    });
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

export class IndexBuildWorkerError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "IndexBuildWorkerError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class PlainTextParagraphChunker implements IndexChunkerPort {
  private readonly maxCharacters: number;

  constructor(maxCharacters = 1_200) {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 128) {
      throw new TypeError("Chunk maximum must be an integer of at least 128 characters");
    }
    this.maxCharacters = maxCharacters;
  }

  chunk(document: IndexSourceDocument): readonly IndexChunkDraft[] {
    const blocks = document.content
      .split(/\r?\n\s*\r?\n/u)
      .flatMap((block) => splitLongBlock(block.trim(), this.maxCharacters))
      .filter(Boolean);
    return blocks.map((content, ordinal) => ({
      memory_id: document.memory_id,
      ordinal,
      content,
      source_type: document.source_type,
      entity_keys: document.entity_keys ?? [],
      citation: document.citation,
      token_count: Math.max(1, Math.ceil(content.length / 4)),
    }));
  }
}

export class DefaultIndexReadyGate implements IndexReadyGatePort {
  evaluate(input: {
    readonly task: IndexBuildTask;
    readonly documents: readonly IndexSourceDocument[];
    readonly chunks: readonly IndexMemoryChunkInput[];
  }): IndexReadyGateResult {
    const reasons: string[] = [];
    if (input.documents.length === 0) reasons.push("no source documents were loaded");
    const chunkedMemoryIds = new Set(input.chunks.map((chunk) => chunk.memory_id));
    if (input.documents.some((document) => !chunkedMemoryIds.has(document.memory_id))) {
      reasons.push("one or more documents produced no Chunk");
    }
    if (new Set(input.chunks.map((chunk) => chunk.chunk_id)).size !== input.chunks.length) {
      reasons.push("Chunk identities are not unique");
    }
    if (input.task.embedding_dimensions !== undefined) {
      if (input.chunks.some((chunk) => chunk.embedding?.length !== input.task.embedding_dimensions)) {
        reasons.push("one or more Chunk embeddings violate the build dimensions");
      }
    }
    return { passed: reasons.length === 0, reasons };
  }
}

function parseIndexBuildTask(value: unknown): IndexBuildTask {
  assertContract("IndexBuildTask", value);
  return value as IndexBuildTask;
}

function validateDocuments(documents: readonly IndexSourceDocument[]): void {
  if (new Set(documents.map((document) => document.memory_id)).size !== documents.length) {
    throw new IndexBuildWorkerError("DUPLICATE_SOURCE", "A build source returned the same Memory more than once", false);
  }
  for (const document of documents) {
    if (!document.memory_id || !document.content.trim() || !document.source_type) {
      throw new IndexBuildWorkerError("INVALID_SOURCE", "Index source documents require identity, content and type", false);
    }
    assertContract("EvidenceCitation", document.citation);
  }
}

function toIndexChunk(
  task: IndexBuildTask,
  draft: IndexChunkDraft,
  embedding: readonly number[] | undefined,
): IndexMemoryChunkInput {
  const digest = contentDigest(draft.content);
  const identity = createHash("sha256")
    .update(`${task.index_version_id}\n${draft.memory_id}\n${draft.ordinal}\n${digest}`, "utf8")
    .digest("hex");
  return {
    chunk_id: `chunk.${identity}`,
    memory_id: draft.memory_id,
    index_version_id: task.index_version_id,
    ordinal: draft.ordinal,
    content: draft.content,
    chunk_digest: digest,
    token_count: draft.token_count,
    source_type: draft.source_type,
    entity_keys: draft.entity_keys,
    citation: draft.citation,
    ...(embedding ? { embedding, embedding_model: task.embedding_model! } : {}),
  };
}

function splitLongBlock(block: string, maxCharacters: number): readonly string[] {
  if (!block || block.length <= maxCharacters) return block ? [block] : [];
  const chunks: string[] = [];
  for (let offset = 0; offset < block.length; offset += maxCharacters) {
    chunks.push(block.slice(offset, offset + maxCharacters).trim());
  }
  return chunks.filter(Boolean);
}

function contentDigest(content: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function retryDelay(attempt: number, options: IndexBuildWorkerOptions): number {
  const initial = options.initial_backoff_ms ?? 1_000;
  const maximum = options.max_backoff_ms ?? 60_000;
  return Math.min(maximum, initial * 2 ** Math.max(0, attempt - 1));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
