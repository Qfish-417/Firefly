/**
 * halfvec vs fp32 精度损失量化（真实语料）。
 *
 * 2048 维超出 pgvector `vector` 类型的 ANN 索引上限 2000，所以索引必须用 halfvec（上限 4000）。
 * halfvec 是 fp16 存储，会有舍入损失。此前只在退化数据上探过（随机 2048 维向量全部聚在
 * cosine 0.247~0.250，区分不出任何东西），那些数字不能引用。
 *
 * 这里用真实语料的真实 embedding 做三件事：
 *   1. 同一查询下，halfvec 近似检索 vs fp32 精确检索的 top-k 重合率（Recall@k vs 精确解）
 *   2. 排序相关性（Spearman 足够，因为只关心名次是否被打乱）
 *   3. 两者的延迟差，以及"索引扫描 vs 顺序扫描"的实际代价
 *
 * 用法：node --env-file=.eval.env scripts/eval-halfvec.mjs [--queries 32] [--k 10]
 */
import { sql } from "kysely";
import { createDatabase } from "../packages/persistence/src/database.ts";
import { HttpEmbeddingProvider } from "../packages/model-gateway/src/http-embedding-provider.ts";
import { buildQuerySet } from "./eval-corpus.mjs";

const argument = (name, fallback) => {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const k = Number(argument("k", "10"));
const queryLimit = Number(argument("queries", "32"));
const indexVersionId = argument("index-version", "iv.eval.001");
const dimensions = Number(process.env.EMBEDDING_DIMENSIONS);
const db = createDatabase(process.env.DATABASE_URL);
const embeddings = new HttpEmbeddingProvider({
  endpoint: process.env.EMBEDDING_ENDPOINT,
  model: process.env.EMBEDDING_MODEL,
  dimensions,
  allow_insecure_localhost: process.env.EMBEDDING_ALLOW_INSECURE_LOCALHOST === "true",
  ...(process.env.EMBEDDING_SEND_DIMENSIONS === "true" ? { send_dimensions: true } : {}),
});
const budget = { max_tokens: 1_000_000, max_cost_usd: 1, max_duration_ms: 120_000 };
const percentile = (sorted, p) => {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return Number(sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))].toFixed(2));
};
const summarize = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: values.length,
    mean: Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)),
    p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99),
    p99_reliable: values.length >= 100,
    max: Number(sorted[sorted.length - 1].toFixed(2)),
  };
};

/** Spearman 秩相关：只关心名次是否被打乱，不关心分数绝对值。 */
function spearman(rankA, rankB) {
  const shared = rankA.filter((id) => rankB.includes(id));
  if (shared.length < 2) return null;
  const posA = shared.map((id) => rankA.indexOf(id));
  const posB = shared.map((id) => rankB.indexOf(id));
  const n = shared.length;
  const meanA = posA.reduce((a, b) => a + b, 0) / n;
  const meanB = posB.reduce((a, b) => a + b, 0) / n;
  let num = 0, dA = 0, dB = 0;
  for (let i = 0; i < n; i += 1) {
    num += (posA[i] - meanA) * (posB[i] - meanB);
    dA += (posA[i] - meanA) ** 2;
    dB += (posB[i] - meanB) ** 2;
  }
  return dA === 0 || dB === 0 ? null : Number((num / Math.sqrt(dA * dB)).toFixed(4));
}

async function search(literal, elementType, forceScan) {
  // enable_indexscan=off 强制顺序扫描，用来测 fp32 精确解与索引扫描的代价差。
  if (forceScan) await sql`SET LOCAL enable_indexscan = off`.execute(db);
  else await sql`SET LOCAL enable_indexscan = on`.execute(db);
  const cast = sql.raw(`${elementType}(${dimensions})`);
  const t0 = performance.now();
  const rows = await sql`
    SELECT chunk_id, (embedding::${cast} <=> ${literal}::${cast})::double precision AS distance
    FROM questlab.memory_chunk
    WHERE index_version_id = ${indexVersionId} AND chunk_level = 'child' AND embedding IS NOT NULL
    ORDER BY embedding::${cast} <=> ${literal}::${cast}
    LIMIT ${k}
  `.execute(db);
  return { ids: rows.rows.map((row) => row.chunk_id), elapsed: performance.now() - t0 };
}

const queries = buildQuerySet().slice(0, queryLimit);
const overlaps = [];
const top1Same = [];
const spearmans = [];
const topicOverlaps = [];
const fp16Overlaps = [];
const annOverlaps = [];
const fp16Top1Same = [];
const halfLatency = [];
const halfExactLatency = [];
const exactLatency = [];

for (const query of queries) {
  const embedded = await embeddings.embed({
    request_id: `halfvec.${query.query_id}`, workload: "retrieval.query.embed",
    inputs: [query.query_natural], budget,
  });
  const literal = `[${embedded.vectors[0].join(",")}]`;

  // 三条路径，用来把"fp16 舍入损失"与"HNSW 近似损失"分开：
  //   half   = halfvec + 索引扫描  -> 生产路径，两种损失叠加
  //   halfEx = halfvec + 顺序扫描  -> 只有 fp16 舍入损失
  //   exact  = fp32   + 顺序扫描  -> 真正的正确答案
  const half = await search(literal, "halfvec", false);
  const halfExact = await search(literal, "halfvec", true);
  const exact = await search(literal, "vector", true);

  overlaps.push(half.ids.filter((id) => exact.ids.includes(id)).length / Math.max(1, exact.ids.length));
  // 只看 chunk_id 会高估影响：被换掉的往往是同一 topic 的相邻 depth，语义完全等价。
  // 对 RAG 而言真正要问的是"topic 有没有变"，这才是标注意义上的相关性。
  const topicOf = (id) => id.split(".").slice(3, -2).join(".") || id;
  const halfTopics = new Set(half.ids.map(topicOf));
  const exactTopics = new Set(exact.ids.map(topicOf));
  const sharedTopics = [...halfTopics].filter((topic) => exactTopics.has(topic));
  topicOverlaps.push(sharedTopics.length / Math.max(1, exactTopics.size));
  fp16Overlaps.push(halfExact.ids.filter((id) => exact.ids.includes(id)).length / Math.max(1, exact.ids.length));
  annOverlaps.push(half.ids.filter((id) => halfExact.ids.includes(id)).length / Math.max(1, halfExact.ids.length));
  top1Same.push(half.ids[0] === exact.ids[0] ? 1 : 0);
  fp16Top1Same.push(halfExact.ids[0] === exact.ids[0] ? 1 : 0);
  const rho = spearman(half.ids, exact.ids);
  if (rho !== null) spearmans.push(rho);
  halfLatency.push(half.elapsed);
  halfExactLatency.push(halfExact.elapsed);
  exactLatency.push(exact.elapsed);
}

const meanOf = (values) => Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(4));
console.log(JSON.stringify({
  dimensions, k, queries: queries.length,
  // 与 fp32 精确解相比，halfvec 近似检索保留了多少正确结果
  // 生产路径（halfvec + HNSW）相对 fp32 精确解的整体损失
  recall_vs_exact: meanOf(overlaps),
  top1_agreement: meanOf(top1Same),
  // 按标注口径（topic 集合）衡量的一致率。chunk 级差异若全发生在同 topic 内部，
  // 对检索质量没有影响，这个数字才是 RAG 该关心的。
  topic_level_agreement: meanOf(topicOverlaps),
  // 拆开：fp16 舍入单独造成多少损失（halfvec 顺序扫描 vs fp32 顺序扫描）
  fp16_rounding_only: { recall_vs_exact: meanOf(fp16Overlaps), top1_agreement: meanOf(fp16Top1Same) },
  // 拆开：HNSW 近似单独造成多少损失（halfvec 索引 vs halfvec 顺序扫描）
  ann_approximation_only: { recall_vs_exact: meanOf(annOverlaps) },
  spearman_mean: spearmans.length ? meanOf(spearmans) : null,
  spearman_min: spearmans.length ? Math.min(...spearmans) : null,
  latency_ms: { halfvec_indexed: summarize(halfLatency), halfvec_seqscan: summarize(halfExactLatency), fp32_seqscan: summarize(exactLatency) },
}, null, 2));
await db.destroy();
