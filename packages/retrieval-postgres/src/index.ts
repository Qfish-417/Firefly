import { createHash } from "node:crypto";

import type { EvidenceCitation } from "@firefly/contracts";
import type { EmbeddingPort, ModelBudget } from "@firefly/model-gateway";
import type { QuestLabDatabase } from "@firefly/persistence";
import type {
  RetrievalAuthorizationPort,
  RetrievalHit,
  RetrievalPrincipal,
  Retriever,
  RetrieverCall,
} from "@firefly/retrieval-service";
import { sql, type Kysely, type RawBuilder } from "kysely";

export interface IndexMemoryChunkInput {
  readonly chunk_id: string;
  readonly memory_id: string;
  readonly ordinal: number;
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
      .select(["memory_id", "status"])
      .where("memory_id", "=", input.memory_id)
      .executeTakeFirst();
    if (!memory || memory.status !== "active") {
      throw new PostgresRetrievalPolicyError("Only an active source memory may be indexed");
    }

    const embedding = input.embedding
      ? sql<string>`${vectorLiteral(input.embedding)}::vector`
      : null;
    const inserted = await this.db
      .insertInto("questlab.memory_chunk")
      .values({
        chunk_id: input.chunk_id,
        memory_id: input.memory_id,
        ordinal: input.ordinal,
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
        "ordinal",
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
      existing.ordinal !== input.ordinal ||
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

  constructor(
    db: Kysely<QuestLabDatabase>,
    id = "postgres.fts.simple.v1",
  ) {
    this.db = db;
    this.id = id;
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
      CROSS JOIN query
      WHERE memory.status = 'active'
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
        WHERE memory.status = 'active'
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

  constructor(db: Kysely<QuestLabDatabase>) {
    this.db = db;
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
      WHERE chunk.chunk_id = ${input.hit.id}
        AND chunk.citation_artifact_id = ${input.hit.citation.artifact_id}
        AND chunk.citation_uri = ${input.hit.citation.uri}
        AND chunk.citation_digest = ${input.hit.citation.digest}
        AND memory.status = 'active'
        AND ${readableMemoryPredicate(input.principal)}
      LIMIT 1
    `.execute(this.db);
    return result.rows.length === 1;
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

function toHit(row: MemorySearchRow, score: number): RetrievalHit {
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
  if (!input.chunk_id || !input.memory_id || !input.content.trim() || !input.source_type) {
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
