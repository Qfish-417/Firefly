import { sql, type Kysely } from "kysely";

/**
 * CJK lexical search, because `to_tsvector('simple', ...)` does not segment Chinese.
 *
 * PostgreSQL's `simple` configuration splits on whitespace and punctuation, so a Chinese sentence
 * becomes a single lexeme. Measured on a 30720-chunk corpus:
 *
 *   websearch_to_tsquery('simple','固定倾角应该设成多少度')
 *     -> '固定倾角应该设成多少度'   0 rows
 *   websearch_to_tsquery('simple','倾角 纬度')
 *     -> '倾角' & '纬度'            960 rows
 *
 * All 32 natural-language evaluation queries returned nothing, which silently degraded hybrid
 * retrieval to vector-only: `hybrid-natural` and `vector-only-natural` scored identically
 * (nDCG@10 0.479, Recall@10 0.600) because the lexical leg contributed zero.
 *
 * Approach: character bigrams, generated in SQL with no extension dependency. `pg_bigm` and
 * `zhparser` segment better, but both are external extensions — unavailable on a managed instance
 * and a deployment blocker on the standard `pgvector/pgvector:pg17` image. Bigrams are weaker at
 * word boundaries yet need nothing beyond core PostgreSQL, and for retrieval recall the tradeoff is
 * favourable: a 2-gram of any Chinese term always matches the same 2-gram in the document.
 *
 * The bigram vector is a *separate* column rather than a change to `search_vector`. Rewriting
 * `search_vector` would alter scoring for every existing non-CJK query and force a full reindex of
 * any deployed corpus; keeping them apart means Latin text keeps its exact-token behaviour and the
 * CJK path is purely additive.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // IMMUTABLE is required for a generated column, and correct here: the result depends only on the
  // input string. PARALLEL SAFE lets a parallel seq scan compute it.
  await sql`
    CREATE OR REPLACE FUNCTION questlab.cjk_bigrams(input TEXT) RETURNS TEXT
    LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $fn$
    DECLARE
      run TEXT;
      result TEXT := '';
      position INT;
    BEGIN
      -- Only CJK runs are decomposed. Latin, digits and punctuation are left out entirely: they are
      -- already tokenised correctly in search_vector, and duplicating them here would double-count
      -- them in ts_rank_cd once both vectors are queried.
      FOR run IN SELECT match[1] FROM regexp_matches(input, '[\\u4e00-\\u9fff\\u3400-\\u4dbf\\uf900-\\ufaff]+', 'g') AS match LOOP
        IF length(run) = 1 THEN
          -- A lone character has no bigram; keep it as a unigram so single-character terms
          -- ("光", "热") remain searchable.
          result := result || ' ' || run;
        ELSE
          FOR position IN 1..length(run) - 1 LOOP
            result := result || ' ' || substr(run, position, 2);
          END LOOP;
        END IF;
      END LOOP;
      RETURN result;
    END
    $fn$
  `.execute(db);

  await sql`
    ALTER TABLE questlab.memory_chunk
      ADD COLUMN IF NOT EXISTS cjk_search_vector TSVECTOR
      GENERATED ALWAYS AS (to_tsvector('simple', questlab.cjk_bigrams(content))) STORED
  `.execute(db);

  // Partial index: a corpus with no Chinese content should not pay for an index of empty vectors.
  await sql`
    CREATE INDEX IF NOT EXISTS memory_chunk_cjk_search_idx
      ON questlab.memory_chunk USING GIN (cjk_search_vector)
      WHERE cjk_search_vector IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS questlab.memory_chunk_cjk_search_idx`.execute(db);
  await sql`ALTER TABLE questlab.memory_chunk DROP COLUMN IF EXISTS cjk_search_vector`.execute(db);
  await sql`DROP FUNCTION IF EXISTS questlab.cjk_bigrams(TEXT)`.execute(db);
}
