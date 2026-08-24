/**
 * RAG 检索质量量化：MRR / nDCG / Recall / Precision / MAP + 延迟分布。
 *
 * 与 scripts/perf-retrieval.mjs 的分工：
 *   perf-retrieval 只测延迟（合成语料、桩 embedding），回答"快不快"；
 *   本脚本用标注语料 + 真实 embedding，回答"准不准"，顺带给出真实链路的延迟。
 *
 * 三个测量层，因为它们回答不同的问题，混在一起会掩盖问题所在：
 *   retriever  单个检索器自己的排序（lexical / vector 各自独立）
 *   fused      RRF 融合 + ACL 之后的排序（RetrievalGateway 的 trace 暴露的窗口）
 *   evidence   selectEvidence 之后真正交给 Agent 的证据（最终有效质量）
 *
 * 指标定义（都按标准定义实现，不做自定义变体）：
 *   MRR         第一个相关结果的倒数排名，相关性阈值 grade >= 2（同 topic 才算命中）
 *   nDCG@k      DCG = Σ (2^grade - 1) / log2(rank + 1)，IDCG 用理想排序，分级 0..3
 *   Recall@k    命中的相关 chunk 数 / 该查询全部相关 chunk 数（grade >= 2）
 *   Precision@k 命中的相关 chunk 数 / k
 *   MAP         每个查询 AP 的均值，AP = Σ (P@i × rel_i) / 相关总数
 *
 * 中文分词的影响会被显式量化：PostgreSQL simple 配置不切分中文，
 * 因此同时跑 natural（自然整句）与 tokenized（空格分词）两组查询做对照。
 *
 * 用法：
 *   node --env-file=.eval.env scripts/eval-rag.mjs --index-version iv.eval.001 --tenant tenant.eval
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
import { buildQuerySet, gradeFor, facets } from "./eval-corpus.mjs";

const argument = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const tenantId = argument("tenant", "tenant.eval");
const indexVersionId = argument("index-version", "iv.eval.001");
const logicalName = argument("logical-name", process.env.RETRIEVAL_LOGICAL_NAME?.trim() || "memory.hybrid");
const intent = argument("intent", "fact_lookup");
const repeats = Number(argument("repeats", "3"));
const cutoffs = argument("cutoffs", "1,3,5,10,20").split(",").map(Number);

if (!process.env.DATABASE_URL) throw new TypeError("DATABASE_URL is required");

const db = createDatabase(process.env.DATABASE_URL);

const embeddingProvider = new HttpEmbeddingProvider({
  endpoint: process.env.EMBEDDING_ENDPOINT,
  model: process.env.EMBEDDING_MODEL,
  dimensions: Number(process.env.EMBEDDING_DIMENSIONS),
  timeout_ms: 120_000,
  max_response_bytes: 64_000_000,
  allow_insecure_localhost: process.env.EMBEDDING_ALLOW_INSECURE_LOCALHOST === "true",
  send_dimensions: process.env.EMBEDDING_SEND_DIMENSIONS === "true",
  ...(process.env.EMBEDDING_API_KEY?.trim() ? { api_key: process.env.EMBEDDING_API_KEY.trim() } : {}),
});
const embeddingSnapshot = process.env.EMBEDDING_MODEL_SNAPSHOT?.trim() || process.env.EMBEDDING_MODEL;
const embeddingBudget = { max_tokens: 1_000_000, max_cost_usd: 0, max_duration_ms: 120_000 };

// ---------------------------------------------------------------------------
// 指标实现
// ---------------------------------------------------------------------------

/** grade >= 2 才算"相关"：同 topic 的内容。grade 1（同簇邻近）不计入命中，只影响 nDCG。 */
const RELEVANT_GRADE = 2;
/** 每个 topic 的 facet 数量，由语料定义决定，不在评测侧硬编码。 */
const FACETS_PER_TOPIC = facets.length;

function reciprocalRank(grades) {
  const position = grades.findIndex((grade) => grade >= RELEVANT_GRADE);
  return position === -1 ? 0 : 1 / (position + 1);
}

function dcg(grades, k) {
  return grades.slice(0, k).reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0);
}

/**
 * nDCG 的 IDCG 必须用**该查询实际可得的理想排序**，不是当前结果重排。
 * 用结果自身重排会让"只召回一条低分内容"也得到 nDCG=1，完全失去意义。
 */
function ndcg(grades, k, idealGrades) {
  const ideal = dcg(idealGrades, k);
  return ideal === 0 ? 0 : dcg(grades, k) / ideal;
}

function averagePrecision(grades, totalRelevant) {
  if (totalRelevant === 0) return 0;
  let hits = 0;
  let sum = 0;
  grades.forEach((grade, index) => {
    if (grade >= RELEVANT_GRADE) {
      hits += 1;
      sum += hits / (index + 1);
    }
  });
  return sum / totalRelevant;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[index].toFixed(2));
}

/**
 * p99 needs enough samples to mean anything: below 100 the 99th percentile is the maximum by
 * construction. `n` and `p99_reliable` are reported so the tail figure is not read as tail behaviour
 * when it is really a single slowest sample. 32 queries x 3 repeats = 96, so raise `--repeats` to 4
 * for a p99 that is distinct from `max`.
 */
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

// ---------------------------------------------------------------------------
// 标注读取
// ---------------------------------------------------------------------------

/**
 * 从库里读回标注（entity_keys 里的 topic./facet. 前缀），而不是在评测侧重新推断。
 * 标注与语料同源是可信度的前提：若两边各自推断，一处改动就会让指标静默失真。
 */
async function loadChunkLabels() {
  const rows = await sql`
    SELECT chunk_id, entity_keys
    FROM questlab.memory_chunk
    WHERE index_version_id = ${indexVersionId}
  `.execute(db);
  const labels = new Map();
  for (const row of rows.rows) {
    const keys = row.entity_keys ?? [];
    const topic = keys.find((key) => key.startsWith("topic."))?.slice("topic.".length);
    const facet = keys.find((key) => key.startsWith("facet."))?.slice("facet.".length);
    if (topic && facet) labels.set(row.chunk_id, { topic_id: topic, facet_id: facet });
  }
  return labels;
}

/** 每个 topic 的相关 chunk 总数，Recall 的分母。 */
async function loadRelevantCounts() {
  const rows = await sql`
    SELECT entity_keys, count(*) AS total
    FROM questlab.memory_chunk
    WHERE index_version_id = ${indexVersionId}
    GROUP BY entity_keys
  `.execute(db);
  const counts = new Map();
  for (const row of rows.rows) {
    const topic = (row.entity_keys ?? []).find((key) => key.startsWith("topic."))?.slice("topic.".length);
    if (!topic) continue;
    counts.set(topic, (counts.get(topic) ?? 0) + Number(row.total));
  }
  return counts;
}

// ---------------------------------------------------------------------------
// 检索执行
// ---------------------------------------------------------------------------

/**
 * Reranker，仅当 RERANK_ENDPOINT / RERANK_MODEL 都配置时可用。
 * 重排会替换融合分数：融合输出是按最大值归一化的（top hit = 1.0），而 reranker 返回的是
 * 原始 0..1 相关度，所以这也是 score_floor 唯一真正生效的路径。
 */
function buildReranker() {
  const endpoint = process.env.RERANK_ENDPOINT?.trim();
  const model = process.env.RERANK_MODEL?.trim();
  if (!endpoint || !model) return undefined;
  return {
    reranker: new HttpRerankerProvider({
      endpoint,
      model,
      timeout_ms: Number(process.env.RERANK_MAX_DURATION_MS ?? 30_000),
      max_documents: Number(process.env.RERANK_MAX_DOCUMENTS ?? 64),
      allow_insecure_localhost: process.env.RERANK_ALLOW_INSECURE_LOCALHOST === "true",
    }),
    reranker_budget: {
      max_tokens: Number(process.env.RERANK_MAX_TOKENS ?? 100_000),
      max_cost_usd: Number(process.env.RERANK_MAX_COST_USD ?? 1),
      max_duration_ms: Number(process.env.RERANK_MAX_DURATION_MS ?? 30_000),
    },
    // strict：重排失败必须暴露，而不是静默退回融合顺序——否则评测会把"重排没跑"
    // 记成"重排没收益"。
    reranker_failure_mode: "strict",
  };
}

function buildGateway(stages, { rerank = false } = {}) {
  const retrievers = [];
  if (stages.includes("lexical")) {
    retrievers.push(new PostgresLexicalRetriever(db, "postgres.fts.simple.v1", logicalName));
  }
  if (stages.includes("vector")) {
    retrievers.push(new PostgresVectorRetriever({
      db,
      embeddings: embeddingProvider,
      embedding_model: embeddingSnapshot,
      embedding_budget: embeddingBudget,
      logical_name: logicalName,
      distance_element_type: Number(process.env.EMBEDDING_DIMENSIONS) > 2000 ? "halfvec" : "vector",
    }));
  }
  const rerankOptions = rerank ? buildReranker() : undefined;
  if (rerank && !rerankOptions) {
    throw new Error("场景要求重排，但 RERANK_ENDPOINT / RERANK_MODEL 未配置");
  }
  return new RetrievalGateway({
    retrievers,
    authorization: new PostgresMemoryAuthorization(db, logicalName),
    ...(rerankOptions ?? {}),
  });
}

/** 单个检索器直接调用，测它自己的排序，不经过融合与选择。 */
async function retrieverRanking(retriever, queryText, maxResults) {
  const hits = await retriever.retrieve({
    query_id: `eval.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`,
    query: queryText,
    principal: { tenant_id: tenantId },
    purpose: "learning_support",
    max_results: maxResults,
    filters: {},
  });
  return [...hits].sort((a, b) => b.score - a.score).map((hit) => hit.id);
}

function scoreRanking(rankedIds, query, labels, relevantTotal, maxCutoff) {
  const grades = rankedIds.map((id) => gradeFor(query, labels.get(id)));
  const idealFull = buildIdealGrades(query, relevantTotal, maxCutoff);
  return {
    grades,
    reciprocal_rank: reciprocalRank(grades),
    average_precision: averagePrecision(grades, Math.min(relevantTotal, rankedIds.length || relevantTotal)),
    ndcg_by_k: Object.fromEntries(cutoffs.map((k) => [k, ndcg(grades, k, idealFull)])),
    // 真实召回：分母是该查询的相关 chunk 总数，不截断到 k。
    // 曾经写成 `/ min(relevantTotal, k)`，那让 Recall@k 与 Precision@k 变成同一个数
    // （11 个场景 x 3 个 k 全部逐位相等，两个指标塌缩成一个），并且掩盖了
    // "命中 10 条 / 相关 960 条" 这个事实。分母不该随 k 变化。
    recall_by_k: Object.fromEntries(cutoffs.map((k) => [
      k,
      relevantTotal === 0 ? 0 : grades.slice(0, k).filter((g) => g >= RELEVANT_GRADE).length / relevantTotal,
    ])),
    precision_by_k: Object.fromEntries(cutoffs.map((k) => [
      k,
      grades.slice(0, k).filter((g) => g >= RELEVANT_GRADE).length / k,
    ])),
    // facet 覆盖率：本语料每个 (topic, facet) 有 240 条只差 depth 的近重复，信息上是同一份。
    // 按 chunk 计召回，命中 10 条近重复和命中 10 个不同角度得分相同，测不出"取回了几个角度"。
    // 因此在 (topic, facet) 粒度上再计一次覆盖：分母是该 topic 的 4 个 facet。
    facet_coverage_by_k: Object.fromEntries(cutoffs.map((k) => [k, facetCoverage(rankedIds, query, labels, k)])),
  };
}

/** 前 k 条里覆盖了该 topic 的几个不同 facet（去重后 / 4）。 */
function facetCoverage(rankedIds, query, labels, k) {
  const seen = new Set();
  for (const id of rankedIds.slice(0, k)) {
    const label = labels.get(id);
    if (label && label.topic_id === query.topic_id) seen.add(label.facet_id);
  }
  return seen.size / FACETS_PER_TOPIC;
}

/**
 * 构造理想 grade 序列，用于 nDCG 的分母：按 grade 降序取前 maxCutoff 条。
 *
 * 这是 nDCG 的定义，不能为了"让分母可达"而改成按语料密度交错。曾经试过交错
 * （每 4 条放 1 条 definition），结果 nDCG 冲到 1.310：检索器把 definition 集中排在
 * 最前时 DCG 会超过交错序列的 DCG，而 nDCG > 1 是自相矛盾的。分母必须是**最优**排序，
 * 按 grade 降序永远优于任何交错，所以只有降序才是合法分母。
 *
 * 由此带来一个必须如实说明的后果：本语料每 topic 960 条相关 chunk 里只有 1/4 是
 * definition(grade 3)，而理想 top-10 全是 grade 3。检索器按语义相似度排序会混入
 * 其他 facet(grade 2)，所以 nDCG@10 存在一个远低于 1 的实际天花板
 * （facet 均匀分布时约 0.64）。**nDCG@10 的绝对值因此不可用于判定"是否达标"**，
 * 只能用于同口径下的横向比较（哪条检索路径更好、优化前后有没有退化）。
 * 要让 nDCG 的绝对值有意义，需要改语料结构使 grade 3 的密度接近 1，而不是改分母。
 */
function buildIdealGrades(query, relevantTotal, maxCutoff) {
  const ideal = [];
  const definitionCount = Math.round(relevantTotal / FACETS_PER_TOPIC);
  for (let i = 0; i < definitionCount && ideal.length < maxCutoff; i += 1) ideal.push(3);
  for (let i = 0; i < relevantTotal - definitionCount && ideal.length < maxCutoff; i += 1) ideal.push(2);
  while (ideal.length < maxCutoff) ideal.push(1);
  return ideal;
}

async function evaluate({ label, stages, queryField, intent: scenarioIntent = intent, rerank = false }) {
  const gateway = buildGateway(stages, { rerank });
  const labels = await loadChunkLabels();
  const relevantCounts = await loadRelevantCounts();
  const queries = buildQuerySet();
  const maxCutoff = Math.max(...cutoffs);

  // 预建单检索器实例：每条查询重新 new 会把构造开销混进延迟数字里。
  const soloRetrievers = {
    lexical: new PostgresLexicalRetriever(db, "postgres.fts.simple.v1", logicalName),
    vector: new PostgresVectorRetriever({
      db,
      embeddings: embeddingProvider,
      embedding_model: embeddingSnapshot,
      embedding_budget: embeddingBudget,
      logical_name: logicalName,
      distance_element_type: Number(process.env.EMBEDDING_DIMENSIONS) > 2000 ? "halfvec" : "vector",
    }),
  };

  const perQuery = [];
  const latencies = { gateway: [], retriever: {} };
  let emptyRetrievals = 0;
  let insufficient = 0;

  for (const query of queries) {
    const queryText = query[queryField];
    const relevantTotal = relevantCounts.get(query.topic_id) ?? 0;

    // 层 1+2：走完整 Gateway，拿最终 evidence 排序
    let pack;
    const runs = [];
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      const t0 = performance.now();
      pack = await gateway.retrieve({
        query_id: `${query.query_id}.${label}.${repeat}`,
        original_query: queryText,
        intent: scenarioIntent,
        agent_id: "eval.harness",
        principal: { tenant_id: tenantId },
        purpose: "learning_support",
        token_budget: 8_000,
        estimated_chunk_tokens: 120,
        // 契约要求的必填项；缺失会让 EvidencePack.citation_required 变成 undefined 并被
        // assertContract 拒绝。评测按"需要引用"跑，与 Agent 的真实用法一致。
        require_citations: true,
      });
      runs.push(performance.now() - t0);
    }
    latencies.gateway.push(...runs);
    if (pack.status === "insufficient") insufficient += 1;

    const evidenceIds = pack.evidence.map((item) => item.evidence_id);
    if (evidenceIds.length === 0) emptyRetrievals += 1;

    const evidenceScore = scoreRanking(evidenceIds, query, labels, relevantTotal, maxCutoff);

    // 层 0：每个检索器单独的排序，绕过融合与选择，用来定位质量损失出在哪一层。
    // 同时单独计时：端到端延迟里检索器、融合、授权、选择各占多少必须分开量，
    // 只有一个总数无法判断优化该往哪投。
    const perRetriever = {};
    for (const stage of stages) {
      const t0 = performance.now();
      const solo = await retrieverRanking(soloRetrievers[stage], queryText, maxCutoff);
      const elapsed = performance.now() - t0;
      (latencies.retriever[stage] ??= []).push(elapsed);
      perRetriever[stage] = scoreRanking(solo, query, labels, relevantTotal, maxCutoff);
      perRetriever[stage].returned = solo.length;
      perRetriever[stage].latency_ms = Number(elapsed.toFixed(2));
    }

    perQuery.push({
      query_id: query.query_id,
      topic_id: query.topic_id,
      query_text: queryText,
      relevant_total: relevantTotal,
      status: pack.status,
      coverage: pack.coverage,
      evidence_returned: evidenceIds.length,
      plan: { candidate_k: pack.plan.candidate_k, fusion_k: pack.plan.fusion_k, rerank_k: pack.plan.rerank_k },
      trace: pack.trace,
      evidence: evidenceScore,
      retrievers: perRetriever,
    });
  }

  const aggregate = (extract) => mean(perQuery.map(extract));
  const byK = (extract) => Object.fromEntries(cutoffs.map((k) => [k, mean(perQuery.map((row) => extract(row)[k]))]));

  return {
    label,
    stages,
    query_form: queryField,
    intent: scenarioIntent,
    rerank,
    queries: perQuery.length,
    repeats,
    evidence_metrics: {
      MRR: aggregate((row) => row.evidence.reciprocal_rank),
      MAP: aggregate((row) => row.evidence.average_precision),
      nDCG: byK((row) => row.evidence.ndcg_by_k),
      Recall: byK((row) => row.evidence.recall_by_k),
      Precision: byK((row) => row.evidence.precision_by_k),
      FacetCoverage: byK((row) => row.evidence.facet_coverage_by_k),
      mean_evidence_returned: aggregate((row) => row.evidence_returned),
      mean_coverage: aggregate((row) => row.coverage),
      insufficient_queries: insufficient,
      empty_queries: emptyRetrievals,
      // 停止原因分布：selectEvidence 提前停会直接压低 Recall@k 与 nDCG@k，
      // 不区分"检索没找到"与"选择阶段主动截断"就会把两类问题混为一谈。
      stop_reasons: perQuery.reduce((acc, row) => {
        const key = row.trace.stop_reason ?? "unknown";
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {}),
      funnel_means: {
        fused: mean(perQuery.map((row) => row.trace.fused)),
        authorized: mean(perQuery.map((row) => row.trace.authorized)),
        denied: mean(perQuery.map((row) => row.trace.denied)),
        selected: mean(perQuery.map((row) => row.trace.selected)),
      },
    },
    retriever_metrics: Object.fromEntries(stages.map((stage) => [
      stage,
      {
        MRR: aggregate((row) => row.retrievers[stage].reciprocal_rank),
        MAP: aggregate((row) => row.retrievers[stage].average_precision),
        nDCG: byK((row) => row.retrievers[stage].ndcg_by_k),
        Recall: byK((row) => row.retrievers[stage].recall_by_k),
        Precision: byK((row) => row.retrievers[stage].precision_by_k),
        FacetCoverage: byK((row) => row.retrievers[stage].facet_coverage_by_k),
        mean_returned: aggregate((row) => row.retrievers[stage].returned),
        zero_result_queries: perQuery.filter((row) => row.retrievers[stage].returned === 0).length,
      },
    ])),
    latency_ms: {
      gateway_end_to_end: summarize(latencies.gateway),
      // 单检索器耗时（不含融合/授权/选择）。gateway 与各检索器之和的差值就是
      // 融合、ACL 复核与证据选择的开销。
      per_retriever: Object.fromEntries(
        Object.entries(latencies.retriever).map(([stage, values]) => [stage, summarize(values)]),
      ),
    },
    per_query: perQuery.map((row) => ({
      query_id: row.query_id,
      query_text: row.query_text,
      status: row.status,
      evidence_returned: row.evidence_returned,
      RR: Number(row.evidence.reciprocal_rank.toFixed(3)),
      nDCG10: Number((row.evidence.ndcg_by_k[10] ?? 0).toFixed(3)),
      retriever_returned: Object.fromEntries(stages.map((s) => [s, row.retrievers[s].returned])),
      // 漏斗：只报最终证据数无法定位损失在哪一层，必须同时给出融合/授权/选择的计数与停止原因。
      funnel: { fused: row.trace.fused, authorized: row.trace.authorized, denied: row.trace.denied, selected: row.trace.selected, stop_reason: row.trace.stop_reason },
      plan: row.plan,
    })),
  };
}

try {
  const corpus = await sql`
    SELECT count(*) AS chunks, count(embedding) AS embedded,
           pg_size_pretty(pg_relation_size('questlab.memory_chunk')) AS table_size,
           pg_size_pretty(COALESCE(pg_relation_size('questlab.memory_chunk_embedding_ann_idx'),0)) AS ann_index_size
    FROM questlab.memory_chunk WHERE index_version_id = ${indexVersionId}
  `.execute(db);

  const rerankAvailable = Boolean(process.env.RERANK_ENDPOINT?.trim() && process.env.RERANK_MODEL?.trim());
  const scenarios = [
    { label: "hybrid-natural", stages: ["lexical", "vector"], queryField: "query_natural" },
    { label: "hybrid-tokenized", stages: ["lexical", "vector"], queryField: "query_tokenized" },
    { label: "vector-only-natural", stages: ["vector"], queryField: "query_natural" },
    { label: "lexical-only-natural", stages: ["lexical"], queryField: "query_natural" },
    { label: "lexical-only-tokenized", stages: ["lexical"], queryField: "query_tokenized" },
    // fact_lookup 的 context_k=6 让 Recall@10 的理论上限只有 0.6，测不出更高的召回。
    // exploratory 的 context_k=14 才能暴露真实召回能力，同时也验证意图路由本身生效。
    { label: "exploratory-natural", stages: ["lexical", "vector"], queryField: "query_natural", intent: "exploratory" },
    { label: "exploratory-tokenized", stages: ["lexical", "vector"], queryField: "query_tokenized", intent: "exploratory" },
    // 重排场景：只有配置了 RERANK_ENDPOINT 才跑。这是 score_floor 唯一真正生效的路径，
    // 也是量化"重排到底值不值"的唯一办法。与上面的同名非重排场景一一对应，可直接相减。
    ...(rerankAvailable
      ? [
          { label: "hybrid-natural-rerank", stages: ["lexical", "vector"], queryField: "query_natural", rerank: true },
          { label: "hybrid-tokenized-rerank", stages: ["lexical", "vector"], queryField: "query_tokenized", rerank: true },
          { label: "vector-only-natural-rerank", stages: ["vector"], queryField: "query_natural", rerank: true },
          { label: "exploratory-natural-rerank", stages: ["lexical", "vector"], queryField: "query_natural", intent: "exploratory", rerank: true },
        ]
      : []),
  ];

  const results = [];
  for (const scenario of scenarios) {
    process.stderr.write(`运行场景 ${scenario.label} ...\n`);
    results.push(await evaluate(scenario));
  }

  console.log(JSON.stringify({
    corpus: { index_version_id: indexVersionId, tenant_id: tenantId, ...corpus.rows[0] },
    embedding: { model: process.env.EMBEDDING_MODEL, dimensions: Number(process.env.EMBEDDING_DIMENSIONS), snapshot: embeddingSnapshot },
    relevance_threshold: RELEVANT_GRADE,
    cutoffs,
    scenarios: results,
  }, null, 2));
} finally {
  await db.destroy();
}
