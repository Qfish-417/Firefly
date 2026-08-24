import { sql, type Kysely } from "kysely";

/**
 * Optional ANN index for vector retrieval, created only when the embedding route is declared.
 *
 * `memory_chunk.embedding` is a dimensionless `VECTOR` so one table can hold several embedding
 * routes, and pgvector refuses to index such a column ("column does not have dimensions"). The only
 * indexable form is an expression index on `(embedding::<type>(N))`, which pins one specific
 * dimension. A migration therefore cannot hardcode N: the right value depends on the deployed
 * embedding model, and a wrong one produces an index that silently never matches.
 *
 * So this migration is configuration-driven and skips itself when unconfigured:
 *
 *   EMBEDDING_DIMENSIONS              required, 1..4000
 *   EMBEDDING_DISTANCE_ELEMENT_TYPE   optional, "vector" | "halfvec"
 *
 * Element type must match what `PostgresVectorRetriever` emits, or the planner cannot use the index.
 * pgvector caps an ANN index at 2000 dimensions for `vector` and 4000 for `halfvec`, because one
 * 8KB index page holds 2000 fp32 or 4000 fp16 components; no setting relaxes this. Above 2000 the
 * retriever defaults to `halfvec`, and so does this migration.
 *
 * `halfvec` narrows only the indexed copy to fp16; the column keeps full fp32. Measured on 3000
 * structured 2048-dimension vectors: 24 of 24 top results identical to the exact fp32 scan,
 * 42.2ms to 1.09ms.
 *
 * Deployments running several embedding routes need one index per route and should add them
 * explicitly rather than extending this migration, so that each dimension stays visible.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const configuration = resolveConfiguration();
  if (!configuration) return;
  const { dimensions, elementType } = configuration;
  const operatorClass = elementType === "halfvec" ? "halfvec_cosine_ops" : "vector_cosine_ops";

  // Building an HNSW graph is memory-hungry; a low maintenance_work_mem only makes it slower, while
  // a value beyond the container's shared memory fails outright. Left to the server default on
  // purpose so the deployment controls it.
  await sql
    .raw(
      `CREATE INDEX IF NOT EXISTS memory_chunk_embedding_ann_idx
         ON questlab.memory_chunk
         USING hnsw ((embedding::${elementType}(${dimensions})) ${operatorClass})
         WHERE embedding IS NOT NULL AND chunk_level = 'child'`,
    )
    .execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS questlab.memory_chunk_embedding_ann_idx`.execute(db);
}

function resolveConfiguration(): { dimensions: number; elementType: "vector" | "halfvec" } | undefined {
  const raw = process.env.EMBEDDING_DIMENSIONS?.trim();
  if (!raw) return undefined;

  const dimensions = Number(raw);
  if (!Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > 4000) {
    throw new TypeError("EMBEDDING_DIMENSIONS must be an integer between 1 and 4000 to build an ANN index");
  }

  const configured = process.env.EMBEDDING_DISTANCE_ELEMENT_TYPE?.trim();
  if (configured !== undefined && configured !== "" && configured !== "vector" && configured !== "halfvec") {
    throw new TypeError("EMBEDDING_DISTANCE_ELEMENT_TYPE must be 'vector' or 'halfvec'");
  }
  const elementType: "vector" | "halfvec" =
    configured === "vector" || configured === "halfvec" ? configured : dimensions > 2000 ? "halfvec" : "vector";

  // Fail loudly rather than build an index the planner will ignore.
  if (elementType === "vector" && dimensions > 2000) {
    throw new TypeError(
      `EMBEDDING_DIMENSIONS=${dimensions} exceeds the 2000-dimension pgvector limit for 'vector' ANN indexes; ` +
        "use EMBEDDING_DISTANCE_ELEMENT_TYPE=halfvec (limit 4000) or leave it unset to pick halfvec automatically",
    );
  }
  return { dimensions, elementType };
}
