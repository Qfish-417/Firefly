-- 量化 ANN 索引对向量检索的作用，以及当前查询形态是否让它生效。
--
-- 用法：
--   psql -d questlab_perf -v ON_ERROR_STOP=1 -f scripts/perf-vector-index.sql
--
-- 需要先用 scripts/perf-seed.sql 灌数。脚本会自建并删除 HNSW 索引，不改动其他对象。
--
-- 三个形态的对比是本脚本的全部目的：
--   A 裸 ANN            —— 索引能达到的上限
--   B 网关当前形态       —— PostgresVectorRetriever 实际发出的 CTE + ACL 前置
--   C 无索引            —— 基线
-- 若 B 与 C 接近而与 A 相差一个数量级，说明瓶颈是查询形态而不是索引缺失。

\set query_chunk '\'chunk.perf.1.1\''

\echo '=== C: 无 ANN 索引（基线） ==='
DROP INDEX IF EXISTS questlab.perf_hnsw_idx;
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY ON)
SELECT chunk_id FROM questlab.memory_chunk
WHERE embedding IS NOT NULL
ORDER BY embedding::vector(256) <=> (SELECT embedding::vector(256) FROM questlab.memory_chunk WHERE chunk_id = :query_chunk)
LIMIT 24;

\echo ''
\echo '=== 构建 HNSW 索引 ==='
-- maintenance_work_mem 保持较低值：min 档容器 mem_limit 为 384m，
-- 设成 512MB 会因共享内存段不足直接失败（实测 No space left on device）。
SET maintenance_work_mem = '64MB';
SET max_parallel_maintenance_workers = 0;
\timing on
CREATE INDEX perf_hnsw_idx ON questlab.memory_chunk
  USING hnsw ((embedding::vector(256)) vector_cosine_ops) WHERE embedding IS NOT NULL;
\timing off

\echo ''
\echo '=== A: 裸 ANN（索引上限，无 ACL 过滤） ==='
-- 预热两次后取第三次：首次执行包含索引页读入，测的是冷缓存而非索引本身
SELECT chunk_id FROM questlab.memory_chunk WHERE embedding IS NOT NULL
ORDER BY embedding::vector(256) <=> (SELECT embedding::vector(256) FROM questlab.memory_chunk WHERE chunk_id = :query_chunk) LIMIT 24 \g /dev/null
SELECT chunk_id FROM questlab.memory_chunk WHERE embedding IS NOT NULL
ORDER BY embedding::vector(256) <=> (SELECT embedding::vector(256) FROM questlab.memory_chunk WHERE chunk_id = :query_chunk) LIMIT 24 \g /dev/null
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY ON)
SELECT chunk_id FROM questlab.memory_chunk WHERE embedding IS NOT NULL
ORDER BY embedding::vector(256) <=> (SELECT embedding::vector(256) FROM questlab.memory_chunk WHERE chunk_id = :query_chunk)
LIMIT 24;

\echo ''
\echo '=== B: 网关当前形态（ACL/租户/版本过滤前置于 CTE） ==='
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY ON)
WITH candidates AS (
  SELECT chunk.chunk_id, chunk.embedding
  FROM questlab.memory_chunk AS chunk
  JOIN questlab.memory_record AS memory ON memory.memory_id = chunk.memory_id
  JOIN questlab.retrieval_index_version AS index_version
    ON index_version.index_version_id = chunk.index_version_id
  WHERE memory.status = 'active'
    AND index_version.status = 'active'
    AND (memory.scope = 'public' OR index_version.tenant_id = 'tenant.perf')
    AND index_version.logical_name = 'memory-main'
    AND chunk.chunk_level = 'child'
    AND chunk.embedding IS NOT NULL
    AND chunk.embedding_model = 'perf-embed-256'
    AND chunk.embedding_dimensions = 256
)
SELECT chunk_id FROM candidates
ORDER BY candidates.embedding <=> (SELECT embedding FROM questlab.memory_chunk WHERE chunk_id = :query_chunk)
LIMIT 24;

\echo ''
\echo '=== 清理 ==='
DROP INDEX IF EXISTS questlab.perf_hnsw_idx;
