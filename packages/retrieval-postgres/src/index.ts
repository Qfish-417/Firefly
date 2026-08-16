import { createHash } from "node:crypto";

import type { EvidenceCitation, IndexBuildTask, IndexEvaluationCase, StructuredResult } from "@firefly/contracts";
import type { EmbeddingPort, ModelBudget } from "@firefly/model-gateway";
import { MemoryRepository, type QuestLabDatabase, type StructuredEdge, type StructuredEvent } from "@firefly/persistence";
import type {
  EvidenceExpansionCandidate,
  EvidenceExpansionCandidateSource,
  EvidenceExpansionRelation,
  EvidenceExpansionPort,
  RetrievalAuthorizationPort,
  RetrievalHit,
  RetrievalPrincipal,
  Retriever,
  RetrieverCall,
  RetrievalRequest,
  StructuredAggregatorPort,
} from "@firefly/retrieval-service";
import { sql, type Kysely, type RawBuilder } from "kysely";

export interface IndexMemoryChunkInput {
  readonly chunk_id: string;
  readonly memory_id: string;
  readonly index_version_id: string;
  readonly ordinal: number;
  readonly chunk_level?: "parent" | "child";
  readonly parent_chunk_id?: string;
  readonly structure_path?: readonly string[];
  readonly content: string;
  readonly chunk_digest: `sha256:${string}`;
  readonly token_count: number;
  readonly source_type: string;
  readonly entity_keys?: readonly string[];
  readonly citation: EvidenceCitation;
  readonly embedding?: readonly number[];
  readonly embedding_model?: string;
}

export interface PostgresVectorRetrieverOptions {
  readonly db: Kysely<QuestLabDatabase>;
  readonly embeddings: EmbeddingPort;
  readonly embedding_model: string;
  readonly embedding_budget: ModelBudget;
  readonly logical_name?: string;
  readonly id?: string;
}

interface MemorySearchRow {
  readonly chunk_id: string;
  readonly content: string;
  readonly token_count: number;
  readonly source_type: string;
  readonly entity_keys: readonly string[];
  readonly citation_artifact_id: string;
  readonly citation_uri: string;
  readonly citation_digest: string;
  readonly citation_locator: Readonly<Record<string, string | number>>;
  readonly score: number | string;
}

interface IndexQualitySearchRow extends MemorySearchRow {
  readonly memory_id: string;
}

export interface PostgresIndexQualityEvaluationHit {
  readonly chunk_id: string;
  readonly memory_id: string;
  readonly score: number;
  readonly citation: EvidenceCitation;
}

interface ParentExpansionRow extends Omit<MemorySearchRow, "score"> {
  readonly child_id: string;
}

interface RelationExpansionRow extends Omit<MemorySearchRow, "score"> {
  readonly anchor_id: string;
  readonly relation: EvidenceExpansionRelation;
  readonly relation_score: number | string;
}

export interface PostgresRelationExpansionCandidateSourceOptions {
  readonly db: Kysely<QuestLabDatabase>;
  readonly logical_name?: string;
  readonly region_locator_key?: string;
  readonly temporal_locator_key?: string;
}

export class PostgresRetrievalPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostgresRetrievalPolicyError";
  }
}

export class ChunkIdentityConflictError extends Error {
  readonly chunkId: string;

  constructor(chunkId: string) {
    super(`Chunk ID was reused for different immutable content: ${chunkId}`);
    this.name = "ChunkIdentityConflictError";
    this.chunkId = chunkId;
  }
}

export class PostgresMemoryIndexer {
  private readonly db: Kysely<QuestLabDatabase>;

  constructor(db: Kysely<QuestLabDatabase>) {
    this.db = db;
  }

  async index(input: IndexMemoryChunkInput): Promise<void> {
    validateChunk(input);
    const memory = await this.db
      .selectFrom("questlab.memory_record")
      .select(["memory_id", "tenant_id", "status"])
      .where("memory_id", "=", input.memory_id)
      .executeTakeFirst();
    if (!memory || memory.status !== "active") {
      throw new PostgresRetrievalPolicyError("Only an active source memory may be indexed");
    }
    const version = await this.db
      .selectFrom("questlab.retrieval_index_version")
      .select(["tenant_id", "status", "embedding_model", "embedding_dimensions"])
      .where("index_version_id", "=", input.index_version_id)
      .executeTakeFirst();
    if (!version || (version.status !== "building" && version.status !== "active")) {
      throw new PostgresRetrievalPolicyError("Chunks may only be written to a building or active index version");
    }
    if (version.tenant_id !== memory.tenant_id) {
      throw new PostgresRetrievalPolicyError("Index version and source memory must belong to the same tenant");
    }
    const chunkLevel = input.chunk_level ?? "child";
    if (chunkLevel === "child" && (
      version.embedding_model !== (input.embedding_model ?? null) ||
      version.embedding_dimensions !== (input.embedding?.length ?? null)
    )) {
      throw new PostgresRetrievalPolicyError("Chunk embedding snapshot does not match its index version");
    }
    if (input.parent_chunk_id) {
      const parent = await this.db
        .selectFrom("questlab.memory_chunk")
        .select(["memory_id", "index_version_id", "chunk_level"])
        .where("chunk_id", "=", input.parent_chunk_id)
        .executeTakeFirst();
      if (
        !parent ||
        parent.chunk_level !== "parent" ||
        parent.memory_id !== input.memory_id ||
        parent.index_version_id !== input.index_version_id
      ) {
        throw new PostgresRetrievalPolicyError("Parent Chunk must belong to the same Memory and index version");
      }
    }

    const embedding = input.embedding
      ? sql<string>`${vectorLiteral(input.embedding)}::vector`
      : null;
    const inserted = await this.db
      .insertInto("questlab.memory_chunk")
      .values({
        chunk_id: input.chunk_id,
        memory_id: input.memory_id,
        index_version_id: input.index_version_id,
        ordinal: input.ordinal,
        chunk_level: chunkLevel,
        parent_chunk_id: input.parent_chunk_id ?? null,
        structure_path: input.structure_path ?? [],
        content: input.content,
        chunk_digest: input.chunk_digest,
        token_count: input.token_count,
        source_type: input.source_type,
        entity_keys: input.entity_keys ?? [],
        citation_artifact_id: input.citation.artifact_id,
        citation_uri: input.citation.uri,
        citation_digest: input.citation.digest,
        citation_locator: input.citation.locator ?? {},
        embedding,
        embedding_model: input.embedding ? input.embedding_model! : null,
        embedding_dimensions: input.embedding?.length ?? null,
      })
      .onConflict((conflict) => conflict.column("chunk_id").doNothing())
      .returning("chunk_id")
      .executeTakeFirst();
    if (inserted) return;

    const existing = await this.db
      .selectFrom("questlab.memory_chunk")
      .select([
        "memory_id",
        "index_version_id",
        "ordinal",
        "chunk_level",
        "parent_chunk_id",
        "structure_path",
        "content",
        "chunk_digest",
        "token_count",
        "source_type",
        "entity_keys",
        "citation_artifact_id",
        "citation_uri",
        "citation_digest",
        "citation_locator",
        "embedding",
        "embedding_model",
        "embedding_dimensions",
      ])
      .where("chunk_id", "=", input.chunk_id)
      .executeTakeFirstOrThrow();
    if (
      existing.memory_id !== input.memory_id ||
      existing.index_version_id !== input.index_version_id ||
      existing.ordinal !== input.ordinal ||
      existing.chunk_level !== chunkLevel ||
      existing.parent_chunk_id !== (input.parent_chunk_id ?? null) ||
      !sameStrings(existing.structure_path, input.structure_path ?? []) ||
      existing.content !== input.content ||
      existing.chunk_digest !== input.chunk_digest ||
      existing.token_count !== input.token_count ||
      existing.source_type !== input.source_type ||
      !sameStrings(existing.entity_keys, input.entity_keys ?? []) ||
      existing.citation_artifact_id !== input.citation.artifact_id ||
      existing.citation_uri !== input.citation.uri ||
      existing.citation_digest !== input.citation.digest ||
      stableObject(existing.citation_locator) !== stableObject(input.citation.locator ?? {}) ||
      existing.embedding_model !== (input.embedding ? input.embedding_model! : null) ||
      existing.embedding_dimensions !== (input.embedding?.length ?? null) ||
      !sameVector(existing.embedding, input.embedding)
    ) {
      throw new ChunkIdentityConflictError(input.chunk_id);
    }
  }
}

export class PostgresLexicalRetriever implements Retriever {
  readonly id: string;
  readonly stage = "lexical" as const;
  private readonly db: Kysely<QuestLabDatabase>;
  private readonly logicalName: string;

  constructor(
    db: Kysely<QuestLabDatabase>,
    id = "postgres.fts.simple.v1",
    logicalName = "memory.hybrid",
  ) {
    this.db = db;
    this.id = id;
    this.logicalName = logicalName;
  }

  async retrieve(call: RetrieverCall): Promise<readonly RetrievalHit[]> {
    call.signal?.throwIfAborted();
    const access = readableMemoryPredicate(call.principal);
    const filters = retrievalFilterPredicate(call.filters);
    const result = await sql<MemorySearchRow>`
      WITH query AS (SELECT websearch_to_tsquery('simple', ${call.query}) AS value)
      SELECT
        chunk.chunk_id,
        chunk.content,
        chunk.token_count,
        chunk.source_type,
        chunk.entity_keys,
        chunk.citation_artifact_id,
        chunk.citation_uri,
        chunk.citation_digest,
        chunk.citation_locator,
        ts_rank_cd(chunk.search_vector, query.value)::double precision AS score
      FROM questlab.memory_chunk AS chunk
      JOIN questlab.memory_record AS memory ON memory.memory_id = chunk.memory_id
      JOIN questlab.retrieval_index_version AS index_version
        ON index_version.index_version_id = chunk.index_version_id
      CROSS JOIN query
      WHERE memory.status = 'active'
        AND index_version.status = 'active'
        AND (memory.scope = 'public' OR index_version.tenant_id = ${call.principal.tenant_id})
        AND index_version.logical_name = ${this.logicalName}
        AND chunk.chunk_level = 'child'
        AND chunk.search_vector @@ query.value
        AND ${access}
        AND ${filters}
      ORDER BY score DESC, chunk.chunk_id ASC
      LIMIT ${call.max_results}
    `.execute(this.db);
    call.signal?.throwIfAborted();
    return result.rows.map((row) => toHit(row, normalizeLexicalScore(Number(row.score))));
  }
}

export class PostgresBuildingIndexQualityEvaluator {
  private readonly db: Kysely<QuestLabDatabase>;

  constructor(db: Kysely<QuestLabDatabase>) {
    this.db = db;
  }

  async search(input: {
    readonly task: IndexBuildTask;
    readonly evaluation_case: IndexEvaluationCase;
  }): Promise<readonly PostgresIndexQualityEvaluationHit[]> {
    const evaluationCase = input.evaluation_case;
    if (!evaluationCase.query.trim() || !evaluationCase.purpose.trim()) {
      throw new PostgresRetrievalPolicyError("Building-index evaluation requires a query and purpose");
    }
    if (evaluationCase.principal.tenant_id !== input.task.tenant_id) {
      throw new PostgresRetrievalPolicyError("Building-index evaluation principal must belong to the build tenant");
    }
    const version = await this.db
      .selectFrom("questlab.retrieval_index_version")
      .select(["tenant_id", "logical_name", "configuration_digest", "source_watermark", "status"])
      .where("index_version_id", "=", input.task.index_version_id)
      .executeTakeFirst();
    if (!version || version.status !== "building") {
      throw new PostgresRetrievalPolicyError("Index quality evaluation may only read its building index version");
    }
    if (
      version.tenant_id !== input.task.tenant_id ||
      version.logical_name !== input.task.logical_name ||
      version.configuration_digest !== input.task.configuration_digest ||
      version.source_watermark !== input.task.source_watermark
    ) {
      throw new PostgresRetrievalPolicyError("Building index identity does not match the quality evaluation task");
    }

    const access = readableMemoryPredicate(evaluationCase.principal);
    if (evaluationCase.stage === "lexical") {
      if (evaluationCase.query_embedding || evaluationCase.embedding_model) {
        throw new PostgresRetrievalPolicyError("Lexical evaluation cases cannot carry an embedding snapshot");
      }
      return this.searchLexical(input, access);
    }
    if (
      !evaluationCase.query_embedding ||
      !evaluationCase.embedding_model ||
      !input.task.embedding_model ||
      input.task.embedding_model !== evaluationCase.embedding_model ||
      input.task.embedding_dimensions !== evaluationCase.query_embedding.length
    ) {
      throw new PostgresRetrievalPolicyError("Vector evaluation embedding snapshot does not match the build task");
    }
    validateVector(evaluationCase.query_embedding);
    if (evaluationCase.stage === "vector" && !["vector", "hybrid"].includes(input.task.index_kind)) {
      throw new PostgresRetrievalPolicyError("Vector evaluation requires a vector-capable index build");
    }
    if (evaluationCase.stage === "hybrid" && input.task.index_kind !== "hybrid") {
      throw new PostgresRetrievalPolicyError("Hybrid evaluation requires a hybrid index build");
    }
    return this.searchVectorOrHybrid(input, access, evaluationCase.stage === "hybrid");
  }

  private async searchLexical(
    input: { readonly task: IndexBuildTask; readonly evaluation_case: IndexEvaluationCase },
    access: RawBuilder<boolean>,
  ): Promise<readonly PostgresIndexQualityEvaluationHit[]> {
    const evaluationCase = input.evaluation_case;
    const result = await sql<IndexQualitySearchRow>`
      WITH query AS (SELECT websearch_to_tsquery('simple', ${evaluationCase.query}) AS value)
      SELECT
        chunk.chunk_id,
        chunk.memory_id,
        chunk.content,
        chunk.token_count,
        chunk.source_type,
        chunk.entity_keys,
        chunk.citation_artifact_id,
        chunk.citation_uri,
        chunk.citation_digest,
        chunk.citation_locator,
        ts_rank_cd(chunk.search_vector, query.value)::double precision AS score
      FROM questlab.memory_chunk AS chunk
      JOIN questlab.memory_record AS memory ON memory.memory_id = chunk.memory_id
      CROSS JOIN query
      WHERE chunk.index_version_id = ${input.task.index_version_id}
        AND chunk.chunk_level = 'child'
        AND memory.status = 'active'
        AND chunk.search_vector @@ query.value
        AND ${access}
      ORDER BY score DESC, chunk.chunk_id ASC
      LIMIT ${evaluationCase.max_results}
    `.execute(this.db);
    return result.rows.map((row) => ({
      chunk_id: row.chunk_id,
      memory_id: row.memory_id,
      score: normalizeLexicalScore(Number(row.score)),
      citation: {
        artifact_id: row.citation_artifact_id,
        uri: row.citation_uri,
        digest: row.citation_digest as `sha256:${string}`,
        ...(Object.keys(row.citation_locator).length > 0 ? { locator: row.citation_locator } : {}),
      },
    }));
  }

  private async searchVectorOrHybrid(
    input: { readonly task: IndexBuildTask; readonly evaluation_case: IndexEvaluationCase },
    access: RawBuilder<boolean>,
    hybrid: boolean,
  ): Promise<readonly PostgresIndexQualityEvaluationHit[]> {
    const evaluationCase = input.evaluation_case;
    const queryVector = vectorLiteral(evaluationCase.query_embedding!);
    const result = hybrid
      ? await sql<IndexQualitySearchRow & { readonly lexical_score: number; readonly vector_score: number }>`
          WITH query AS (SELECT websearch_to_tsquery('simple', ${evaluationCase.query}) AS value), candidates AS (
            SELECT
              chunk.chunk_id,
              chunk.memory_id,
              chunk.citation_artifact_id,
              chunk.citation_uri,
              chunk.citation_digest,
              chunk.citation_locator,
              ts_rank_cd(chunk.search_vector, query.value)::double precision AS lexical_score,
              greatest(0, least(1, 1 - ((chunk.embedding <=> ${queryVector}::vector) / 2)))::double precision AS vector_score
            FROM questlab.memory_chunk AS chunk
            JOIN questlab.memory_record AS memory ON memory.memory_id = chunk.memory_id
            CROSS JOIN query
            WHERE chunk.index_version_id = ${input.task.index_version_id}
              AND chunk.chunk_level = 'child'
              AND memory.status = 'active'
              AND chunk.embedding IS NOT NULL
              AND chunk.embedding_model = ${evaluationCase.embedding_model!}
              AND chunk.embedding_dimensions = ${evaluationCase.query_embedding!.length}
              AND ${access}
          )
          SELECT *, greatest(0, least(1, ((CASE WHEN lexical_score <= 0 THEN 0 ELSE lexical_score / (1 + lexical_score) END) * 0.5) + (vector_score * 0.5)))::double precision AS score
          FROM candidates
          ORDER BY score DESC, chunk_id ASC
          LIMIT ${evaluationCase.max_results}
        `.execute(this.db)
      : await sql<IndexQualitySearchRow>`
          SELECT
            chunk.chunk_id,
            chunk.memory_id,
            chunk.citation_artifact_id,
            chunk.citation_uri,
            chunk.citation_digest,
            chunk.citation_locator,
            greatest(0, least(1, 1 - ((chunk.embedding <=> ${queryVector}::vector) / 2)))::double precision AS score
          FROM questlab.memory_chunk AS chunk
          JOIN questlab.memory_record AS memory ON memory.memory_id = chunk.memory_id
          WHERE chunk.index_version_id = ${input.task.index_version_id}
            AND chunk.chunk_level = 'child'
            AND memory.status = 'active'
            AND chunk.embedding IS NOT NULL
            AND chunk.embedding_model = ${evaluationCase.embedding_model!}
            AND chunk.embedding_dimensions = ${evaluationCase.query_embedding!.length}
            AND ${access}
          ORDER BY score DESC, chunk.chunk_id ASC
          LIMIT ${evaluationCase.max_results}
        `.execute(this.db);
    return result.rows.map((row) => ({
      chunk_id: row.chunk_id,
      memory_id: row.memory_id,
      score: Number(row.score),
      citation: {
        artifact_id: row.citation_artifact_id,
        uri: row.citation_uri,
        digest: row.citation_digest as `sha256:${string}`,
        ...(Object.keys(row.citation_locator).length > 0 ? { locator: row.citation_locator } : {}),
      },
    }));
  }
}

export class PostgresVectorRetriever implements Retriever {
  readonly id: string;
  readonly stage = "vector" as const;
  private readonly options: PostgresVectorRetrieverOptions;

  constructor(options: PostgresVectorRetrieverOptions) {
    this.options = options;
    this.id = options.id ?? `postgres.pgvector.${options.embedding_model}`;
  }

  async retrieve(call: RetrieverCall): Promise<readonly RetrievalHit[]> {
    call.signal?.throwIfAborted();
    const result = await this.options.embeddings.embed({
      request_id: `${call.query_id}:vector`,
      workload: "retrieval.query.embed",
      inputs: [call.query],
      budget: this.options.embedding_budget,
      ...(call.signal ? { signal: call.signal } : {}),
    });
    const vector = result.vectors[0];
    if (!vector || result.vectors.length !== 1) {
      throw new PostgresRetrievalPolicyError("Embedding provider must return exactly one query vector");
    }
    validateVector(vector);

    const access = readableMemoryPredicate(call.principal);
    const filters = retrievalFilterPredicate(call.filters);
    const literal = vectorLiteral(vector);
    const rows = await sql<MemorySearchRow>`
      WITH candidates AS MATERIALIZED (
        SELECT
          chunk.chunk_id,
          chunk.content,
          chunk.token_count,
          chunk.source_type,
          chunk.entity_keys,
          chunk.citation_artifact_id,
          chunk.citation_uri,
          chunk.citation_digest,
          chunk.citation_locator,
          chunk.embedding
        FROM questlab.memory_chunk AS chunk
        JOIN questlab.memory_record AS memory ON memory.memory_id = chunk.memory_id
        JOIN questlab.retrieval_index_version AS index_version
          ON index_version.index_version_id = chunk.index_version_id
        WHERE memory.status = 'active'
          AND index_version.status = 'active'
          AND (memory.scope = 'public' OR index_version.tenant_id = ${call.principal.tenant_id})
          AND index_version.logical_name = ${this.options.logical_name ?? "memory.hybrid"}
          AND chunk.chunk_level = 'child'
          AND chunk.embedding IS NOT NULL
          AND chunk.embedding_model = ${this.options.embedding_model}
          AND chunk.embedding_dimensions = ${vector.length}
          AND ${access}
          AND ${filters}
      )
      SELECT
        candidates.chunk_id,
        candidates.content,
        candidates.token_count,
        candidates.source_type,
        candidates.entity_keys,
        candidates.citation_artifact_id,
        candidates.citation_uri,
        candidates.citation_digest,
        candidates.citation_locator,
        greatest(0, least(1, 1 - ((candidates.embedding <=> ${literal}::vector) / 2)))::double precision AS score
      FROM candidates
      ORDER BY candidates.embedding <=> ${literal}::vector, candidates.chunk_id ASC
      LIMIT ${call.max_results}
    `.execute(this.options.db);
    call.signal?.throwIfAborted();
    return rows.rows.map((row) => toHit(row, Number(row.score)));
  }
}

export class PostgresMemoryAuthorization implements RetrievalAuthorizationPort {
  private readonly db: Kysely<QuestLabDatabase>;
  private readonly logicalName: string;

  constructor(db: Kysely<QuestLabDatabase>, logicalName = "memory.hybrid") {
    this.db = db;
    this.logicalName = logicalName;
  }

  async canRead(input: {
    readonly principal: RetrievalPrincipal;
    readonly purpose: string;
    readonly hit: RetrievalHit;
  }): Promise<boolean> {
    if (!input.purpose.trim()) return false;
    const result = await sql<{ readonly chunk_id: string }>`
      SELECT chunk.chunk_id
      FROM questlab.memory_chunk AS chunk
      JOIN questlab.memory_record AS memory ON memory.memory_id = chunk.memory_id
      JOIN questlab.retrieval_index_version AS index_version
        ON index_version.index_version_id = chunk.index_version_id
      WHERE chunk.chunk_id = ${input.hit.id}
        AND chunk.citation_artifact_id = ${input.hit.citation.artifact_id}
        AND chunk.citation_uri = ${input.hit.citation.uri}
        AND chunk.citation_digest = ${input.hit.citation.digest}
        AND memory.status = 'active'
        AND index_version.status = 'active'
        AND (memory.scope = 'public' OR index_version.tenant_id = ${input.principal.tenant_id})
        AND index_version.logical_name = ${this.logicalName}
        AND ${readableMemoryPredicate(input.principal)}
      LIMIT 1
    `.execute(this.db);
    return result.rows.length === 1;
  }
}

export class PostgresStructuredEventAggregator implements StructuredAggregatorPort {
  private readonly memories: Pick<MemoryRepository, "aggregateReadableEvents" | "listReadableEvents" | "listReadableEdges">;
  private readonly maxGraphEdges: number;

  constructor(db: Kysely<QuestLabDatabase>, options: { readonly max_graph_edges?: number } = {}) {
    this.memories = new MemoryRepository(db);
    this.maxGraphEdges = options.max_graph_edges ?? 5_000;
    if (!Number.isInteger(this.maxGraphEdges) || this.maxGraphEdges < 1 || this.maxGraphEdges > 20_000) {
      throw new PostgresRetrievalPolicyError("max_graph_edges must be between 1 and 20000");
    }
  }

  async aggregate(input: { readonly request: RetrievalRequest; readonly signal?: AbortSignal }): Promise<StructuredResult> {
    input.signal?.throwIfAborted();
    if (input.request.intent === "count_events") return this.countEvents(input);
    if (input.request.intent === "comparison") return this.compareEventCounts(input);
    if (input.request.intent === "temporal") return this.selectEventTime(input);
    if (input.request.intent === "multi_hop") return this.findRelationPath(input);
    throw new PostgresRetrievalPolicyError(`Structured intent ${input.request.intent} is not implemented`);
  }

  private async countEvents(input: { readonly request: RetrievalRequest; readonly signal?: AbortSignal }): Promise<StructuredResult> {
    const filters = input.request.structured_filters;
    if (!filters?.subject_id || !filters.event_type) throw new PostgresRetrievalPolicyError("count_events requires structured_filters.subject_id and event_type");
    const includeConflicts = filters.include_conflicts ?? false;
    const result = await this.memories.aggregateReadableEvents(input.request.principal, eventQuery({
      subject_id: filters.subject_id,
      event_type: filters.event_type,
      ...(filters.from ? { from: filters.from } : {}),
      ...(filters.to ? { to: filters.to } : {}),
      include_conflicts: includeConflicts,
    }));
    input.signal?.throwIfAborted();
    return {
      operation: "count_distinct", value: result.value, included_ids: result.included_event_ids,
      excluded_reasons: !includeConflicts && result.excluded_conflict_count > 0 ? [`${result.excluded_conflict_count} conflicting events excluded`] : [],
      conflicts: result.conflict_event_ids,
    };
  }

  private async compareEventCounts(input: { readonly request: RetrievalRequest; readonly signal?: AbortSignal }): Promise<StructuredResult> {
    const query = input.request.structured_query;
    if (!query || query.kind !== "compare_event_counts" || query.left_subject_id === query.right_subject_id) {
      throw new PostgresRetrievalPolicyError("comparison requires two different subjects and compare_event_counts query");
    }
    const includeConflicts = query.include_conflicts ?? false;
    const common = {
      event_type: query.event_type,
      ...(query.from ? { from: query.from } : {}),
      ...(query.to ? { to: query.to } : {}),
      include_conflicts: includeConflicts,
    };
    const leftQuery = eventQuery({ ...common, subject_id: query.left_subject_id });
    const rightQuery = eventQuery({ ...common, subject_id: query.right_subject_id });
    const [leftRows, rightRows] = await Promise.all([
      this.memories.listReadableEvents(input.request.principal, leftQuery),
      this.memories.listReadableEvents(input.request.principal, rightQuery),
    ]);
    input.signal?.throwIfAborted();
    const left = summarizeEvents(leftRows, includeConflicts);
    const right = summarizeEvents(rightRows, includeConflicts);
    const conflicts = uniqueStrings([...left.conflictIds, ...right.conflictIds]);
    const excluded = left.excludedConflicts + right.excludedConflicts;
    return {
      operation: "comparison",
      value: left.included.length - right.included.length,
      included_ids: uniqueStrings([...left.included.map((event) => event.event_id), ...right.included.map((event) => event.event_id)]),
      excluded_reasons: excluded > 0 ? [`${excluded} conflicting events excluded`] : [],
      conflicts,
      details: {
        kind: "comparison_counts",
        left_subject_id: query.left_subject_id,
        left_value: left.included.length,
        right_subject_id: query.right_subject_id,
        right_value: right.included.length,
        difference: left.included.length - right.included.length,
      },
    };
  }

  private async selectEventTime(input: { readonly request: RetrievalRequest; readonly signal?: AbortSignal }): Promise<StructuredResult> {
    const query = input.request.structured_query;
    if (!query || query.kind !== "select_event_time" || (query.selector !== "first" && query.selector !== "last")) {
      throw new PostgresRetrievalPolicyError("temporal requires a first/last select_event_time query");
    }
    const includeConflicts = query.include_conflicts ?? false;
    const rows = await this.memories.listReadableEvents(input.request.principal, eventQuery(query));
    input.signal?.throwIfAborted();
    const summary = summarizeEvents(rows, includeConflicts);
    const selected = query.selector === "first" ? summary.included[0] : summary.included.at(-1);
    return {
      operation: "temporal",
      value: selected?.occurred_from.toISOString() ?? null,
      included_ids: selected ? [selected.event_id] : [],
      excluded_reasons: summary.excludedConflicts > 0 ? [`${summary.excludedConflicts} conflicting events excluded`] : [],
      conflicts: summary.conflictIds,
      details: {
        kind: "temporal_event", subject_id: query.subject_id, event_type: query.event_type, selector: query.selector,
        event_id: selected?.event_id ?? null, occurred_from: selected?.occurred_from.toISOString() ?? null,
        occurred_to: selected?.occurred_to?.toISOString() ?? null,
      },
    };
  }

  private async findRelationPath(input: { readonly request: RetrievalRequest; readonly signal?: AbortSignal }): Promise<StructuredResult> {
    const query = input.request.structured_query;
    if (!query || query.kind !== "find_relation_path" || !validStructuredIdentifier(query.start_node_id) ||
      !validStructuredIdentifier(query.target_node_id) || query.start_node_id === query.target_node_id ||
      !["outbound", "inbound", "both"].includes(query.direction) || !Number.isInteger(query.max_hops) || query.max_hops < 1 || query.max_hops > 6) {
      throw new PostgresRetrievalPolicyError("multi_hop requires a valid bounded find_relation_path query");
    }
    if (query.predicates && (query.predicates.length < 1 || query.predicates.length > 32 ||
      new Set(query.predicates).size !== query.predicates.length || query.predicates.some((predicate) => !validStructuredIdentifier(predicate)))) {
      throw new PostgresRetrievalPolicyError("multi_hop predicates must be 1-32 unique identifiers");
    }
    const asOf = parseInstant(query.as_of, "as_of");
    const rows = await this.memories.listReadableEdges(input.request.principal, {
      as_of: asOf,
      ...(query.predicates ? { predicates: query.predicates } : {}),
      limit: this.maxGraphEdges + 1,
    });
    input.signal?.throwIfAborted();
    if (rows.length > this.maxGraphEdges) throw new PostgresRetrievalPolicyError("Readable relation graph exceeds the governed edge limit");
    const path = findDeterministicRelationPath(rows, {
      start_node_id: query.start_node_id,
      target_node_id: query.target_node_id,
      direction: query.direction,
      max_hops: query.max_hops,
      include_conflicts: query.include_conflicts ?? false,
    });
    return {
      operation: "path",
      value: path.found ? path.path_hops.length : null,
      included_ids: path.path_hops.map((hop) => hop.edge_id),
      excluded_reasons: path.excluded_conflict_count > 0 ? [`${path.excluded_conflict_count} conflicting edges excluded`] : [],
      conflicts: path.conflict_ids,
      details: {
        kind: "relation_path",
        start_node_id: query.start_node_id,
        target_node_id: query.target_node_id,
        direction: query.direction,
        found: path.found,
        hop_count: path.found ? path.path_hops.length : null,
        node_ids: path.node_ids,
        path_hops: path.path_hops,
      },
    };
  }
}

export interface RelationPathHop {
  readonly edge_id: string;
  readonly from_node_id: string;
  readonly to_node_id: string;
  readonly predicate: string;
}

export function findDeterministicRelationPath(edges: readonly StructuredEdge[], query: {
  readonly start_node_id: string;
  readonly target_node_id: string;
  readonly direction: "outbound" | "inbound" | "both";
  readonly max_hops: number;
  readonly include_conflicts: boolean;
}): { readonly found: boolean; readonly node_ids: readonly string[]; readonly path_hops: readonly RelationPathHop[]; readonly conflict_ids: readonly string[]; readonly excluded_conflict_count: number } {
  const unique = new Map<string, StructuredEdge>();
  const ordered = [...edges].sort((left, right) =>
    left.source_node_id.localeCompare(right.source_node_id) || left.predicate.localeCompare(right.predicate) ||
    left.target_node_id.localeCompare(right.target_node_id) || left.edge_id.localeCompare(right.edge_id));
  for (const edge of ordered) if (!unique.has(edge.dedupe_key)) unique.set(edge.dedupe_key, edge);
  const queue: { readonly node: string; readonly nodes: readonly string[]; readonly hops: readonly RelationPathHop[] }[] = [
    { node: query.start_node_id, nodes: [query.start_node_id], hops: [] },
  ];
  const visited = new Set([query.start_node_id]);
  const conflicts = new Set<string>();
  let excludedConflictCount = 0;
  let foundPath: { readonly nodes: readonly string[]; readonly hops: readonly RelationPathHop[] } | undefined;
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.hops.length >= query.max_hops) continue;
    for (const edge of unique.values()) {
      const traversal = edgeTraversal(edge, current.node, query.direction);
      if (!traversal) continue;
      if (edge.conflict_status !== "none") {
        const alreadySeen = conflicts.has(edge.edge_id);
        conflicts.add(edge.edge_id);
        if (!query.include_conflicts) {
          if (!alreadySeen) excludedConflictCount += 1;
          continue;
        }
      }
      if (visited.has(traversal.to_node_id)) continue;
      const hop = { edge_id: edge.edge_id, from_node_id: current.node, to_node_id: traversal.to_node_id, predicate: edge.predicate };
      const hops = [...current.hops, hop];
      const nodes = [...current.nodes, traversal.to_node_id];
      if (traversal.to_node_id === query.target_node_id) {
        foundPath ??= { nodes, hops };
        visited.add(traversal.to_node_id);
        continue;
      }
      visited.add(traversal.to_node_id);
      queue.push({ node: traversal.to_node_id, nodes, hops });
    }
  }
  if (foundPath) return { found: true, node_ids: foundPath.nodes, path_hops: foundPath.hops, conflict_ids: [...conflicts], excluded_conflict_count: excludedConflictCount };
  return { found: false, node_ids: [], path_hops: [], conflict_ids: [...conflicts], excluded_conflict_count: excludedConflictCount };
}

function edgeTraversal(edge: StructuredEdge, nodeId: string, direction: "outbound" | "inbound" | "both"): { readonly to_node_id: string } | undefined {
  if ((direction === "outbound" || direction === "both" || edge.direction === "bidirectional") && edge.source_node_id === nodeId) {
    return { to_node_id: edge.target_node_id };
  }
  if ((direction === "inbound" || direction === "both" || edge.direction === "bidirectional") && edge.target_node_id === nodeId) {
    return { to_node_id: edge.source_node_id };
  }
  return undefined;
}

function eventQuery(input: { readonly subject_id: string; readonly event_type: string; readonly from?: string; readonly to?: string; readonly include_conflicts?: boolean }) {
  if (!validStructuredIdentifier(input.subject_id) || !validStructuredIdentifier(input.event_type)) {
    throw new PostgresRetrievalPolicyError("subject_id and event_type must be non-empty identifiers");
  }
  const from = input.from ? parseInstant(input.from, "from") : undefined;
  const to = input.to ? parseInstant(input.to, "to") : undefined;
  if (from && to && from.getTime() > to.getTime()) {
    throw new PostgresRetrievalPolicyError("from must not be after to");
  }
  return {
    subject_id: input.subject_id, event_type: input.event_type,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    include_conflicts: input.include_conflicts ?? false,
  };
}

function validStructuredIdentifier(value: string): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
}

function summarizeEvents(rows: readonly StructuredEvent[], includeConflicts: boolean): {
  readonly included: readonly StructuredEvent[]; readonly conflictIds: readonly string[]; readonly excludedConflicts: number;
} {
  const conflictIds = rows.filter((event) => event.conflict_status !== "none").map((event) => event.event_id);
  const unique = new Map<string, StructuredEvent>();
  for (const event of rows) {
    if ((includeConflicts || event.conflict_status === "none") && !unique.has(event.dedupe_key)) {
      unique.set(event.dedupe_key, event);
    }
  }
  return { included: [...unique.values()], conflictIds, excludedConflicts: includeConflicts ? 0 : conflictIds.length };
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function parseInstant(value: string, name: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new PostgresRetrievalPolicyError(`${name} must be an ISO timestamp`);
  return parsed;
}

export class PostgresRelationExpansionCandidateSource implements EvidenceExpansionCandidateSource {
  private readonly db: Kysely<QuestLabDatabase>;
  private readonly logicalName: string;
  private readonly regionLocatorKey: string;
  private readonly temporalLocatorKey: string;

  constructor(options: PostgresRelationExpansionCandidateSourceOptions) {
    this.db = options.db;
    this.logicalName = options.logical_name ?? "memory.hybrid";
    this.regionLocatorKey = options.region_locator_key ?? "region_id";
    this.temporalLocatorKey = options.temporal_locator_key ?? "started_at";
    if (!this.logicalName.trim() || !this.regionLocatorKey.trim() || !this.temporalLocatorKey.trim()) {
      throw new PostgresRetrievalPolicyError("Relation expansion keys and logical index name are required");
    }
  }

  async listCandidates(input: {
    readonly hits: readonly RetrievalHit[];
    readonly principal: RetrievalPrincipal;
    readonly purpose: string;
    readonly max_candidates_per_anchor: number;
    readonly signal?: AbortSignal;
  }): Promise<readonly EvidenceExpansionCandidate[]> {
    input.signal?.throwIfAborted();
    if (
      !input.purpose.trim() ||
      !Number.isInteger(input.max_candidates_per_anchor) ||
      input.max_candidates_per_anchor < 1 ||
      input.max_candidates_per_anchor > 100
    ) {
      throw new PostgresRetrievalPolicyError("Relation expansion requires purpose and a bounded candidate limit");
    }
    if (input.hits.length === 0) return [];
    const anchorIds = [...new Set(input.hits.map((hit) => hit.id))];
    const access = readableMemoryPredicate(input.principal);
    const rows = await sql<RelationExpansionRow>`
      WITH anchors AS (
        SELECT
          chunk.chunk_id AS anchor_id,
          chunk.memory_id,
          chunk.index_version_id,
          chunk.ordinal,
          chunk.entity_keys,
          chunk.citation_locator
        FROM questlab.memory_chunk AS chunk
        WHERE chunk.chunk_id IN (${sql.join(anchorIds)})
      ), ranked AS (
        SELECT
          anchor.anchor_id,
          CASE
            WHEN candidate.citation_locator ->> ${this.regionLocatorKey} IS NOT NULL
              AND candidate.citation_locator ->> ${this.regionLocatorKey}
                = anchor.citation_locator ->> ${this.regionLocatorKey}
              THEN 'region'
            WHEN abs(candidate.ordinal - anchor.ordinal) = 1 THEN 'neighbor'
            WHEN candidate.entity_keys && anchor.entity_keys THEN 'entity'
            ELSE 'temporal'
          END AS relation,
          CASE
            WHEN candidate.citation_locator ->> ${this.regionLocatorKey} IS NOT NULL
              AND candidate.citation_locator ->> ${this.regionLocatorKey}
                = anchor.citation_locator ->> ${this.regionLocatorKey}
              THEN 1.0
            WHEN abs(candidate.ordinal - anchor.ordinal) = 1 THEN 0.8
            WHEN candidate.entity_keys && anchor.entity_keys THEN 0.6
            ELSE 0.4
          END AS relation_score,
          candidate.chunk_id,
          candidate.content,
          candidate.token_count,
          candidate.source_type,
          candidate.entity_keys,
          candidate.citation_artifact_id,
          candidate.citation_uri,
          candidate.citation_digest,
          candidate.citation_locator,
          row_number() OVER (
            PARTITION BY anchor.anchor_id
            ORDER BY
              CASE
                WHEN candidate.citation_locator ->> ${this.regionLocatorKey} IS NOT NULL
                  AND candidate.citation_locator ->> ${this.regionLocatorKey}
                    = anchor.citation_locator ->> ${this.regionLocatorKey}
                  THEN 1
                WHEN abs(candidate.ordinal - anchor.ordinal) = 1 THEN 2
                WHEN candidate.entity_keys && anchor.entity_keys THEN 3
                ELSE 4
              END,
              candidate.chunk_id
          ) AS candidate_rank
        FROM anchors AS anchor
        JOIN questlab.memory_chunk AS candidate
          ON candidate.memory_id = anchor.memory_id
          AND candidate.index_version_id = anchor.index_version_id
          AND candidate.chunk_id <> anchor.anchor_id
        JOIN questlab.memory_record AS memory ON memory.memory_id = candidate.memory_id
        JOIN questlab.retrieval_index_version AS index_version
          ON index_version.index_version_id = candidate.index_version_id
        WHERE candidate.chunk_level = 'child'
          AND memory.status = 'active'
          AND index_version.status = 'active'
          AND (memory.scope = 'public' OR index_version.tenant_id = ${input.principal.tenant_id})
          AND index_version.logical_name = ${this.logicalName}
          AND ${access}
          AND (
            (
              candidate.citation_locator ->> ${this.regionLocatorKey} IS NOT NULL
              AND candidate.citation_locator ->> ${this.regionLocatorKey}
                = anchor.citation_locator ->> ${this.regionLocatorKey}
            )
            OR abs(candidate.ordinal - anchor.ordinal) = 1
            OR candidate.entity_keys && anchor.entity_keys
            OR (
              candidate.citation_locator ->> ${this.temporalLocatorKey} IS NOT NULL
              AND candidate.citation_locator ->> ${this.temporalLocatorKey}
                = anchor.citation_locator ->> ${this.temporalLocatorKey}
            )
          )
      )
      SELECT
        anchor_id,
        relation,
        relation_score,
        chunk_id,
        content,
        token_count,
        source_type,
        entity_keys,
        citation_artifact_id,
        citation_uri,
        citation_digest,
        citation_locator
      FROM ranked
      WHERE candidate_rank <= ${input.max_candidates_per_anchor}
      ORDER BY anchor_id, candidate_rank
    `.execute(this.db);
    input.signal?.throwIfAborted();
    return rows.rows.map((row) => ({
      anchor_id: row.anchor_id,
      relation: row.relation,
      hit: toHit(row, Number(row.relation_score)),
    }));
  }
}

export class PostgresParentChildExpander implements EvidenceExpansionPort {
  private readonly db: Kysely<QuestLabDatabase>;
  private readonly logicalName: string;

  constructor(db: Kysely<QuestLabDatabase>, logicalName = "memory.hybrid") {
    this.db = db;
    this.logicalName = logicalName;
  }

  async expand(input: {
    readonly hits: readonly RetrievalHit[];
    readonly principal: RetrievalPrincipal;
    readonly purpose: string;
    readonly max_tokens: number;
    readonly signal?: AbortSignal;
  }): Promise<readonly RetrievalHit[]> {
    input.signal?.throwIfAborted();
    if (!input.purpose.trim() || !Number.isInteger(input.max_tokens) || input.max_tokens <= 0) {
      throw new PostgresRetrievalPolicyError("Parent expansion requires purpose and a positive token budget");
    }
    if (input.hits.length === 0) return [];
    const childIds = [...new Set(input.hits.map((hit) => hit.id))];
    const access = readableMemoryPredicate(input.principal);
    const rows = await sql<ParentExpansionRow>`
      SELECT
        child.chunk_id AS child_id,
        parent.chunk_id,
        parent.content,
        parent.token_count,
        parent.source_type,
        parent.entity_keys,
        parent.citation_artifact_id,
        parent.citation_uri,
        parent.citation_digest,
        parent.citation_locator
      FROM questlab.memory_chunk AS child
      JOIN questlab.memory_chunk AS parent
        ON parent.chunk_id = child.parent_chunk_id
        AND parent.memory_id = child.memory_id
        AND parent.index_version_id = child.index_version_id
      JOIN questlab.memory_record AS memory ON memory.memory_id = parent.memory_id
      JOIN questlab.retrieval_index_version AS index_version
        ON index_version.index_version_id = parent.index_version_id
      WHERE child.chunk_id IN (${sql.join(childIds)})
        AND child.chunk_level = 'child'
        AND parent.chunk_level = 'parent'
        AND memory.status = 'active'
        AND index_version.status = 'active'
        AND (memory.scope = 'public' OR index_version.tenant_id = ${input.principal.tenant_id})
        AND index_version.logical_name = ${this.logicalName}
        AND ${access}
    `.execute(this.db);
    input.signal?.throwIfAborted();
    const parentByChild = new Map(rows.rows.map((row) => [row.child_id, row]));
    const expanded = new Map<string, RetrievalHit>();
    let usedTokens = 0;
    for (const child of input.hits) {
      const parent = parentByChild.get(child.id);
      const parentHit = parent ? toHit(parent, child.score) : undefined;
      const existingParent = parentHit ? expanded.get(parentHit.id) : undefined;
      if (existingParent && parentHit) {
        if (parentHit.score > existingParent.score) expanded.set(parentHit.id, { ...existingParent, score: parentHit.score });
        continue;
      }
      const candidate = parentHit && parentHit.token_count <= input.max_tokens - usedTokens ? parentHit : child;
      const existing = expanded.get(candidate.id);
      if (existing) {
        if (candidate.score > existing.score) expanded.set(candidate.id, { ...existing, score: candidate.score });
        continue;
      }
      if (candidate.token_count > input.max_tokens - usedTokens) continue;
      expanded.set(candidate.id, candidate);
      usedTokens += candidate.token_count;
    }
    return [...expanded.values()];
  }
}

function readableMemoryPredicate(principal: RetrievalPrincipal): RawBuilder<boolean> {
  const direct: RawBuilder<boolean>[] = [
    sql<boolean>`memory.scope = 'public'`,
    sql<boolean>`(memory.scope = 'tenant' AND memory.owner_id = ${principal.tenant_id})`,
  ];
  if (principal.user_id) {
    direct.push(sql<boolean>`(memory.scope = 'user_private' AND memory.owner_id = ${principal.user_id})`);
  }
  if (principal.agent_id) {
    direct.push(sql<boolean>`(memory.scope = 'agent_private' AND memory.owner_id = ${principal.agent_id})`);
  }
  if (principal.session_id) {
    direct.push(sql<boolean>`(memory.scope = 'session' AND memory.owner_id = ${principal.session_id})`);
  }
  const identities: ReadonlyArray<readonly [string, string]> = [
    ["tenant", principal.tenant_id],
    ...(principal.user_id ? ([["user", principal.user_id]] as const) : []),
    ...(principal.agent_id ? ([["agent", principal.agent_id]] as const) : []),
    ...(principal.session_id ? ([["session", principal.session_id]] as const) : []),
    ...(principal.role_ids ?? []).map((id) => ["role", id] as const),
  ];
  const grants = identities.map(
    ([type, id]) => sql<boolean>`(acl.principal_type = ${type} AND acl.principal_id = ${id})`,
  );
  return sql<boolean>`
    (memory.scope = 'public' OR memory.tenant_id = ${principal.tenant_id})
    AND (
      (${sql.join(direct, sql` OR `)})
      OR EXISTS (
        SELECT 1 FROM questlab.memory_acl AS acl
        WHERE acl.memory_id = memory.memory_id
          AND acl.permission = 'read'
          AND (${sql.join(grants, sql` OR `)})
      )
    )
  `;
}

function retrievalFilterPredicate(
  filters: Readonly<Record<string, string | number | boolean>>,
): RawBuilder<boolean> {
  const predicates: RawBuilder<boolean>[] = [];
  for (const [name, value] of Object.entries(filters)) {
    if (typeof value !== "string" || !value) {
      throw new PostgresRetrievalPolicyError(`Filter ${name} requires a non-empty string value`);
    }
    switch (name) {
      case "memory_id":
        predicates.push(sql<boolean>`chunk.memory_id = ${value}`);
        break;
      case "source_type":
        predicates.push(sql<boolean>`chunk.source_type = ${value}`);
        break;
      case "kind":
        predicates.push(sql<boolean>`memory.kind = ${value}`);
        break;
      case "stage":
        predicates.push(sql<boolean>`memory.stage = ${value}`);
        break;
      default:
        throw new PostgresRetrievalPolicyError(`Unsupported retrieval filter: ${name}`);
    }
  }
  return predicates.length > 0 ? sql<boolean>`(${sql.join(predicates, sql` AND `)})` : sql<boolean>`TRUE`;
}

function toHit(row: Omit<MemorySearchRow, "score">, score: number): RetrievalHit {
  return {
    id: row.chunk_id,
    content: row.content,
    score,
    token_count: row.token_count,
    source_type: row.source_type,
    entity_keys: row.entity_keys,
    citation: {
      artifact_id: row.citation_artifact_id,
      uri: row.citation_uri,
      digest: row.citation_digest as `sha256:${string}`,
      ...(Object.keys(row.citation_locator).length > 0 ? { locator: row.citation_locator } : {}),
    },
  };
}

function validateChunk(input: IndexMemoryChunkInput): void {
  if (!input.chunk_id || !input.memory_id || !input.index_version_id || !input.content.trim() || !input.source_type) {
    throw new PostgresRetrievalPolicyError("Chunk identity, memory, content and source type are required");
  }
  if (!Number.isInteger(input.ordinal) || input.ordinal < 0 || !Number.isInteger(input.token_count) || input.token_count <= 0) {
    throw new PostgresRetrievalPolicyError("Chunk ordinal and token count are invalid");
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(input.chunk_digest) || !/^sha256:[a-f0-9]{64}$/.test(input.citation.digest)) {
    throw new PostgresRetrievalPolicyError("Chunk and citation digests must be immutable SHA-256 values");
  }
  if (input.chunk_digest !== contentDigest(input.content)) {
    throw new PostgresRetrievalPolicyError("Chunk digest does not match its UTF-8 content");
  }
  if (!input.citation.artifact_id || !/^[a-z][a-z0-9+.-]*:/i.test(input.citation.uri)) {
    throw new PostgresRetrievalPolicyError("Chunk citations require an artifact identity and absolute URI");
  }
  if (new Set(input.entity_keys ?? []).size !== (input.entity_keys?.length ?? 0)) {
    throw new PostgresRetrievalPolicyError("Chunk entity keys must be unique");
  }
  const chunkLevel = input.chunk_level ?? "child";
  if (chunkLevel === "parent" && (input.parent_chunk_id || input.embedding || input.embedding_model)) {
    throw new PostgresRetrievalPolicyError("Parent Chunks cannot reference a parent or carry retrieval embeddings");
  }
  if (input.parent_chunk_id === input.chunk_id) {
    throw new PostgresRetrievalPolicyError("A Child Chunk cannot reference itself as parent");
  }
  if ((input.structure_path ?? []).some((part) => !part.trim())) {
    throw new PostgresRetrievalPolicyError("Chunk structure paths cannot contain empty segments");
  }
  if (Boolean(input.embedding) !== Boolean(input.embedding_model)) {
    throw new PostgresRetrievalPolicyError("Embedding vectors and model snapshots must be supplied together");
  }
  if (input.embedding_model !== undefined && !input.embedding_model.trim()) {
    throw new PostgresRetrievalPolicyError("Embedding model snapshots cannot be empty");
  }
  if (input.embedding) validateVector(input.embedding);
}

function validateVector(vector: readonly number[]): void {
  const squaredNorm = vector.reduce((sum, value) => sum + value * value, 0);
  if (
    vector.length === 0 ||
    vector.length > 4096 ||
    vector.some((value) => !Number.isFinite(value)) ||
    !Number.isFinite(squaredNorm) ||
    squaredNorm === 0
  ) {
    throw new PostgresRetrievalPolicyError("Embedding vectors must contain 1 to 4096 finite, non-zero values");
  }
}

function vectorLiteral(vector: readonly number[]): string {
  validateVector(vector);
  return `[${vector.join(",")}]`;
}

function normalizeLexicalScore(rank: number): number {
  return rank <= 0 ? 0 : rank / (1 + rank);
}

function contentDigest(content: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameVector(stored: string | null, candidate: readonly number[] | undefined): boolean {
  if (stored === null || candidate === undefined) return stored === null && candidate === undefined;
  const values = stored.slice(1, -1).split(",").map(Number);
  return values.length === candidate.length && values.every((value, index) => Math.abs(value - candidate[index]!) < 1e-6);
}

function stableObject(value: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))),
  );
}
