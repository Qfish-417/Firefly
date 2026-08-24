import { mapWithConcurrency } from "./bounded-concurrency.ts";
import { createHash } from "node:crypto";

import {
  assertContract,
  type EvidenceCitation,
  type IndexBuildResult,
  type IndexBuildTask,
  type IndexQualityCheck,
  type IndexQualityCheckName,
  type IndexQualityReport,
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
  /** Optional immutable binary source bytes, hydrated and digest-verified before parser execution. */
  readonly content_bytes?: Uint8Array;
  readonly source_type: string;
  readonly entity_keys?: readonly string[];
  readonly citation: EvidenceCitation;
  /** Optional parser output. Structured chunkers never infer structure from characters. */
  readonly structured?: IndexStructuredSource;
  readonly parser_diagnostic?: IndexParserDiagnostic;
}

export type IndexStructuredSource = IndexPdfLayoutSource | IndexCodeAstSource | IndexTableSource | IndexConversationSource;

export interface IndexPdfLayoutSource {
  readonly kind: "pdf-layout";
  readonly pages: readonly IndexPdfPage[];
  readonly extraction?: IndexPdfExtraction;
}

export interface IndexPdfExtraction {
  readonly method: "native" | "ocr";
  readonly provider_id: string;
  readonly model_id?: string;
  readonly model_version?: string;
}

export interface IndexPdfPage {
  readonly page: number;
  readonly blocks: readonly IndexPdfLayoutBlock[];
  readonly width?: number;
  readonly height?: number;
  readonly coordinate_unit?: "point" | "pixel" | "normalized";
}

export interface IndexPdfLayoutBlock {
  readonly kind: "heading" | "paragraph" | "list" | "table" | "figure" | "caption";
  readonly text: string;
  readonly bbox?: readonly [number, number, number, number];
  readonly heading_level?: number;
  readonly region_id?: string;
  readonly confidence?: number;
  readonly language?: string;
}

export interface IndexCodeAstSource {
  readonly kind: "code-ast";
  readonly language: string;
  readonly nodes: readonly IndexCodeAstNode[];
}

export interface IndexCodeAstNode {
  readonly kind: string;
  readonly name?: string;
  readonly signature?: string;
  readonly text: string;
  readonly start_line: number;
  readonly end_line: number;
  readonly children?: readonly IndexCodeAstNode[];
}

export interface IndexTableSource {
  readonly kind: "table";
  readonly sheets: readonly IndexTableSheet[];
}

export interface IndexTableSheet {
  readonly name: string;
  readonly tables: readonly IndexTable[];
}

export interface IndexTable {
  readonly name: string;
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export interface IndexConversationSource {
  readonly kind: "conversation";
  readonly turns: readonly IndexConversationTurn[];
  readonly duration_ms?: number;
  readonly language?: string;
  readonly extraction?: IndexConversationExtraction;
}

export interface IndexConversationExtraction {
  readonly method: "asr";
  readonly provider_id: string;
  readonly model_id?: string;
  readonly model_version?: string;
  readonly diarization: boolean;
}

export interface IndexConversationTurn {
  readonly turn_id: string;
  readonly sequence: number;
  readonly speaker_id: string;
  readonly role?: "user" | "assistant" | "system" | "tool";
  readonly content: string;
  readonly started_at?: string;
  readonly ended_at?: string;
  readonly start_ms?: number;
  readonly end_ms?: number;
  readonly confidence?: number;
  readonly language?: string;
}

export type StructuredChunkerFallbackMode = "strict" | "degraded";

export interface StructuredChunkerOptions {
  readonly max_child_characters?: number;
  readonly max_parent_characters?: number;
  /** Strict by default. Degraded mode is an explicit plain-text fallback. */
  readonly fallback_mode?: StructuredChunkerFallbackMode;
}

export interface IndexSourcePort {
  load(task: IndexBuildTask): Promise<readonly IndexSourceDocument[]>;
}

export type IndexParserFailureMode = "strict" | "degraded";

export interface IndexParserDiagnostic {
  readonly parser_id?: string;
  readonly code: "parser-missing" | "parser-failed" | "parser-invalid-output";
}

export interface IndexSourceParserPort {
  readonly parser_id: string;
  supports(source_type: string): boolean;
  parse(document: IndexSourceDocument): Promise<IndexStructuredSource> | IndexStructuredSource;
}

export interface ParsedIndexSourcePortOptions {
  readonly parsers: readonly IndexSourceParserPort[];
  readonly parser_failure_mode?: IndexParserFailureMode;
  /** Documents parsed at once. Defaults to 4. */
  readonly max_concurrency?: number;
}

export interface IndexChunkDraft {
  readonly memory_id: string;
  readonly ordinal: number;
  readonly chunk_level?: "parent" | "child";
  readonly parent_ordinal?: number;
  readonly structure_path?: readonly string[];
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
  readonly checks: readonly IndexQualityCheck[];
}

export interface IndexReadyGateInput {
  readonly task: IndexBuildTask;
  readonly documents: readonly IndexSourceDocument[];
  readonly chunks: readonly IndexMemoryChunkInput[];
}

export interface IndexReadyGatePort {
  evaluate(input: IndexReadyGateInput): Promise<IndexReadyGateResult> | IndexReadyGateResult;
}

export type AdvancedIndexQualityCheckName = Exclude<IndexQualityCheckName, "structure">;

export interface IndexQualityProbe {
  readonly name: AdvancedIndexQualityCheckName;
  evaluate(input: IndexReadyGateInput): Promise<Omit<IndexQualityCheck, "name">> |
    Omit<IndexQualityCheck, "name">;
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
  /** Degraded parser output must be explicitly allowed for build and activation separately. */
  readonly allow_degraded_build?: boolean;
  readonly allow_degraded_activation?: boolean;
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
    if (options.auto_activate && !options.ready_gate) {
      throw new TypeError("Automatic index activation requires an explicitly configured governed Ready Gate");
    }
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
    validateDrafts(drafts);
    assertDegradedIndexPolicy(drafts, {
      auto_activate: this.options.auto_activate,
      allow_degraded_build: this.options.allow_degraded_build ?? false,
      allow_degraded_activation: this.options.allow_degraded_activation ?? false,
    });
    const retrievalDrafts = drafts.filter((draft) => (draft.chunk_level ?? "child") === "child");
    const vectors = await this.embed(task, retrievalDrafts);
    const vectorByDraft = new Map(retrievalDrafts.map((draft, index) => [draftKey(draft), vectors?.[index]]));
    const identityByDraft = new Map(drafts.map((draft) => [draftKey(draft), chunkIdentity(task, draft)]));
    const chunks = drafts.map((draft) => toIndexChunk(
      task,
      draft,
      identityByDraft,
      vectorByDraft.get(draftKey(draft)),
    ));
    for (const chunk of chunks) await this.options.indexer.index(chunk);

    const gate = await this.readyGate.evaluate({ task, documents, chunks });
    const evaluatedAt = this.now();
    const qualityReport = toQualityReport(task, gate, evaluatedAt);
    if (!gate.passed) {
      await this.complete(task, "failed", documents.length, chunks.length, {
        quality_report: qualityReport,
        completed_at: evaluatedAt,
        error: {
          code: "READY_GATE_FAILED",
          message: gate.reasons.join("; ").slice(0, 2_048) || "Index Ready Gate rejected the build",
          retryable: false,
        },
      });
      return "failed";
    }
    await this.complete(task, "ready", documents.length, chunks.length, {
      quality_report: qualityReport,
      completed_at: evaluatedAt,
    });
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
    outcome: {
      readonly error?: IndexBuildResult["error"];
      readonly quality_report?: IndexQualityReport;
      readonly completed_at?: Date;
    } = {},
  ): Promise<RetrievalIndexVersion> {
    return this.options.indexes.completeBuild({
      schema_version: 1,
      build_id: task.build_id,
      index_version_id: task.index_version_id,
      status,
      document_count: documentCount,
      chunk_count: chunkCount,
      source_watermark: task.source_watermark,
      completed_at: (outcome.completed_at ?? this.now()).toISOString(),
      ...(outcome.quality_report ? { quality_report: outcome.quality_report } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
    });
  }

  private async failBuildingVersion(task: IndexBuildTask, error: unknown, retryable: boolean): Promise<void> {
    const version = await this.options.indexes.getById(task.index_version_id);
    if (!version || version.status !== "building") return;
    await this.complete(task, "failed", version.document_count, version.chunk_count, {
      error: {
        code: error instanceof IndexBuildWorkerError ? error.code : "INDEX_BUILD_FAILED",
        message: errorMessage(error).slice(0, 2_048),
        retryable,
      },
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

export class ParserBackedIndexSourcePort implements IndexSourcePort {
  private readonly source: IndexSourcePort;
  private readonly parsers: readonly IndexSourceParserPort[];
  private readonly failureMode: IndexParserFailureMode;
  private readonly maxConcurrency: number;

  constructor(source: IndexSourcePort, options: ParsedIndexSourcePortOptions) {
    if (options.parsers.length === 0) throw new TypeError("At least one source parser is required");
    const parserIds = options.parsers.map((parser) => parser.parser_id.trim());
    if (parserIds.some((id) => !id) || new Set(parserIds).size !== parserIds.length) {
      throw new TypeError("Source parser IDs must be non-empty and unique");
    }
    this.source = source;
    this.parsers = options.parsers;
    this.failureMode = options.parser_failure_mode ?? "strict";
    this.maxConcurrency = options.max_concurrency ?? 4;
    if (!Number.isInteger(this.maxConcurrency) || this.maxConcurrency < 1 || this.maxConcurrency > 64) {
      throw new TypeError("Parser concurrency must be between 1 and 64");
    }
  }

  async load(task: IndexBuildTask): Promise<readonly IndexSourceDocument[]> {
    const documents = await this.source.load(task);
    // Parsers may call out to OCR/ASR services and hold whole documents in memory, so the fan-out
    // is capped rather than starting one task per document.
    return mapWithConcurrency(documents, this.maxConcurrency, (document) => this.parseDocument(document));
  }

  private async parseDocument(document: IndexSourceDocument): Promise<IndexSourceDocument> {
    const parser = this.parsers.find((candidate) => candidate.supports(document.source_type));
    if (!parser) return this.handleFailure(document, { code: "parser-missing" });
    try {
      const structured = await parser.parse(document);
      if (!structured || !isStructuredSource(structured)) {
        return this.handleFailure(document, { parser_id: parser.parser_id, code: "parser-invalid-output" });
      }
      const { parser_diagnostic: _diagnostic, ...withoutDiagnostic } = document;
      return { ...withoutDiagnostic, structured };
    } catch {
      return this.handleFailure(document, { parser_id: parser.parser_id, code: "parser-failed" });
    }
  }

  private handleFailure(document: IndexSourceDocument, diagnostic: IndexParserDiagnostic): IndexSourceDocument {
    if (this.failureMode === "strict") {
      throw new IndexBuildWorkerError(
        diagnostic.code === "parser-missing" ? "SOURCE_PARSER_MISSING" : "SOURCE_PARSER_FAILED",
        `${diagnostic.code}${diagnostic.parser_id ? `: ${diagnostic.parser_id}` : ""}`,
        false,
      );
    }
    return { ...document, parser_diagnostic: diagnostic };
  }
}

function isStructuredSource(value: unknown): value is IndexStructuredSource {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { readonly kind?: unknown }).kind;
  return kind === "pdf-layout" || kind === "code-ast" || kind === "table" || kind === "conversation";
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
      chunk_level: "child",
      structure_path: [],
      content,
      source_type: document.source_type,
      entity_keys: document.entity_keys ?? [],
      citation: document.citation,
      token_count: Math.max(1, Math.ceil(content.length / 4)),
    }));
  }
}

interface MarkdownSection {
  readonly path: readonly string[];
  readonly heading?: string;
  readonly blocks: readonly string[];
}

export class MarkdownParentChildChunker implements IndexChunkerPort {
  private readonly maxChildCharacters: number;
  private readonly maxParentCharacters: number;

  constructor(options: { readonly max_child_characters?: number; readonly max_parent_characters?: number } = {}) {
    this.maxChildCharacters = options.max_child_characters ?? 1_200;
    this.maxParentCharacters = options.max_parent_characters ?? 4_800;
    if (!Number.isInteger(this.maxChildCharacters) || this.maxChildCharacters < 128) {
      throw new TypeError("Child Chunk maximum must be an integer of at least 128 characters");
    }
    if (!Number.isInteger(this.maxParentCharacters) || this.maxParentCharacters < this.maxChildCharacters) {
      throw new TypeError("Parent Chunk maximum must be an integer no smaller than the Child maximum");
    }
  }

  chunk(document: IndexSourceDocument): readonly IndexChunkDraft[] {
    const drafts: IndexChunkDraft[] = [];
    let ordinal = 0;
    for (const section of parseMarkdownSections(document.content)) {
      const prefix = section.heading && section.heading.length < this.maxParentCharacters
        ? `${section.heading}\n\n`
        : "";
      const capacity = Math.max(1, this.maxParentCharacters - prefix.length);
      const parentGroups = groupBlocks(section.blocks, capacity);
      for (let parentPart = 0; parentPart < parentGroups.length; parentPart += 1) {
        const blocks = parentGroups[parentPart]!;
        const parentOrdinal = ordinal++;
        const path = section.path.length > 0 ? section.path : ["document"];
        drafts.push({
          memory_id: document.memory_id,
          ordinal: parentOrdinal,
          chunk_level: "parent",
          structure_path: path,
          content: `${prefix}${blocks.join("\n\n")}`.trim(),
          source_type: document.source_type,
          entity_keys: document.entity_keys ?? [],
          citation: withStructureLocator(document.citation, path, "parent", parentPart),
          token_count: Math.max(1, Math.ceil(`${prefix}${blocks.join("\n\n")}`.trim().length / 4)),
        });
        const pathLabel = path[0] === "document" ? "" : path.join(" > ");
        const childPrefix = pathLabel.length + 2 < Math.floor(this.maxChildCharacters / 2)
          ? `${pathLabel}\n\n`
          : "";
        const childCapacity = Math.max(1, this.maxChildCharacters - childPrefix.length);
        const childBlocks = blocks.flatMap((block) => splitLongBlock(block, childCapacity));
        for (let childPart = 0; childPart < childBlocks.length; childPart += 1) {
          const content = `${childPrefix}${childBlocks[childPart]!}`.trim();
          drafts.push({
            memory_id: document.memory_id,
            ordinal: ordinal++,
            chunk_level: "child",
            parent_ordinal: parentOrdinal,
            structure_path: path,
            content,
            source_type: document.source_type,
            entity_keys: document.entity_keys ?? [],
            citation: withStructureLocator(document.citation, path, "child", parentPart, childPart),
            token_count: Math.max(1, Math.ceil(content.length / 4)),
          });
        }
      }
    }
    return drafts;
  }
}

export class PdfLayoutChunker implements IndexChunkerPort {
  private readonly maxChildCharacters: number;
  private readonly maxParentCharacters: number;
  private readonly fallbackMode: StructuredChunkerFallbackMode;

  constructor(options: StructuredChunkerOptions = {}) {
    this.maxChildCharacters = options.max_child_characters ?? 1_200;
    this.maxParentCharacters = options.max_parent_characters ?? 4_800;
    this.fallbackMode = options.fallback_mode ?? "strict";
    validateChunkLimits(this.maxChildCharacters, this.maxParentCharacters, "PDF");
  }

  chunk(document: IndexSourceDocument): readonly IndexChunkDraft[] {
    const source = structuredSourceOrFallback(document, "pdf-layout", this.fallbackMode);
    if (!source) return degradedTextChunks(document, "pdf-layout", this.maxChildCharacters);
    const drafts: IndexChunkDraft[] = [];
    let ordinal = 0;
    for (const page of source.pages) {
      if (!Number.isInteger(page.page) || page.page < 1) {
        throw new IndexBuildWorkerError("INVALID_PDF_PAGE", "PDF pages must use positive integer numbers", false);
      }
      const blocks = page.blocks.filter((block) => block.text.trim());
      if (blocks.length === 0) continue;
      const headings: string[] = [];
      let sectionBlocks: PdfBlockWithPath[] = [];
      const flush = () => {
        if (sectionBlocks.length === 0) return;
        const path = ["page " + page.page, ...headings];
        const parentGroups = groupLayoutBlocks(sectionBlocks, this.maxParentCharacters);
        for (const group of parentGroups) {
          const parentOrdinal = ordinal++;
          const parentContent = group.map((block) => block.text).join("\n\n").trim();
          drafts.push(this.pdfDraft(document, parentOrdinal, "parent", path, parentContent, page, source.extraction, group[0]));
          const childBlocks = group.flatMap((block) => splitLongBlock(block.text, this.maxChildCharacters));
          for (const [childPart, childText] of childBlocks.entries()) {
            const content = `${path.join(" > ")}\n\n${childText}`.trim();
            drafts.push(this.pdfDraft(document, ordinal++, "child", path, content, page, source.extraction,
              group[Math.min(childPart, group.length - 1)], parentOrdinal, childPart));
          }
        }
        sectionBlocks = [];
      };
      for (const block of blocks) {
        if (block.kind === "heading") {
          flush();
          const level = Math.max(1, Math.min(6, block.heading_level ?? 1));
          headings.length = level - 1;
          headings[level - 1] = block.text.trim();
          continue;
        }
        sectionBlocks.push({
          text: block.text.trim(),
          ...(block.bbox ? { bbox: block.bbox } : {}),
          ...(block.region_id ? { region_id: block.region_id } : {}),
          ...(block.confidence === undefined ? {} : { confidence: block.confidence }),
          ...(block.language ? { language: block.language } : {}),
        });
      }
      flush();
    }
    return drafts;
  }

  private pdfDraft(
    document: IndexSourceDocument,
    ordinal: number,
    level: "parent" | "child",
    path: readonly string[],
    content: string,
    page: IndexPdfPage,
    extraction: IndexPdfExtraction | undefined,
    block: PdfBlockWithPath | undefined,
    parentOrdinal?: number,
    chunkPart?: number,
  ): IndexChunkDraft {
    return {
      memory_id: document.memory_id,
      ordinal,
      chunk_level: level,
      ...(parentOrdinal === undefined ? {} : { parent_ordinal: parentOrdinal }),
      structure_path: path,
      content,
      source_type: document.source_type,
      entity_keys: document.entity_keys ?? [],
      citation: withStructureLocator(document.citation, path, level, page.page, chunkPart, {
        page: page.page,
        ...(page.width === undefined ? {} : { page_width: page.width }),
        ...(page.height === undefined ? {} : { page_height: page.height }),
        ...(page.coordinate_unit ? { coordinate_unit: page.coordinate_unit } : {}),
        ...(block?.bbox ? {
          bbox_x: block.bbox[0],
          bbox_y: block.bbox[1],
          bbox_width: block.bbox[2],
          bbox_height: block.bbox[3],
        } : {}),
        ...(block?.region_id ? { region_id: block.region_id } : {}),
        ...(block?.confidence === undefined ? {} : { confidence: block.confidence }),
        ...(block?.language ? { language: block.language } : {}),
        ...(extraction ? {
          extraction_method: extraction.method,
          extraction_provider: extraction.provider_id,
          ...(extraction.model_id ? { extraction_model: extraction.model_id } : {}),
          ...(extraction.model_version ? { extraction_model_version: extraction.model_version } : {}),
        } : {}),
      }),
      token_count: Math.max(1, Math.ceil(content.length / 4)),
    };
  }
}

interface PdfBlockWithPath {
  readonly text: string;
  readonly bbox?: readonly [number, number, number, number];
  readonly region_id?: string;
  readonly confidence?: number;
  readonly language?: string;
}

export class CodeAstChunker implements IndexChunkerPort {
  private readonly maxChildCharacters: number;
  private readonly maxParentCharacters: number;
  private readonly fallbackMode: StructuredChunkerFallbackMode;

  constructor(options: StructuredChunkerOptions = {}) {
    this.maxChildCharacters = options.max_child_characters ?? 1_200;
    this.maxParentCharacters = options.max_parent_characters ?? 4_800;
    this.fallbackMode = options.fallback_mode ?? "strict";
    validateChunkLimits(this.maxChildCharacters, this.maxParentCharacters, "Code AST");
  }

  chunk(document: IndexSourceDocument): readonly IndexChunkDraft[] {
    const source = structuredSourceOrFallback(document, "code-ast", this.fallbackMode);
    if (!source) return degradedTextChunks(document, "code-ast", this.maxChildCharacters);
    const drafts: IndexChunkDraft[] = [];
    let ordinal = 0;
    for (const [rootIndex, node] of source.nodes.entries()) {
      validateAstNode(node);
      const path = [source.language, node.name ?? node.kind, String(rootIndex + 1)];
      const parentOrdinal = ordinal++;
      const parentText = `${node.signature ?? node.name ?? node.kind}\n\n${node.text}`.trim();
      const parentParts = splitLongBlock(parentText, this.maxParentCharacters);
      for (const [partIndex, part] of parentParts.entries()) {
        const currentParent = partIndex === 0 ? parentOrdinal : ordinal++;
        drafts.push(codeDraft(document, currentParent, "parent", path, part, source.language, node, undefined));
        const astParts = flattenAstNodes(node);
        for (const [childIndex, child] of astParts.entries()) {
          const childText = `${child.signature ?? child.name ?? child.kind}\n${child.text}`.trim();
          for (const [partOffset, text] of splitLongBlock(childText, this.maxChildCharacters).entries()) {
            drafts.push(codeDraft(
              document,
              ordinal++,
              "child",
              [...path, child.name ?? child.kind, String(childIndex + 1)],
              text,
              source.language,
              child,
              currentParent,
              partOffset,
            ));
          }
        }
      }
    }
    return drafts;
  }
}

export class TableStructureChunker implements IndexChunkerPort {
  private readonly maxChildCharacters: number;
  private readonly maxParentCharacters: number;
  private readonly fallbackMode: StructuredChunkerFallbackMode;

  constructor(options: StructuredChunkerOptions = {}) {
    this.maxChildCharacters = options.max_child_characters ?? 1_200;
    this.maxParentCharacters = options.max_parent_characters ?? 4_800;
    this.fallbackMode = options.fallback_mode ?? "strict";
    validateChunkLimits(this.maxChildCharacters, this.maxParentCharacters, "Table");
  }

  chunk(document: IndexSourceDocument): readonly IndexChunkDraft[] {
    const source = structuredSourceOrFallback(document, "table", this.fallbackMode);
    if (!source) return degradedTextChunks(document, "table", this.maxChildCharacters);
    const drafts: IndexChunkDraft[] = [];
    let ordinal = 0;
    for (const sheet of source.sheets) {
      if (!sheet.name.trim()) throw new IndexBuildWorkerError("INVALID_TABLE_SHEET", "Table sheets require names", false);
      for (const table of sheet.tables) {
        if (!table.name.trim() || table.headers.length === 0) {
          throw new IndexBuildWorkerError("INVALID_TABLE", "Tables require a name and at least one header", false);
        }
        if (table.rows.some((row) => row.length !== table.headers.length)) {
          throw new IndexBuildWorkerError("TABLE_WIDTH_MISMATCH", "Table rows must match the header width", false);
        }
        const path = [sheet.name.trim(), table.name.trim()];
        const header = table.headers.map((value, index) => `${index + 1}. ${value}`).join(" | ");
        const parentOrdinal = ordinal++;
        const parentContent = `${path.join(" > ")}\n\nColumns: ${header}`;
        drafts.push(tableDraft(document, parentOrdinal, "parent", path, parentContent, sheet.name, table.name, 0, table.headers.length - 1));
        const rows = table.rows.length > 0 ? table.rows : [table.headers];
        let rowIndex = 0;
        let group: string[] = [];
        let groupStart = 0;
        const flush = (endIndex: number) => {
          if (group.length === 0) return;
          const raw = `${path.join(" > ")}\n\n${header}\n${group.join("\n")}`;
          for (const [part, content] of splitLongBlock(raw, this.maxChildCharacters).entries()) {
            drafts.push(tableDraft(document, ordinal++, "child", path, content, sheet.name, table.name, groupStart, endIndex, part, parentOrdinal));
          }
          group = [];
        };
        for (const row of rows) {
          const line = row.map((value, index) => `${table.headers[index]}=${value}`).join(" | ");
          const addition = line.length + (group.length > 0 ? 1 : 0);
          if (group.length > 0 && (`${header}\n${group.join("\n")}\n${line}`).length > this.maxChildCharacters) {
            flush(rowIndex - 1);
            groupStart = rowIndex;
          }
          group.push(line);
          rowIndex += 1;
          void addition;
        }
        flush(rowIndex - 1);
      }
    }
    return drafts;
  }
}

export class ConversationTurnChunker implements IndexChunkerPort {
  private readonly maxChildCharacters: number;
  private readonly maxParentCharacters: number;
  private readonly fallbackMode: StructuredChunkerFallbackMode;

  constructor(options: StructuredChunkerOptions = {}) {
    this.maxChildCharacters = options.max_child_characters ?? 1_200;
    this.maxParentCharacters = options.max_parent_characters ?? 4_800;
    this.fallbackMode = options.fallback_mode ?? "strict";
    validateChunkLimits(this.maxChildCharacters, this.maxParentCharacters, "Conversation");
  }

  chunk(document: IndexSourceDocument): readonly IndexChunkDraft[] {
    const source = structuredSourceOrFallback(document, "conversation", this.fallbackMode);
    if (!source) return degradedTextChunks(document, "conversation", this.maxChildCharacters);
    const turns = [...source.turns].sort((left, right) => left.sequence - right.sequence || left.turn_id.localeCompare(right.turn_id));
    validateConversationTurns(turns);
    const drafts: IndexChunkDraft[] = [];
    let ordinal = 0;
    for (const group of groupConversationTurns(turns, this.maxParentCharacters)) {
      const parentOrdinal = ordinal++;
      const path = ["conversation", `turns ${group[0]!.sequence}-${group[group.length - 1]!.sequence}`];
      const parentContent = group.map(formatConversationTurn).join("\n\n");
      drafts.push(conversationDraft(
        document,
        parentOrdinal,
        "parent",
        path,
        parentContent,
        group[0]!,
        group[group.length - 1]!,
        conversationEvidenceMetadata(source, group),
      ));
      const children = group.flatMap((turn) => splitLongBlock(formatConversationTurn(turn), this.maxChildCharacters)
        .map((content, part) => ({ turn, content, part })));
      for (const child of children) {
        drafts.push(conversationDraft(
          document,
          ordinal++,
          "child",
          [...path, child.turn.turn_id],
          child.content,
          child.turn,
          child.turn,
          conversationEvidenceMetadata(source, [child.turn]),
          parentOrdinal,
          child.part,
        ));
      }
    }
    return drafts;
  }
}

function validateConversationTurns(turns: readonly IndexConversationTurn[]): void {
  const ids = new Set<string>();
  const sequences = new Set<number>();
  for (const turn of turns) {
    if (!turn.turn_id.trim() || ids.has(turn.turn_id) || !Number.isInteger(turn.sequence) || turn.sequence < 0 ||
      sequences.has(turn.sequence) || !turn.speaker_id.trim() || !turn.content.trim()) {
      throw new IndexBuildWorkerError("INVALID_CONVERSATION_TURN", "Conversation turns require unique ordered identity, speaker and content", false);
    }
    ids.add(turn.turn_id);
    sequences.add(turn.sequence);
    if (turn.started_at && Number.isNaN(Date.parse(turn.started_at))) {
      throw new IndexBuildWorkerError("INVALID_CONVERSATION_TIME", "Conversation turn timestamps must be valid ISO dates", false);
    }
    if (turn.ended_at && Number.isNaN(Date.parse(turn.ended_at))) {
      throw new IndexBuildWorkerError("INVALID_CONVERSATION_TIME", "Conversation turn timestamps must be valid ISO dates", false);
    }
    if ((turn.start_ms === undefined) !== (turn.end_ms === undefined) ||
      (turn.start_ms !== undefined && (!Number.isSafeInteger(turn.start_ms) || turn.start_ms < 0 ||
        !Number.isSafeInteger(turn.end_ms) || turn.end_ms! <= turn.start_ms))) {
      throw new IndexBuildWorkerError("INVALID_CONVERSATION_TIME", "Conversation media offsets must be ordered non-negative milliseconds", false);
    }
    if (turn.confidence !== undefined && (!Number.isFinite(turn.confidence) || turn.confidence < 0 || turn.confidence > 1)) {
      throw new IndexBuildWorkerError("INVALID_CONVERSATION_CONFIDENCE", "Conversation confidence must be between 0 and 1", false);
    }
  }
}

function groupConversationTurns(
  turns: readonly IndexConversationTurn[],
  maxCharacters: number,
): readonly (readonly IndexConversationTurn[])[] {
  const groups: IndexConversationTurn[][] = [];
  let current: IndexConversationTurn[] = [];
  let size = 0;
  for (const turn of turns) {
    const formatted = formatConversationTurn(turn);
    const addition = formatted.length + (current.length > 0 ? 2 : 0);
    if (current.length > 0 && size + addition > maxCharacters) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(turn);
    size += formatted.length + (current.length > 1 ? 2 : 0);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function formatConversationTurn(turn: IndexConversationTurn): string {
  const role = turn.role ? `/${turn.role}` : "";
  return `[${turn.speaker_id}${role} #${turn.sequence}] ${turn.content.trim()}`;
}

function conversationDraft(
  document: IndexSourceDocument,
  ordinal: number,
  level: "parent" | "child",
  path: readonly string[],
  content: string,
  first: IndexConversationTurn,
  last: IndexConversationTurn,
  evidenceMetadata: Readonly<Record<string, string | number>>,
  parentOrdinal?: number,
  part?: number,
): IndexChunkDraft {
  return {
    memory_id: document.memory_id,
    ordinal,
    chunk_level: level,
    ...(parentOrdinal === undefined ? {} : { parent_ordinal: parentOrdinal }),
    structure_path: path,
    content,
    source_type: document.source_type,
    entity_keys: document.entity_keys ?? [],
    citation: withStructureLocator(document.citation, path, level, first.sequence, part, {
      turn_id: first.turn_id,
      turn_range_start: first.sequence,
      turn_range_end: last.sequence,
      speaker_id: first.speaker_id,
      ...(first.started_at ? { started_at: first.started_at } : {}),
      ...(last.ended_at ? { ended_at: last.ended_at } : {}),
      ...evidenceMetadata,
    }),
    token_count: Math.max(1, Math.ceil(content.length / 4)),
  };
}

function conversationEvidenceMetadata(
  source: IndexConversationSource,
  turns: readonly IndexConversationTurn[],
): Readonly<Record<string, string | number>> {
  const starts = turns.map((turn) => turn.start_ms).filter((value): value is number => value !== undefined);
  const ends = turns.map((turn) => turn.end_ms).filter((value): value is number => value !== undefined);
  const confidences = turns.map((turn) => turn.confidence).filter((value): value is number => value !== undefined);
  const languages = [...new Set(turns.map((turn) => turn.language).filter((value): value is string => Boolean(value)))];
  return {
    ...(starts.length > 0 ? { media_start_ms: Math.min(...starts) } : {}),
    ...(ends.length > 0 ? { media_end_ms: Math.max(...ends) } : {}),
    ...(confidences.length > 0 ? { confidence: Math.min(...confidences) } : {}),
    ...(languages.length === 1 ? { language: languages[0]! } : source.language ? { language: source.language } : {}),
    ...(source.duration_ms === undefined ? {} : { media_duration_ms: source.duration_ms }),
    ...(source.extraction ? {
      extraction_method: source.extraction.method,
      extraction_provider: source.extraction.provider_id,
      diarization: source.extraction.diarization ? "enabled" : "disabled",
      ...(source.extraction.model_id ? { extraction_model: source.extraction.model_id } : {}),
      ...(source.extraction.model_version ? { extraction_model_version: source.extraction.model_version } : {}),
    } : {}),
  };
}

function structuredSourceOrFallback<K extends IndexStructuredSource["kind"]>(
  document: IndexSourceDocument,
  kind: K,
  fallbackMode: StructuredChunkerFallbackMode,
): Extract<IndexStructuredSource, { readonly kind: K }> | undefined {
  if (document.structured?.kind === kind) return document.structured as Extract<IndexStructuredSource, { readonly kind: K }>;
  if (fallbackMode === "degraded") return undefined;
  throw new IndexBuildWorkerError("STRUCTURED_SOURCE_MISSING", `${kind} chunking requires parser output`, false);
}

function degradedTextChunks(
  document: IndexSourceDocument,
  expectedStructure: IndexStructuredSource["kind"],
  maxCharacters: number,
): readonly IndexChunkDraft[] {
  const chunks = new PlainTextParagraphChunker(maxCharacters).chunk(document);
  return chunks.map((chunk) => ({
    ...chunk,
    citation: {
      ...chunk.citation,
      locator: {
        ...(chunk.citation.locator ?? {}),
        parser_mode: "degraded",
        degradation: "parser-unavailable",
        expected_structure: expectedStructure,
        ...(document.parser_diagnostic?.code ? { parser_diagnostic: document.parser_diagnostic.code } : {}),
        ...(document.parser_diagnostic?.parser_id ? { parser_id: document.parser_diagnostic.parser_id } : {}),
      },
    },
  }));
}

function validateChunkLimits(child: number, parent: number, label: string): void {
  if (!Number.isInteger(child) || child < 128) throw new TypeError(`${label} Child maximum must be at least 128 characters`);
  if (!Number.isInteger(parent) || parent < child) throw new TypeError(`${label} Parent maximum must be no smaller than Child maximum`);
}

function groupLayoutBlocks(blocks: readonly PdfBlockWithPath[], maxCharacters: number): readonly (readonly PdfBlockWithPath[])[] {
  const groups: PdfBlockWithPath[][] = [];
  let current: PdfBlockWithPath[] = [];
  let size = 0;
  for (const block of blocks) {
    const pieces = splitLongBlock(block.text, maxCharacters);
    for (const piece of pieces) {
      const normalized = { ...block, text: piece };
      const addition = piece.length + (current.length > 0 ? 2 : 0);
      if (current.length > 0 && size + addition > maxCharacters) {
        groups.push(current);
        current = [];
        size = 0;
      }
      current.push(normalized);
      size += piece.length + (current.length > 1 ? 2 : 0);
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function validateAstNode(node: IndexCodeAstNode): void {
  if (!node.kind.trim() || !node.text.trim() || !Number.isInteger(node.start_line) || !Number.isInteger(node.end_line) ||
    node.start_line < 1 || node.end_line < node.start_line) {
    throw new IndexBuildWorkerError("INVALID_AST_NODE", "AST nodes require kind, text and ordered line numbers", false);
  }
  for (const child of node.children ?? []) validateAstNode(child);
}

function flattenAstNodes(root: IndexCodeAstNode): readonly IndexCodeAstNode[] {
  const children = root.children ?? [];
  return children.length > 0
    ? children.flatMap((child) => [child, ...(child.children ? flattenAstNodes(child) : [])])
    : [root];
}

function codeDraft(
  document: IndexSourceDocument,
  ordinal: number,
  level: "parent" | "child",
  path: readonly string[],
  content: string,
  language: string,
  node: IndexCodeAstNode,
  part?: number,
  parentOrdinal?: number,
): IndexChunkDraft {
  return {
    memory_id: document.memory_id,
    ordinal,
    chunk_level: level,
    ...(parentOrdinal === undefined ? {} : { parent_ordinal: parentOrdinal }),
    structure_path: path,
    content,
    source_type: document.source_type,
    entity_keys: document.entity_keys ?? [],
    citation: withStructureLocator(document.citation, path, level, node.start_line, part, {
      language,
      start_line: node.start_line,
      end_line: node.end_line,
      node_kind: node.kind,
      ...(node.name ? { symbol: node.name } : {}),
    }),
    token_count: Math.max(1, Math.ceil(content.length / 4)),
  };
}

function tableDraft(
  document: IndexSourceDocument,
  ordinal: number,
  level: "parent" | "child",
  path: readonly string[],
  content: string,
  sheet: string,
  table: string,
  rowStart: number,
  rowEnd: number,
  part?: number,
  parentOrdinal?: number,
): IndexChunkDraft {
  return {
    memory_id: document.memory_id,
    ordinal,
    chunk_level: level,
    ...(parentOrdinal === undefined ? {} : { parent_ordinal: parentOrdinal }),
    structure_path: path,
    content,
    source_type: document.source_type,
    entity_keys: document.entity_keys ?? [],
    citation: withStructureLocator(document.citation, path, level, rowStart, part, {
      sheet,
      table,
      row_start: rowStart,
      row_end: rowEnd,
    }),
    token_count: Math.max(1, Math.ceil(content.length / 4)),
  };
}

export class DefaultIndexReadyGate implements IndexReadyGatePort {
  evaluate(input: IndexReadyGateInput): IndexReadyGateResult {
    const reasons: string[] = [];
    if (input.documents.length === 0) reasons.push("no source documents were loaded");
    const chunkedMemoryIds = new Set(input.chunks.map((chunk) => chunk.memory_id));
    const recalledMemoryIds = new Set(
      input.chunks.filter((chunk) => (chunk.chunk_level ?? "child") === "child").map((chunk) => chunk.memory_id),
    );
    if (input.documents.some((document) => !chunkedMemoryIds.has(document.memory_id) || !recalledMemoryIds.has(document.memory_id))) {
      reasons.push("one or more documents produced no Chunk");
    }
    if (new Set(input.chunks.map((chunk) => chunk.chunk_id)).size !== input.chunks.length) {
      reasons.push("Chunk identities are not unique");
    }
    if (input.task.embedding_dimensions !== undefined) {
      if (input.chunks.some((chunk) =>
        (chunk.chunk_level ?? "child") === "child" && chunk.embedding?.length !== input.task.embedding_dimensions
      )) {
        reasons.push("one or more Chunk embeddings violate the build dimensions");
      }
    }
    const chunksById = new Map(input.chunks.map((chunk) => [chunk.chunk_id, chunk]));
    if (input.chunks.some((chunk) => {
      if ((chunk.chunk_level ?? "child") === "parent") return Boolean(chunk.parent_chunk_id || chunk.embedding);
      if (!chunk.parent_chunk_id) return false;
      const parent = chunksById.get(chunk.parent_chunk_id);
      return !parent || parent.chunk_level !== "parent" || parent.memory_id !== chunk.memory_id ||
        parent.index_version_id !== chunk.index_version_id;
    })) {
      reasons.push("Parent/Child Chunk relationships are inconsistent");
    }
    const referencedParents = new Set(input.chunks.map((chunk) => chunk.parent_chunk_id).filter(Boolean));
    if (input.chunks.some((chunk) => chunk.chunk_level === "parent" && !referencedParents.has(chunk.chunk_id))) {
      reasons.push("one or more Parent Chunks have no recallable Child");
    }
    const passed = reasons.length === 0;
    return {
      passed,
      reasons,
      checks: [{
        name: "structure",
        passed,
        score: passed ? 1 : 0,
        threshold: 1,
        sample_size: input.chunks.length,
        summary: passed ? "Index structure is complete and internally consistent" : reasons.join("; "),
        evidence_refs: [],
      }],
    };
  }
}

const advancedCheckNames = ["source_watermark", "acl", "recall", "citation"] as const;

export class AdvancedIndexReadyGate implements IndexReadyGatePort {
  private readonly probes: readonly IndexQualityProbe[];
  private readonly structural = new DefaultIndexReadyGate();

  constructor(probes: readonly IndexQualityProbe[]) {
    const names = probes.map((probe) => probe.name);
    if (new Set(names).size !== names.length) throw new TypeError("Index quality probe names must be unique");
    const missing = advancedCheckNames.filter((name) => !names.includes(name));
    if (missing.length > 0) throw new TypeError(`Missing required index quality probes: ${missing.join(", ")}`);
    this.probes = advancedCheckNames.map((name) => probes.find((probe) => probe.name === name)!);
  }

  async evaluate(input: IndexReadyGateInput): Promise<IndexReadyGateResult> {
    const structural = this.structural.evaluate(input);
    const probeChecks = await Promise.all(this.probes.map(async (probe) => {
      const result = await probe.evaluate(input);
      const check: IndexQualityCheck = { name: probe.name, ...result };
      validateQualityCheck(check);
      return check;
    }));
    const checks = [...structural.checks, ...probeChecks];
    const reasons = [
      ...structural.reasons,
      ...probeChecks.filter((check) => !check.passed).map((check) => `${check.name}: ${check.summary}`),
    ];
    return { passed: checks.every((check) => check.passed), reasons, checks };
  }
}

export class SourceWatermarkQualityProbe implements IndexQualityProbe {
  readonly name = "source_watermark" as const;
  private readonly readCurrent: (task: IndexBuildTask) => Promise<string> | string;

  constructor(readCurrent: (task: IndexBuildTask) => Promise<string> | string) {
    this.readCurrent = readCurrent;
  }

  async evaluate(input: IndexReadyGateInput): Promise<Omit<IndexQualityCheck, "name">> {
    const observed = await this.readCurrent(input.task);
    const passed = observed === input.task.source_watermark;
    return {
      passed,
      score: passed ? 1 : 0,
      threshold: 1,
      sample_size: 1,
      summary: passed
        ? "Source watermark still matches the immutable build snapshot"
        : `Source watermark changed from ${input.task.source_watermark} to ${observed}`,
      evidence_refs: [],
    };
  }
}

function parseIndexBuildTask(value: unknown): IndexBuildTask {
  assertContract("IndexBuildTask", value);
  return value as IndexBuildTask;
}

function toQualityReport(task: IndexBuildTask, gate: IndexReadyGateResult, evaluatedAt: Date): IndexQualityReport {
  if (gate.checks.length === 0) {
    throw new IndexBuildWorkerError("EMPTY_QUALITY_REPORT", "Index Ready Gate returned no quality checks", false);
  }
  const names = gate.checks.map((check) => check.name);
  if (new Set(names).size !== names.length) {
    throw new IndexBuildWorkerError("DUPLICATE_QUALITY_CHECK", "Index Ready Gate returned duplicate checks", false);
  }
  for (const check of gate.checks) validateQualityCheck(check);
  if (gate.passed !== gate.checks.every((check) => check.passed)) {
    throw new IndexBuildWorkerError("QUALITY_OUTCOME_MISMATCH", "Index Ready Gate outcome conflicts with its checks", false);
  }
  const identity = createHash("sha256")
    .update(`${task.build_id}\n${canonicalJson(gate.checks)}`, "utf8")
    .digest("hex");
  const report: IndexQualityReport = {
    schema_version: 1,
    report_id: `quality.${identity}`,
    build_id: task.build_id,
    index_version_id: task.index_version_id,
    source_watermark: task.source_watermark,
    configuration_digest: task.configuration_digest,
    passed: gate.passed,
    checks: gate.checks,
    evaluated_at: evaluatedAt.toISOString(),
  };
  assertContract("IndexQualityReport", report);
  return report;
}

function validateQualityCheck(check: IndexQualityCheck): void {
  if (
    !Number.isFinite(check.score) || check.score < 0 || check.score > 1 ||
    !Number.isFinite(check.threshold) || check.threshold < 0 || check.threshold > 1 ||
    !Number.isInteger(check.sample_size) || check.sample_size < 0 ||
    !check.summary.trim() ||
    check.passed !== (check.score >= check.threshold)
  ) {
    throw new IndexBuildWorkerError("INVALID_QUALITY_CHECK", `Invalid ${check.name} quality check`, false);
  }
}

function validateDocuments(documents: readonly IndexSourceDocument[]): void {
  if (new Set(documents.map((document) => document.memory_id)).size !== documents.length) {
    throw new IndexBuildWorkerError("DUPLICATE_SOURCE", "A build source returned the same Memory more than once", false);
  }
  for (const document of documents) {
    if (!document.memory_id || (!document.content.trim() && !document.content_bytes?.byteLength) || !document.source_type) {
      throw new IndexBuildWorkerError("INVALID_SOURCE", "Index source documents require identity, content and type", false);
    }
    assertContract("EvidenceCitation", document.citation);
  }
}

function validateDrafts(drafts: readonly IndexChunkDraft[]): void {
  const byKey = new Map<string, IndexChunkDraft>();
  for (const draft of drafts) {
    const key = draftKey(draft);
    if (byKey.has(key)) {
      throw new IndexBuildWorkerError("DUPLICATE_CHUNK_ORDINAL", "Chunk ordinals must be unique per Memory", false);
    }
    byKey.set(key, draft);
    const level = draft.chunk_level ?? "child";
    if (level === "parent" && draft.parent_ordinal !== undefined) {
      throw new IndexBuildWorkerError("INVALID_PARENT_CHUNK", "Parent Chunk cannot reference another parent", false);
    }
    if ((draft.structure_path ?? []).some((part) => !part.trim())) {
      throw new IndexBuildWorkerError("INVALID_STRUCTURE_PATH", "Chunk structure paths cannot be empty", false);
    }
  }
  for (const draft of drafts) {
    if (draft.parent_ordinal === undefined) continue;
    const parent = byKey.get(`${draft.memory_id}\n${draft.parent_ordinal}`);
    if (!parent || parent.chunk_level !== "parent") {
      throw new IndexBuildWorkerError("PARENT_CHUNK_MISSING", "Child Chunk references a missing Parent", false);
    }
  }
}

export function assertDegradedIndexPolicy(
  drafts: readonly IndexChunkDraft[],
  options: {
    readonly auto_activate: boolean;
    readonly allow_degraded_build: boolean;
    readonly allow_degraded_activation: boolean;
  },
): void {
  const degraded = drafts.some((draft) => draft.citation.locator?.parser_mode === "degraded");
  if (!degraded) return;
  if (!options.allow_degraded_build) {
    throw new IndexBuildWorkerError(
      "DEGRADED_INDEX_BUILD_NOT_ALLOWED",
      "Parser-degraded chunks require explicit allow_degraded_build",
      false,
    );
  }
  if (options.auto_activate && !options.allow_degraded_activation) {
    throw new IndexBuildWorkerError(
      "DEGRADED_INDEX_ACTIVATION_NOT_ALLOWED",
      "Parser-degraded chunks cannot be auto-activated without explicit allow_degraded_activation",
      false,
    );
  }
}

function toIndexChunk(
  task: IndexBuildTask,
  draft: IndexChunkDraft,
  identityByDraft: ReadonlyMap<string, string>,
  embedding: readonly number[] | undefined,
): IndexMemoryChunkInput {
  const level = draft.chunk_level ?? "child";
  const parentChunkId = draft.parent_ordinal === undefined
    ? undefined
    : identityByDraft.get(`${draft.memory_id}\n${draft.parent_ordinal}`);
  return {
    chunk_id: identityByDraft.get(draftKey(draft))!,
    memory_id: draft.memory_id,
    index_version_id: task.index_version_id,
    ordinal: draft.ordinal,
    chunk_level: level,
    ...(parentChunkId ? { parent_chunk_id: parentChunkId } : {}),
    structure_path: draft.structure_path ?? [],
    content: draft.content,
    chunk_digest: contentDigest(draft.content),
    token_count: draft.token_count,
    source_type: draft.source_type,
    entity_keys: draft.entity_keys,
    citation: draft.citation,
    ...(level === "child" && embedding ? { embedding, embedding_model: task.embedding_model! } : {}),
  };
}

function chunkIdentity(task: IndexBuildTask, draft: IndexChunkDraft): string {
  const identity = createHash("sha256")
    .update(`${task.index_version_id}\n${draft.memory_id}\n${draft.ordinal}\n${contentDigest(draft.content)}`, "utf8")
    .digest("hex");
  return `chunk.${identity}`;
}

function draftKey(draft: Pick<IndexChunkDraft, "memory_id" | "ordinal">): string {
  return `${draft.memory_id}\n${draft.ordinal}`;
}

function parseMarkdownSections(content: string): readonly MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  const headings: string[] = [];
  let heading: string | undefined;
  let path: readonly string[] = ["document"];
  let blocks: string[] = [];
  let paragraph: string[] = [];
  const flushParagraph = () => {
    const value = paragraph.join("\n").trim();
    if (value) blocks.push(value);
    paragraph = [];
  };
  const flushSection = () => {
    flushParagraph();
    if (blocks.length > 0) sections.push({ path, ...(heading ? { heading } : {}), blocks });
    blocks = [];
  };
  for (const line of content.split(/\r?\n/u)) {
    const match = /^(#{1,6})\s+(.+?)\s*$/u.exec(line);
    if (match) {
      flushSection();
      const level = match[1]!.length;
      const title = match[2]!.trim();
      headings.length = level - 1;
      headings[level - 1] = title;
      path = headings.filter(Boolean);
      heading = `${match[1]} ${title}`;
    } else if (!line.trim()) {
      flushParagraph();
    } else {
      paragraph.push(line);
    }
  }
  flushSection();
  return sections;
}

function groupBlocks(blocks: readonly string[], maxCharacters: number): readonly (readonly string[])[] {
  const normalized = blocks.flatMap((block) => splitLongBlock(block, maxCharacters));
  const groups: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const block of normalized) {
    const addition = block.length + (current.length > 0 ? 2 : 0);
    if (current.length > 0 && size + addition > maxCharacters) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(block);
    size += block.length + (current.length > 1 ? 2 : 0);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function withStructureLocator(
  citation: EvidenceCitation,
  path: readonly string[],
  level: "parent" | "child",
  sectionPart: number,
  childPart?: number,
  extra?: Readonly<Record<string, string | number>>,
): EvidenceCitation {
  return {
    ...citation,
    locator: {
      ...(citation.locator ?? {}),
      section_path: path.join(" > "),
      chunk_level: level,
      section_part: sectionPart,
      ...(childPart === undefined ? {} : { chunk_part: childPart }),
      ...(extra ?? {}),
    },
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

function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizeJson(item)]),
    );
  }
  return value;
}

function retryDelay(attempt: number, options: IndexBuildWorkerOptions): number {
  const initial = options.initial_backoff_ms ?? 1_000;
  const maximum = options.max_backoff_ms ?? 60_000;
  return Math.min(maximum, initial * 2 ** Math.max(0, attempt - 1));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
