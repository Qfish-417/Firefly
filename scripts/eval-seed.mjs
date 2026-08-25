/**
 * 灌入带标注的评测语料。
 *
 * 走真实链路：PostgresMemoryIndexer + 真实 Embedding provider。
 * 不直接写表，因此所有不可变性校验、ACL 与索引版本一致性检查都会真的生效——
 * 如果这些约束有问题，灌数据阶段就会失败，而不是在评测阶段得到看似合理的错误数字。
 *
 * 标注写在 memory_chunk.entity_keys 里（topic./cluster./facet. 前缀），
 * 评测脚本从那里读回，不重新推断。标注与语料同源，避免两边漂移。
 *
 * 用法：
 *   node --env-file=infra/compose/questlab-remote-model.env scripts/eval-seed.mjs --depth 40
 *
 * chunk 总数 = 32 topic × 4 facet × depth。depth 40 => 5120 chunk。
 * --depth 240 => 30720 chunk（约 3 万，用于量化规模化后的检索表现）。
 */
import { createHash } from "node:crypto";
import { sql } from "kysely";

import { createDatabase } from "../packages/persistence/src/database.ts";
import { PostgresMemoryIndexer } from "../packages/retrieval-postgres/src/index.ts";
import { HttpEmbeddingProvider } from "../packages/model-gateway/src/http-embedding-provider.ts";
import { allTopics, facets, buildChunk, relevantMultiplierFor } from "./eval-corpus.mjs";
import { buildRealCorpus, safeKey } from "./real-corpus.mjs";

const argument = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const depth = Number(argument("depth", "40"));
// 干扰 topic 的 depth 独立于真实 topic：语料体积由干扰承担，相关集大小由真实 topic 的
// depth 决定。合在一个参数里就会重现"想要大语料就必须要大相关集"的矛盾，而 Recall@k
// 的分母正是相关集，那样指标会被构造方式锁死（实测 depth=240 时 R@10 上限只有 0.01）。
const distractorDepth = Number(argument("distractor-depth", String(depth)));
// 让真实 topic 的相关集大小因 topic 而异（12~96 条），用来量化自适应 context_k。
// 相关集恒定时固定 k 处处接近最优，自适应策略无从体现差别。
const varyRelevantSets = argument("vary-relevant-sets", "false") === "true";
// 用仓库内真实 Markdown 作为语料，而不是合成文本。标注由文件路径推导，见 real-corpus.mjs。
const useRealCorpus = argument("real", "false") === "true";
const realGranularity = argument("granularity", "section");
const realCorpus = useRealCorpus ? buildRealCorpus(process.cwd(), realGranularity) : undefined;
const tenantId = argument("tenant", "tenant.eval");
const logicalName = argument("logical-name", process.env.RETRIEVAL_LOGICAL_NAME?.trim() || "memory.hybrid");
const indexVersionId = argument("index-version", "iv.eval.001");
const runTag = argument("run", "e1");
const batchSize = Number(argument("batch", "64"));
const embedConcurrency = Number(argument("embed-concurrency", "4"));

if (!Number.isSafeInteger(depth) || depth < 1) throw new TypeError("--depth must be a positive integer");
if (!Number.isSafeInteger(distractorDepth) || distractorDepth < 0) throw new TypeError("--distractor-depth must be a non-negative integer");
if (!process.env.DATABASE_URL) throw new TypeError("DATABASE_URL is required");

const realTopicCount = allTopics.filter((topic) => !topic.is_distractor).length;
const distractorTopicCount = allTopics.length - realTopicCount;
const realChunkTotal = varyRelevantSets
  ? allTopics.reduce((sum, topic, index) => sum + (topic.is_distractor ? 0 : facets.length * depth * relevantMultiplierFor(index)), 0)
  : realTopicCount * facets.length * depth;
const relevantPerQuery = facets.length * depth;
const totalChunks = realChunkTotal + (distractorTopicCount * facets.length * distractorDepth);
if (useRealCorpus) {
  const sizes = realCorpus.queryTopics.map((t) => realCorpus.relevantCounts.get(t)).sort((a, b) => a - b);
  const cap = realCorpus.queryTopics.reduce((sum, t) => {
    const total = realCorpus.relevantCounts.get(t);
    return sum + Math.min(10, total) / total;
  }, 0) / realCorpus.queryTopics.length;
  console.log(`真实语料：${realCorpus.chunks.length} chunk，来自仓库内 Markdown`);
  console.log(`可查询 topic ${realCorpus.queryTopics.length} 个，相关集 ${sizes[0]}~${sizes[sizes.length - 1]}`
    + `（中位 ${sizes[Math.floor(sizes.length / 2)]}）`);
  console.log(`Recall@10 加权理论上限 = ${cap.toFixed(3)}`);
} else console.log(`目标：${realTopicCount} 真实 topic × ${facets.length} facet × depth ${depth}`
  + ` + ${distractorTopicCount} 干扰 topic × ${facets.length} facet × depth ${distractorDepth}`
  + ` = ${totalChunks} chunk`);
if (useRealCorpus) {
  // 真实语料的相关集统计已在上面打印，不适用合成语料的 depth 口径。
} else if (varyRelevantSets) {
  const sizes = allTopics.flatMap((topic, index) => topic.is_distractor ? [] : [facets.length * depth * relevantMultiplierFor(index)]);
  console.log(`每条查询的相关 chunk = ${Math.min(...sizes)}~${Math.max(...sizes)} 条（不均匀，用于量化自适应 context_k）`);
} else {
  console.log(`每条查询的相关 chunk = ${relevantPerQuery} 条 => Recall@10 上限 ${Math.min(1, 10 / relevantPerQuery).toFixed(2)}`
    + `，Recall@20 上限 ${Math.min(1, 20 / relevantPerQuery).toFixed(2)}`);
}

const db = createDatabase(process.env.DATABASE_URL);

function embeddingProvider() {
  const endpoint = process.env.EMBEDDING_ENDPOINT?.trim();
  const model = process.env.EMBEDDING_MODEL?.trim();
  const dimensions = Number(process.env.EMBEDDING_DIMENSIONS?.trim());
  if (!endpoint || !model || !Number.isSafeInteger(dimensions)) return undefined;
  return {
    provider: new HttpEmbeddingProvider({
      endpoint,
      model,
      dimensions,
      timeout_ms: 120_000,
      max_response_bytes: 64_000_000,
      allow_insecure_localhost: process.env.EMBEDDING_ALLOW_INSECURE_LOCALHOST === "true",
      send_dimensions: process.env.EMBEDDING_SEND_DIMENSIONS === "true",
      ...(process.env.EMBEDDING_API_KEY?.trim() ? { api_key: process.env.EMBEDDING_API_KEY.trim() } : {}),
    }),
    snapshot: process.env.EMBEDDING_MODEL_SNAPSHOT?.trim() || model,
    dimensions,
  };
}

const embedding = embeddingProvider();
if (!embedding) {
  console.warn("警告：EMBEDDING_* 未配置，只灌词法可检索的内容，向量指标将无法计算。");
}
const indexer = new PostgresMemoryIndexer(db);
const digest = (value) => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

/** 有界并发：embedding 是整个流程的瓶颈，串行会让 3 万条变成小时级。 */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const index = cursor++;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    }),
  );
  return results;
}

try {
  await sql`
    INSERT INTO questlab.retrieval_index_version
      (index_version_id, build_id, tenant_id, logical_name, index_kind, provider,
       configuration_digest, embedding_model, embedding_dimensions, source_watermark, status,
       document_count, chunk_count, requested_at, ready_at, activated_at)
    VALUES (${indexVersionId}, ${`build.${indexVersionId}`}, ${tenantId}, ${logicalName},
       ${embedding ? "hybrid" : "lexical"}, 'postgres', ${digest(indexVersionId)},
       ${embedding?.snapshot ?? null}, ${embedding?.dimensions ?? null}, 'wm.1', 'active',
       0, 0, now(), now(), now())
    ON CONFLICT DO NOTHING
  `.execute(db);

  // 一个 topic 一个 memory_record：ACL 以 memory 为粒度，
  // 这样也顺带验证跨 memory 的授权过滤在评测负载下是否正常。
  const memoryTopics = useRealCorpus
    ? realCorpus.queryTopics.concat([...realCorpus.relevantCounts.keys()].filter((t) => !realCorpus.queryTopics.includes(t))).map((id) => ({ id }))
    : allTopics;
  for (const topic of memoryTopics) {
    const memoryId = `mem.eval.${runTag}.${useRealCorpus ? safeKey(topic.id) : topic.id}`;
    await sql`
      INSERT INTO questlab.memory_record
        (memory_id, tenant_id, owner_type, owner_id, scope, stage, kind, content_digest,
         confidence, sensitivity, status)
      VALUES (${memoryId}, ${tenantId}, 'tenant', ${tenantId}, 'tenant', 'semantic', 'fact',
         ${digest(memoryId)}, 0.9, 'internal', 'active')
      ON CONFLICT DO NOTHING
    `.execute(db);
    await sql`
      INSERT INTO questlab.memory_acl (memory_id, principal_type, principal_id, permission)
      VALUES (${memoryId}, 'tenant', ${tenantId}, 'read')
      ON CONFLICT DO NOTHING
    `.execute(db);
  }

  const started = Date.now();
  let indexed = 0;
  let embedded = 0;
  let embedCalls = 0;
  let embedMs = 0;
  let embedRetries = 0;

  const pending = [];
  if (useRealCorpus) {
    // 真实 chunk 的 entity_keys 只放 topic 与来源文件：合成语料的 facet/depth 是构造产物，
    // 真实文档没有对应物，硬造会让 selectEvidence 的去重规则按虚构维度工作。
    for (const [index, chunk] of realCorpus.chunks.entries()) {
      pending.push({
        chunk_id: `chunk.real.${runTag}.${index}`,
        memory_id: `mem.eval.${runTag}.${safeKey(chunk.topic_id)}`,
        index_version_id: indexVersionId,
        ordinal: index,
        chunk_level: "child",
        content: chunk.content,
        // 必须是内容本身的摘要：索引器会校验 chunk_digest === sha256(content)，
        // 这是防止内容被替换而摘要不变的完整性检查，掺入路径会让校验失败。
        chunk_digest: digest(chunk.content),
        token_count: Math.max(1, Math.round(chunk.content.length / 3)),
        source_type: "text/markdown",
        // entity_key 与 URI 都受契约的字符约束。真实路径里有中文文件名和空格，直接塞进去
        // 会违反 `^[A-Za-z0-9][A-Za-z0-9._:@/-]*$`，所以这里做一次可逆的编码：
        // 原始路径保留在 citation.locator 里，标注仍然可复核。
        entity_keys: [`topic.${safeKey(chunk.topic_id)}`, `source.${safeKey(chunk.source_path)}`],
        citation: {
          artifact_id: `artifact.real.${runTag}.${safeKey(chunk.topic_id)}`,
          uri: `https://corpus.firefly.local/${chunk.source_path.split("/").map(encodeURIComponent).join("/")}`,
          digest: digest(chunk.source_path),
          locator: { path: chunk.source_path, ordinal: chunk.ordinal },
        },
      });
    }
  } else
  for (let topicIndex = 0; topicIndex < allTopics.length; topicIndex += 1) {
    const isDistractor = allTopics[topicIndex].is_distractor;
    const topicDepth = isDistractor
      ? distractorDepth
      : depth * (varyRelevantSets ? relevantMultiplierFor(topicIndex) : 1);
    for (let facetIndex = 0; facetIndex < facets.length; facetIndex += 1) {
      for (let d = 1; d <= topicDepth; d += 1) {
        const built = buildChunk({ topicIndex, facetIndex, depth: d, runTag });
        pending.push({
          chunk_id: `chunk.eval.${built.chunk_suffix}`,
          memory_id: `mem.eval.${runTag}.${built.topic_id}`,
          index_version_id: indexVersionId,
          ordinal: (facetIndex * topicDepth) + d,
          chunk_level: "child",
          content: built.content,
          chunk_digest: digest(built.content),
          token_count: Math.max(1, Math.round(built.content.length / 2)),
          source_type: built.source_type,
          entity_keys: built.entity_keys,
          citation: {
            artifact_id: `artifact.eval.${runTag}.${built.topic_id}`,
            uri: `https://artifacts.firefly.local/eval/${built.topic_id}/${built.facet_id}.md`,
            digest: digest(`artifact.${built.topic_id}.${built.facet_id}`),
            locator: { facet: built.facet_id, depth: d },
          },
        });
      }
    }
  }

  const batches = [];
  for (let offset = 0; offset < pending.length; offset += batchSize) {
    batches.push(pending.slice(offset, offset + batchSize));
  }

  if (embedding) {
    await mapWithConcurrency(batches, embedConcurrency, async (batch, batchIndex) => {
      const t0 = Date.now();
      // 批量 embedding 会长时间打同一个端点，偶发超时是常态而非异常：
      // 一批 64 条 × 2048 维约 2.7MB JSON，响应体传输本身就是主要耗时。
      // 一次失败就放弃整轮灌数没有意义，因此对可重试错误做有限退避重试。
      let result;
      for (let attempt = 1; ; attempt += 1) {
        try {
          result = await embedding.provider.embed({
            request_id: `eval-seed:${runTag}:${batchIndex}:${attempt}`,
            workload: "retrieval.corpus.embed",
            inputs: batch.map((item) => item.content),
            budget: { max_tokens: 100_000_000, max_cost_usd: 0, max_duration_ms: 300_000 },
          });
          break;
        } catch (error) {
          const retryable = error?.retryable === true;
          if (!retryable || attempt >= 4) throw error;
          embedRetries += 1;
          await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
        }
      }
      embedMs += Date.now() - t0;
      embedCalls += 1;
      result.vectors.forEach((vector, position) => {
        batch[position].embedding = vector;
        batch[position].embedding_model = embedding.snapshot;
      });
      embedded += batch.length;
      if (embedCalls % 10 === 0) {
        process.stdout.write(`  embedding ${embedded}/${pending.length}\n`);
      }
    });
  }

  // 索引写入串行：indexer 内部有多次一致性查询，并发写同一 index_version 只会互相等锁。
  for (const chunk of pending) {
    await indexer.index(chunk);
    indexed += 1;
    if (indexed % 2_000 === 0) process.stdout.write(`  indexed ${indexed}/${pending.length}\n`);
  }

  await sql`
    UPDATE questlab.retrieval_index_version
       SET document_count = ${allTopics.length},
           chunk_count = (SELECT count(*) FROM questlab.memory_chunk WHERE index_version_id = ${indexVersionId})
     WHERE index_version_id = ${indexVersionId}
  `.execute(db);
  for (const table of ["memory_chunk", "memory_record", "memory_acl"]) {
    await sql.raw(`ANALYZE questlab.${table}`).execute(db);
  }

  const sizes = await sql`
    SELECT pg_size_pretty(pg_relation_size('questlab.memory_chunk')) AS table_size,
           pg_size_pretty(COALESCE(pg_relation_size('questlab.memory_chunk_embedding_ann_idx'), 0)) AS ann_index_size,
           count(*) AS chunks, count(embedding) AS embedded
    FROM questlab.memory_chunk
  `.execute(db);

  console.log(JSON.stringify({
    tenant_id: tenantId,
    index_version_id: indexVersionId,
    run_tag: runTag,
    logical_name: logicalName,
    topics: allTopics.length,
    facets: facets.length,
    depth,
    chunks_indexed: indexed,
    embedded_chunks: embedded,
    embed_calls: embedCalls,
    embed_retries: embedRetries,
    embed_mean_ms_per_batch: embedCalls ? Math.round(embedMs / embedCalls) : null,
    embed_throughput_chunks_per_sec: embedMs ? Number((embedded / (embedMs / 1000)).toFixed(1)) : null,
    total_wall_sec: Number(((Date.now() - started) / 1000).toFixed(1)),
    storage: sizes.rows[0],
    vector_search: embedding ? "enabled" : "disabled",
  }, null, 2));
} finally {
  await db.destroy();
}
