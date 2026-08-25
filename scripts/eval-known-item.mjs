/**
 * known-item 检索：把某个 chunk 的原文当查询，看检索能否找回它自己。
 *
 * 存在的理由：其他所有 Recall 数字都依赖"哪些 chunk 与这条查询相关"的标注，而任何标注都带偏差。
 * 文件级标注把同一 Markdown 的全部 chunk 都算相关，于是 `big-integer/README.md` 里的
 * `#### shiftLeft(n)` 也被要求与 "how do I use big integer" 相关 —— 这条与查询没有任何词汇或语义
 * 重叠，任何检索器都不该把它排进前 10。结果 R@10 只到理论上限的 43%，读起来像"检索只有四成能力"，
 * 实际衡量的是标注宽度。
 *
 * 这个口径没有争议：正确答案唯一且客观（就是那条 chunk 自己），不需要任何人判断"相关"。它测的是
 * 检索链路本身——embedding、索引、ANN、过滤——能不能把一段已知文本找回来。
 *
 * 它**不能**替代带标注的评测：known-item 用整段原文当查询，比真实用户的短问句容易得多，所以它是
 * 检索能力的**上界**，不是日常表现。两个口径要一起看：这里 100% 而带标注只有 43%，差距就归因于
 * 标注宽度而不是检索缺陷；如果这里也低，那才是检索链路真的坏了。
 *
 * 用法：
 *   node --env-file=.eval.env scripts/eval-known-item.mjs > known-item.json
 *   node --env-file=.eval.env scripts/eval-known-item.mjs --samples 200 --query-chars 300
 */
import { performance } from "node:perf_hooks";
import { sql } from "kysely";

import { createDatabase } from "../packages/persistence/src/database.ts";
import {
  PostgresLexicalRetriever,
  PostgresVectorRetriever,
} from "../packages/retrieval-postgres/src/index.ts";
import { HttpEmbeddingProvider } from "../packages/model-gateway/src/http-embedding-provider.ts";

function argument(name, fallback) {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const tenantId = argument("tenant", "tenant.eval");
const logicalName = argument("logical-name", "memory.rt");
const indexVersionId = argument("index-version", "iv.real.001");
const samples = Number(argument("samples", "120"));
/**
 * 查询长度。整段原文命中太容易，截短更接近真实查询；两档都跑，用来说明"检索能力"随查询信息量变化，
 * 而不是一个单一数字。
 */
const queryChars = argument("query-chars", "300,120,60").split(",").map(Number);
const cutoffs = [1, 5, 10, 20];

const db = createDatabase(process.env.DATABASE_URL);
const budget = { max_tokens: 1_000_000, max_cost_usd: 1, max_duration_ms: 120_000 };
const embeddings = new HttpEmbeddingProvider({
  endpoint: process.env.EMBEDDING_ENDPOINT,
  model: process.env.EMBEDDING_MODEL,
  dimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? "2048"),
  timeout_ms: 120_000,
  max_response_bytes: 64_000_000,
  allow_insecure_localhost: process.env.EMBEDDING_ALLOW_INSECURE_LOCALHOST === "true",
  ...(process.env.EMBEDDING_SEND_DIMENSIONS === "true" ? { send_dimensions: true } : {}),
});

const vector = new PostgresVectorRetriever({
  db,
  id: "postgres.vector.v1",
  logical_name: logicalName,
  embeddings,
  embedding_model: process.env.EMBEDDING_MODEL_SNAPSHOT,
  embedding_budget: budget,
});
const lexical = new PostgresLexicalRetriever(db, "postgres.fts.simple.v1", logicalName);

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[index].toFixed(2));
}

const rows = await sql`
  SELECT chunk_id, content FROM questlab.memory_chunk
  WHERE index_version_id = ${indexVersionId} AND chunk_level = 'child'
  ORDER BY chunk_id
`.execute(db);

// 等距抽样而不是随机：同一份语料每次跑出同一批样本，数字可比。
const step = Math.max(1, Math.floor(rows.rows.length / samples));
const picked = [];
for (let index = 0; index < rows.rows.length && picked.length < samples; index += step) {
  const row = rows.rows[index];
  if (row.content.trim().length >= 80) picked.push(row);
}

async function measure(retriever, label, chars) {
  const ranks = [];
  const latencies = [];
  for (const [index, row] of picked.entries()) {
    const query = row.content.replace(/\s+/g, " ").trim().slice(0, chars);
    const started = performance.now();
    const hits = await retriever.retrieve({
      query_id: `ki.${label}.${chars}.${index}`,
      query,
      principal: { tenant_id: tenantId },
      purpose: "learning_support",
      max_results: Math.max(...cutoffs),
      filters: {},
      budget,
    });
    latencies.push(performance.now() - started);
    const position = hits.findIndex((hit) => hit.id === row.chunk_id);
    ranks.push(position < 0 ? null : position + 1);
  }
  const found = ranks.filter((rank) => rank !== null);
  const sortedLatency = [...latencies].sort((a, b) => a - b);
  return {
    retriever: label,
    query_chars: chars,
    samples: ranks.length,
    // Recall@k 在 known-item 下就是"正确答案落进前 k 的比例"，因为相关总数恒为 1。
    recall: Object.fromEntries(cutoffs.map((k) => [k,
      Number((ranks.filter((rank) => rank !== null && rank <= k).length / ranks.length).toFixed(4))])),
    MRR: Number((ranks.reduce((sum, rank) => sum + (rank === null ? 0 : 1 / rank), 0) / ranks.length).toFixed(4)),
    median_rank: found.length === 0 ? null : percentile([...found].sort((a, b) => a - b), 50),
    not_found: ranks.length - found.length,
    latency_ms: { p50: percentile(sortedLatency, 50), p95: percentile(sortedLatency, 95) },
  };
}

const results = [];
for (const chars of queryChars) {
  results.push(await measure(vector, "vector", chars));
  results.push(await measure(lexical, "lexical", chars));
}

console.log(JSON.stringify({
  corpus: { index_version_id: indexVersionId, logical_name: logicalName, chunks: rows.rows.length },
  method: "known-item: 用 chunk 自身文本作查询，正确答案唯一，无需相关性标注",
  caveat: "整段原文当查询比真实短问句容易，故此为检索能力上界；须与带标注评测并读",
  results,
}, null, 2));
await db.destroy();
