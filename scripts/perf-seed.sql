-- 性能基准数据种子。
--
-- 用法（docs 与 chunks 必须显式给出，避免误在真实库上生成数据）：
--   psql -d questlab_perf -v docs=2000 -v chunks=5 -v ON_ERROR_STOP=1 -f scripts/perf-seed.sql
--
-- 生成 docs 篇 memory_record + docs*chunks 个 child chunk，挂在单个 active index version 下。
-- 重复执行是累加式的：ON CONFLICT DO NOTHING 意味着已存在的 id 不动，增大 docs 即可扩容到下一个量级。
--
-- 语料设计：内容由三组各 8 个词按 (d,c) 取模拼接，因此
--   * tsvector 有真实的词频分布，不是单一重复词；
--   * 三组词各自独立哈希，因此任意三词组合的期望命中量约为 总量/512，多词 AND 查询不会塌成 0；
--   * 三组词之间插入长度可变的间隔词，因此 ts_rank_cd（按词距打分）有真实的分数散布，
--     score_floor 与 marginal_gain_floor 会像生产一样起作用；
--   * source_type 四取一、entity_keys 从 512 个实体里取两个，因此证据选择的实体去重
--     与 source_type 去重会像生产一样起作用，而不是只选出 1 条；
--   * embedding 每个分量按 (d,c,分量号) 独立哈希，确定性可复现，且无周期性并列邻居。
--
-- 注意：这不是真实语料。它用于量化"延迟随数据量如何增长"，不用于评估召回质量；
-- 召回质量由 packages/memory-workers 的固定评测集负责。

\if :{?docs}
\else
  \echo 'perf-seed.sql requires -v docs=<n>'
  \quit
\endif
\if :{?chunks}
\else
  \echo 'perf-seed.sql requires -v chunks=<n>'
  \quit
\endif

-- 单个 active 版本：retrieval_index_one_active_idx 保证每个 (tenant, logical_name) 至多一个 active
INSERT INTO questlab.retrieval_index_version
  (index_version_id, build_id, tenant_id, logical_name, index_kind, provider,
   configuration_digest, embedding_model, embedding_dimensions, source_watermark, status,
   document_count, chunk_count, requested_at, ready_at, activated_at)
VALUES ('iv.perf.001', 'build.perf.001', 'tenant.perf', 'memory-main', 'hybrid', 'postgres',
   'sha256:' || repeat('a', 64), 'perf-embed-256', 256, 'wm.1', 'active', 0, 0,
   now(), now(), now())
ON CONFLICT DO NOTHING;

INSERT INTO questlab.memory_record
  (memory_id, tenant_id, owner_type, owner_id, scope, stage, kind, content_digest,
   confidence, sensitivity, status)
SELECT 'mem.perf.' || i, 'tenant.perf', 'tenant', 'tenant.perf', 'tenant', 'semantic', 'fact',
       'sha256:' || lpad(to_hex(i), 64, '0'), 0.9, 'internal', 'active'
FROM generate_series(1, :docs) AS i
ON CONFLICT DO NOTHING;

-- ACL 行必须存在：readableMemoryPredicate 依赖它，缺失会让检索返回 0 行而看起来"很快"
INSERT INTO questlab.memory_acl (memory_id, principal_type, principal_id, permission)
SELECT 'mem.perf.' || i, 'tenant', 'tenant.perf', 'read'
FROM generate_series(1, :docs) AS i
ON CONFLICT DO NOTHING;

INSERT INTO questlab.memory_chunk
  (chunk_id, memory_id, ordinal, content, chunk_digest, token_count, source_type,
   entity_keys, citation_artifact_id, citation_uri, citation_digest, citation_locator,
   embedding, embedding_model, embedding_dimensions, index_version_id, chunk_level)
SELECT
  'chunk.perf.' || d || '.' || c,
  'mem.perf.' || d,
  c,
  -- ts_rank_cd 按 cover density（查询词之间的距离）打分，不看重复次数也不看总长度。
  -- 因此三组词之间必须插入长度可变的间隔，否则每条 chunk 的词距完全相同，
  -- 分数会全部相等，score_floor 要么全放过要么全过滤，证据选择阶段就空转了。
  concat_ws(' ',
    (ARRAY['solar','daylight','irradiance','photovoltaic','albedo','zenith','azimuth','insolation'])
      [1 + (('x' || substr(md5(d::text || ':' || c::text || ':topic'), 1, 8))::bit(32)::bigint & 7)],
    repeat('lorem ', (('x' || substr(md5(d::text || ':' || c::text || ':gap1'), 1, 8))::bit(32)::bigint % 9)::int),
    (ARRAY['cohort','learner','beginner','advanced','mastery','retention','misconception','scaffold'])
      [1 + (('x' || substr(md5(d::text || ':' || c::text || ':audience'), 1, 8))::bit(32)::bigint & 7)],
    repeat('ipsum ', (('x' || substr(md5(d::text || ':' || c::text || ':gap2'), 1, 8))::bit(32)::bigint % 13)::int),
    (ARRAY['seasonal','latitude','equinox','solstice','declination','atmosphere','scattering','absorption'])
      [1 + (('x' || substr(md5(d::text || ':' || c::text || ':aspect'), 1, 8))::bit(32)::bigint & 7)],
    'segment', d::text, c::text,
    repeat('filler token ', 2 + (('x' || substr(md5(d::text || ':' || c::text || ':len'), 1, 8))::bit(32)::bigint % 12)::int)
  ),
  'sha256:' || lpad(to_hex(d * 1000 + c), 64, '0'),
  40,
  -- source_type 与 entity_keys 必须有多样性：selectEvidence 会跳过"既不引入新实体、
  -- 又与首条同 source_type"的候选，若全表同值则无论召回多少都只会选出 1 条证据，
  -- 测出来的就不是真实流水线的成本。
  (ARRAY['text/plain','text/markdown','application/pdf','text/html'])
    [1 + (('x' || substr(md5(d::text || ':' || c::text || ':src'), 1, 8))::bit(32)::bigint & 3)],
  ARRAY[
    'entity.' || (('x' || substr(md5(d::text || ':' || c::text || ':e1'), 1, 8))::bit(32)::bigint % 512)::text,
    'entity.' || (('x' || substr(md5(d::text || ':' || c::text || ':e2'), 1, 8))::bit(32)::bigint % 512)::text
  ],
  'artifact.perf.' || d, 's3://perf/' || d || '.txt', 'sha256:' || lpad(to_hex(d), 64, '0'), '{}',
  -- 每个分量独立哈希。线性式如 (d*31 + c*17 + g) % 1000 有周期性：d 与 d+1000 会生成
  -- 完全相同的向量，实测造成 100 个距离为 0 的并列邻居，于是 top-k 不唯一、召回率指标失去意义。
  (SELECT ('[' || string_agg(
             ((('x' || substr(md5(d::text || ':' || c::text || ':v' || g::text), 1, 8))::bit(32)::bigint
               % 100000)::float / 100000.0)::text, ',') || ']')::vector
     FROM generate_series(1, 256) AS g),
  'perf-embed-256', 256, 'iv.perf.001', 'child'
FROM generate_series(1, :docs) AS d, generate_series(1, :chunks) AS c
ON CONFLICT DO NOTHING;

UPDATE questlab.retrieval_index_version
   SET document_count = (SELECT count(*) FROM questlab.memory_record WHERE tenant_id = 'tenant.perf'),
       chunk_count    = (SELECT count(*) FROM questlab.memory_chunk WHERE index_version_id = 'iv.perf.001')
 WHERE index_version_id = 'iv.perf.001';

-- 统计信息必须刷新，否则计划器会按空表选计划，测出的是错误的执行路径
ANALYZE questlab.memory_chunk;
ANALYZE questlab.memory_record;
ANALYZE questlab.memory_acl;

SELECT
  (SELECT count(*) FROM questlab.memory_record WHERE tenant_id = 'tenant.perf') AS documents,
  (SELECT count(*) FROM questlab.memory_chunk  WHERE index_version_id = 'iv.perf.001') AS chunks;
