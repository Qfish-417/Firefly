/**
 * 在真实文档语料上量化检索质量。
 *
 * 与 `eval-rag.mjs` 的差别只有语料与标注来源：这里的 chunk 是仓库内真实 Markdown，标注由文件
 * 路径推导（见 `real-corpus.mjs`）。指标定义、分位口径、Recall 分母都与合成语料的评测保持一致，
 * 否则两组数字无法对照。
 *
 * 用法：
 *   node --env-file=.eval.env scripts/eval-real.mjs > eval-real.json
 *   node --env-file=.eval.env scripts/eval-real.mjs --form query_tokenized
 */
import { performance } from "node:perf_hooks";
import { sql } from "kysely";

import { createDatabase } from "../packages/persistence/src/database.ts";
import {
  PostgresLexicalRetriever,
  PostgresMemoryAuthorization,
  PostgresVectorRetriever,
} from "../packages/retrieval-postgres/src/index.ts";
import { RetrievalGateway } from "../packages/retrieval-service/src/index.ts";
import { HttpEmbeddingProvider } from "../packages/model-gateway/src/http-embedding-provider.ts";
import { HttpRerankerProvider } from "../packages/model-gateway/src/http-reranker-provider.ts";
import { buildRealCorpus, buildRealQuerySet, gradeForReal, safeKey } from "./real-corpus.mjs";

function argument(name, fallback) {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const tenantId = argument("tenant", "tenant.eval");
const logicalName = argument("logical-name", "memory.rt");
const indexVersionId = argument("index-version", "iv.real.001");
const granularity = argument("granularity", "file");
const repeats = Number(argument("repeats", "2"));
const cutoffs = argument("cutoffs", "1,5,10,20").split(",").map(Number);
const RELEVANT_GRADE = 2;

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

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[index].toFixed(2));
}

function summarize(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: values.length,
    mean: Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)),
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    p99_reliable: values.length >= 100,
    max: Number(sorted[sorted.length - 1].toFixed(2)),
  };
}

const mean = (values) => (values.length === 0 ? 0 : Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(4)));

function buildGateway(stages, { rerank }) {
  const retrievers = [];
  if (stages.includes("lexical")) retrievers.push(new PostgresLexicalRetriever(db, "postgres.fts.simple.v1", logicalName));
  if (stages.includes("vector")) {
    retrievers.push(new PostgresVectorRetriever({
      db,
      id: "postgres.vector.v1",
      logical_name: logicalName,
      embeddings,
      embedding_model: process.env.EMBEDDING_MODEL_SNAPSHOT,
      embedding_budget: budget,
    }));
  }
  const reranker = rerank && process.env.RERANK_ENDPOINT
    ? new HttpRerankerProvider({
      endpoint: process.env.RERANK_ENDPOINT,
      model: process.env.RERANK_MODEL,
      timeout_ms: 120_000,
      allow_insecure_localhost: process.env.EMBEDDING_ALLOW_INSECURE_LOCALHOST === "true",
    })
    : undefined;
  return new RetrievalGateway({
    retrievers,
    authorization: new PostgresMemoryAuthorization(db, logicalName),
    ...(reranker ? { reranker, reranker_budget: budget } : {}),
  });
}

/** chunk_id -> topic，从库里读回，确认落库内容与标注一致而不是凭内存推断。 */
async function loadLabels() {
  const rows = await sql`
    SELECT chunk_id, entity_keys FROM questlab.memory_chunk
    WHERE index_version_id = ${indexVersionId} AND chunk_level = 'child'
  `.execute(db);
  const labels = new Map();
  for (const row of rows.rows) {
    const topic = (row.entity_keys ?? []).find((key) => key.startsWith("topic."));
    if (topic) labels.set(row.chunk_id, { topic_id: topic.slice(6) });
  }
  return labels;
}

async function loadRelevantCounts() {
  const rows = await sql`
    SELECT key AS topic, count(*)::int AS total
    FROM questlab.memory_chunk mc
    CROSS JOIN LATERAL unnest(mc.entity_keys) AS key
    WHERE mc.index_version_id = ${indexVersionId} AND mc.chunk_level = 'child' AND key LIKE 'topic.%'
    GROUP BY key
  `.execute(db);
  return new Map(rows.rows.map((row) => [row.topic.slice(6), row.total]));
}

function scoreRanking(rankedIds, query, labels, relevantTotal, maxCutoff) {
  // 库里的 topic 是 safeKey 编码过的（契约限制 entity_key 字符集），比对前必须同样编码，
  // 否则所有查询都会判成零命中。
  const encoded = { ...query, topic_id: safeKey(query.topic_id) };
  const grades = rankedIds.slice(0, maxCutoff).map((id) => gradeForReal(encoded, labels.get(id)));
  const firstRelevant = grades.findIndex((grade) => grade >= RELEVANT_GRADE);
  // 理想序列：真实语料里同一 topic 的 chunk 都是 grade 3，所以理想 DCG 就是前 min(relevantTotal, k)
  // 个位置全放 grade 3。这与合成语料不同（那里有 grade 3/2/1 三档），因此 nDCG 上限是 1.0 而非 0.64。
  const idealGrades = Array.from({ length: Math.min(relevantTotal, maxCutoff) }, () => 3);
  const dcg = (values, k) => values.slice(0, k).reduce((sum, g, i) => sum + (2 ** g - 1) / Math.log2(i + 2), 0);
  return {
    RR: firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1),
    // Recall 分母是该查询的相关总数，不是 min(total, k)：后者会让 Recall@k 恒等于 Precision@k。
    Recall: Object.fromEntries(cutoffs.map((k) => [k,
      relevantTotal === 0 ? 0 : grades.slice(0, k).filter((g) => g >= RELEVANT_GRADE).length / relevantTotal])),
    // 上限归一的 Recall：分母改为 min(k, relevantTotal)/relevantTotal 能达到的最大值，
    // 使相关集大小不同的查询可以横向比较。
    RecallVsCap: Object.fromEntries(cutoffs.map((k) => {
      const cap = relevantTotal === 0 ? 0 : Math.min(k, relevantTotal) / relevantTotal;
      const got = relevantTotal === 0 ? 0 : grades.slice(0, k).filter((g) => g >= RELEVANT_GRADE).length / relevantTotal;
      return [k, cap === 0 ? 0 : got / cap];
    })),
    Precision: Object.fromEntries(cutoffs.map((k) => [k,
      Math.min(k, rankedIds.length) === 0 ? 0 : grades.slice(0, k).filter((g) => g >= RELEVANT_GRADE).length / Math.min(k, rankedIds.length)])),
    nDCG: Object.fromEntries(cutoffs.map((k) => {
      const ideal = dcg(idealGrades, k);
      return [k, ideal === 0 ? 0 : dcg(grades, k) / ideal];
    })),
  };
}

async function evaluate({ label, stages, form, rerank = false }) {
  const gateway = buildGateway(stages, { rerank });
  const labels = await loadLabels();
  const relevantCounts = await loadRelevantCounts();
  const corpus = buildRealCorpus(process.cwd(), granularity);
  const queries = buildRealQuerySet(corpus.queryTopics);
  const maxCutoff = Math.max(...cutoffs);
  process.stderr.write(`运行 ${label} (${queries.length} 查询 x ${repeats} 轮) ...\n`);

  const latencies = [];
  const per = [];
  let zero = 0;

  for (let round = 0; round < repeats; round += 1) {
    for (const query of queries) {
      const relevantTotal = relevantCounts.get(safeKey(query.topic_id)) ?? 0;
      const started = performance.now();
      const pack = await gateway.retrieve({
        query_id: `real.${label}.${round}.${query.query_id}`,
        original_query: query[form],
        intent: "fact_lookup",
        agent_id: "learning-director",
        principal: { tenant_id: tenantId },
        purpose: "learning_support",
        token_budget: 60_000,
        estimated_chunk_tokens: 200,
        require_citations: true,
      });
      latencies.push(performance.now() - started);
      const ids = pack.evidence.map((item) => item.evidence_id);
      if (round === 0) {
        if (ids.length === 0) zero += 1;
        per.push({
          query_id: query.query_id,
          topic_id: query.topic_id,
          query_text: query[form],
          relevant_total: relevantTotal,
          evidence_returned: ids.length,
          stop_reason: pack.trace.stop_reason,
          ...scoreRanking(ids, query, labels, relevantTotal, maxCutoff),
        });
      }
    }
  }

  const byK = (pick) => Object.fromEntries(cutoffs.map((k) => [k, mean(per.map((row) => pick(row)[k]))]));
  return {
    label,
    stages,
    form,
    rerank,
    queries: per.length,
    repeats,
    zero_result_queries: zero,
    mean_evidence_returned: mean(per.map((row) => row.evidence_returned)),
    mean_relevant_total: mean(per.map((row) => row.relevant_total)),
    metrics: {
      MRR: mean(per.map((row) => row.RR)),
      Recall: byK((row) => row.Recall),
      RecallVsCap: byK((row) => row.RecallVsCap),
      Precision: byK((row) => row.Precision),
      nDCG: byK((row) => row.nDCG),
    },
    stop_reasons: per.reduce((acc, row) => ({ ...acc, [row.stop_reason]: (acc[row.stop_reason] ?? 0) + 1 }), {}),
    latency_ms: summarize(latencies),
    per_query: per,
  };
}

const scenarios = [
  { label: "hybrid-natural", stages: ["lexical", "vector"], form: "query_natural" },
  { label: "hybrid-tokenized", stages: ["lexical", "vector"], form: "query_tokenized" },
  { label: "vector-only-natural", stages: ["vector"], form: "query_natural" },
  { label: "lexical-only-natural", stages: ["lexical"], form: "query_natural" },
  { label: "lexical-only-tokenized", stages: ["lexical"], form: "query_tokenized" },
];
if (process.env.RERANK_ENDPOINT) {
  scenarios.push({ label: "hybrid-natural-rerank", stages: ["lexical", "vector"], form: "query_natural", rerank: true });
}

const results = [];
for (const scenario of scenarios) results.push(await evaluate(scenario));

const corpus = buildRealCorpus(process.cwd(), granularity);
const queries = buildRealQuerySet(corpus.queryTopics);
const cap = queries.reduce((sum, q) => {
  const total = corpus.relevantCounts.get(q.topic_id);
  return sum + Math.min(10, total) / total;
}, 0) / queries.length;

console.log(JSON.stringify({
  corpus: {
    kind: "real_markdown",
    granularity,
    chunks: corpus.chunks.length,
    query_topics: corpus.queryTopics.length,
    relevant_set_min: Math.min(...corpus.queryTopics.map((t) => corpus.relevantCounts.get(t))),
    relevant_set_max: Math.max(...corpus.queryTopics.map((t) => corpus.relevantCounts.get(t))),
    recall_at_10_weighted_cap: Number(cap.toFixed(4)),
    label_source: "file path",
    known_bias: "同包文档全判为相关，故 Recall 偏高、Precision 偏低；跨包同概念段落判为不相关，方向相反。绝对值仅用于与合成语料对照。",
  },
  scenarios: results,
}, null, 2));
await db.destroy();
