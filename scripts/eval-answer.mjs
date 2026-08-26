/**
 * 答案质量评测（LLM-as-judge）。
 *
 * 此前所有 Agent 指标都只覆盖"结构合规"：output_contract_failures = 0 只说明模型输出满足
 * JSON 契约，完全不代表内容正确。这个脚本补上内容维度。
 *
 * 三个维度，都相对**检索到的证据**打分，而不是相对模型的世界知识——RAG 系统要保证的是
 * "答案能被证据支撑"，不是"答案听起来对"：
 *   faithfulness  答案是否只用了证据里的信息（幻觉检测）
 *   relevance     答案是否真的回答了问题
 *   completeness  证据里的关键信息是否被用上
 *
 * 另外独立于裁判、用标注直接算一个客观指标：
 *   citation_precision  引用的 chunk 里有多少确实与该 topic 相关（grade >= 2）
 * 裁判会犯错，标注不会——两者并列才能互相校验。
 *
 * 用法：node --env-file=.eval.env scripts/eval-answer.mjs [--queries 32] [--intent fact_lookup]
 */
import { performance } from "node:perf_hooks";
import { sql } from "kysely";
import { createDatabase } from "../packages/persistence/src/database.ts";
import { PostgresLexicalRetriever, PostgresVectorRetriever, PostgresMemoryAuthorization } from "../packages/retrieval-postgres/src/index.ts";
import { RetrievalGateway } from "../packages/retrieval-service/src/index.ts";
import { HttpEmbeddingProvider } from "../packages/model-gateway/src/http-embedding-provider.ts";
import { HttpRerankerProvider } from "../packages/model-gateway/src/http-reranker-provider.ts";
import { createPiAiModelGateway, loadModelGatewayConfiguration } from "../packages/model-gateway/src/configuration.ts";
import { buildQuerySet, gradeFor } from "./eval-corpus.mjs";
import { buildRealCorpus, buildRealQuerySet, gradeForReal } from "./real-corpus.mjs";

const argument = (name, fallback) => {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const queryLimit = Number(argument("queries", "32"));
const intent = argument("intent", "fact_lookup");
const tenantId = argument("tenant", "tenant.eval");
const indexVersionId = argument("index-version", "iv.eval.001");
const logicalName = argument("logical-name", process.env.RETRIEVAL_LOGICAL_NAME?.trim() || "memory.hybrid");
const useRerank = process.argv.includes("--rerank");
/**
 * 用真实文档语料而不是合成语料。
 *
 * 合成语料的 chunk 是 (topic, facet, depth) 构造的近重复段落，答案质量看起来会偏高：证据之间
 * 高度相似，裁判几乎总能判"答案被证据支撑"。真实文档的证据是人写的散文，句式与措辞都不规整，
 * 才能暴露生成侧的问题。检索侧已验证过同一件事——合成语料掩盖了两个产品缺陷（报告第 20 节）。
 */
const useReal = process.argv.includes("--real");

const db = createDatabase(process.env.DATABASE_URL);
const dimensions = Number(process.env.EMBEDDING_DIMENSIONS);
const embeddingProvider = new HttpEmbeddingProvider({
  endpoint: process.env.EMBEDDING_ENDPOINT, model: process.env.EMBEDDING_MODEL, dimensions,
  allow_insecure_localhost: process.env.EMBEDDING_ALLOW_INSECURE_LOCALHOST === "true",
  ...(process.env.EMBEDDING_SEND_DIMENSIONS === "true" ? { send_dimensions: true } : {}),
});
const budget = { max_tokens: 1_000_000, max_cost_usd: 1, max_duration_ms: 120_000 };
const modelGateway = createPiAiModelGateway(loadModelGatewayConfiguration());

const gateway = new RetrievalGateway({
  retrievers: [
    new PostgresLexicalRetriever(db, "postgres.fts.simple.v1", logicalName),
    new PostgresVectorRetriever({
      db, embeddings: embeddingProvider,
      embedding_model: process.env.EMBEDDING_MODEL_SNAPSHOT?.trim() || process.env.EMBEDDING_MODEL,
      embedding_budget: budget, logical_name: logicalName,
      distance_element_type: dimensions > 2000 ? "halfvec" : "vector",
    }),
  ],
  authorization: new PostgresMemoryAuthorization(db, logicalName),
  ...(useRerank && process.env.RERANK_ENDPOINT ? {
    reranker: new HttpRerankerProvider({
      endpoint: process.env.RERANK_ENDPOINT, model: process.env.RERANK_MODEL,
      timeout_ms: 60_000, max_documents: 64, allow_insecure_localhost: true,
    }),
    reranker_budget: budget,
    reranker_failure_mode: "strict",
  } : {}),
});

/** 从 chunk_id 反查标注，用于客观的引用精确率。 */
async function loadLabels() {
  const rows = await sql`
    SELECT chunk_id, entity_keys FROM questlab.memory_chunk WHERE index_version_id = ${indexVersionId}
  `.execute(db);
  const labels = new Map();
  for (const row of rows.rows) {
    const keys = row.entity_keys ?? [];
    const topic = keys.find((k) => k.startsWith("topic."))?.slice(6);
    const facet = keys.find((k) => k.startsWith("facet."))?.slice(6);
    // 真实语料的 chunk 只有 topic（= 小节），没有 facet —— facet 是合成语料构造出来的维度。
    // 早先这里要求 topic && facet，用真实语料时 labels 会整个为空，citation_precision 恒为 0。
    if (topic && facet) labels.set(row.chunk_id, { topic_id: topic, facet_id: facet });
    else if (topic) labels.set(row.chunk_id, { topic_id: topic });
  }
  return labels;
}

const ANSWER_SYSTEM = [
  "你是一个严格基于给定证据回答问题的助手。",
  "只能使用证据中出现的信息。证据不足时必须明确说明不足，不要补充证据以外的内容。",
  "回答控制在 120 字以内，直接给结论。",
].join("\n");

const JUDGE_SYSTEM = [
  "你是检索增强生成系统的评审。你会看到：问题、提供给模型的证据、模型的回答。",
  "按三个维度各打 0 到 5 的整数分：",
  "faithfulness：回答中的每个论断是否都能在证据里找到支撑。出现证据外的内容就扣分，完全无支撑给 0。",
  "relevance：回答是否针对问题本身。答非所问给 0。",
  "completeness：证据中与问题相关的关键信息是否都用上了。",
  '只输出 JSON，不要任何其他文字：{"faithfulness":n,"relevance":n,"completeness":n,"reason":"不超过 30 字"}',
].join("\n");

function parseJudgement(text) {
  // 模型可能包裹 ```json；只取第一个 JSON 对象
  // 贪婪匹配会把"{...} 后面还有一段话"里的尾部也吞进来，非贪婪又会在 reason 含 '}' 时截断。
  // 稳妥做法是从第一个 '{' 起做花括号配平，取出完整的第一个 JSON 对象。
  const start = text.indexOf("{");
  if (start < 0) throw new Error(`裁判未返回 JSON: ${text.slice(0, 120)}`);
  let depth = 0;
  let end = -1;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) { escaped = false; continue; }
    if (character === "\\") { escaped = true; continue; }
    if (character === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (character === "{") depth += 1;
    else if (character === "}") { depth -= 1; if (depth === 0) { end = index; break; } }
  }
  if (end < 0) throw new Error(`裁判返回的 JSON 不完整: ${text.slice(start, start + 160)}`);
  const parsed = JSON.parse(text.slice(start, end + 1));
  const scores = {};
  for (const key of ["faithfulness", "relevance", "completeness"]) {
    // 裁判有时把分数写成字符串（"5" 而不是 5）。这是格式差异，不是评分错误，
    // 因此按数字解析而不是直接丢弃整条评测——丢弃会让样本量悄悄变小并偏向"好答案"。
    const value = typeof parsed[key] === "string" ? Number(parsed[key].trim()) : parsed[key];
    if (!Number.isInteger(value) || value < 0 || value > 5) throw new Error(`裁判给出非法 ${key}: ${JSON.stringify(parsed[key])}`);
    scores[key] = value;
  }
  return { ...parsed, ...scores };
}

/** 与 eval-rag.mjs 同一口径：ceil 取分位，n<100 时标注 p99 不可信。 */
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

const labels = await loadLabels();
const realCorpus = useReal ? buildRealCorpus(process.cwd(), "section") : undefined;
const queries = useReal
  // 等距抽样，保证同一语料每次跑同一批查询，数字可比。
  ? (() => {
    const all = buildRealQuerySet(realCorpus.queryTopics, realCorpus.headings);
    if (all.length <= queryLimit) return all;
    const step = all.length / queryLimit;
    const out = [];
    for (let index = 0; out.length < queryLimit && Math.floor(index) < all.length; index += step) {
      out.push(all[Math.floor(index)]);
    }
    return out;
  })()
  : buildQuerySet().slice(0, queryLimit);
const grade = useReal ? gradeForReal : gradeFor;
const rows = [];
let answerFailures = 0;
let judgeFailures = 0;
// 三层分开计时。只有一个总数无法判断成本花在检索还是生成上，也就无法决定往哪优化。
// 裁判调用单独统计并**排除在端到端之外**：它是评测装置的开销，不是被测系统的成本。
const latencies = { retrieval: [], generation: [], end_to_end: [], judge: [] };
const tokens = { answer_input: 0, answer_output: 0, answer_total: 0, judge_total: 0 };
let answerCalls = 0;

for (const query of queries) {
  const tRetrieval = performance.now();
  const pack = await gateway.retrieve({
    query_id: `answer.${query.query_id}`, original_query: query.query_natural,
    intent, agent_id: "eval.harness", principal: { tenant_id: tenantId },
    purpose: "learning_support", token_budget: 8_000, estimated_chunk_tokens: 120,
    require_citations: true,
  });
  const retrievalMs = performance.now() - tRetrieval;

  const evidenceBlock = pack.evidence
    .map((item, index) => `[${index + 1}] ${item.untrusted_content}`)
    .join("\n\n");

  // 客观指标：引用的 chunk 有多少确实与该 topic 相关（grade >= 2）
  const grades = pack.evidence.map((item) => {
    const label = labels.get(item.evidence_id);
    return label ? grade(query, label) : 0;
  });
  const citationPrecision = grades.length === 0 ? 0 : grades.filter((g) => g >= 2).length / grades.length;

  if (pack.evidence.length === 0) {
    rows.push({ query_id: query.query_id, evidence: 0, citation_precision: 0, skipped: "no_evidence" });
    continue;
  }

  let answer;
  let generationMs = 0;
  try {
    const tGeneration = performance.now();
    const generated = await modelGateway.generate({
      request_id: `answer.${query.query_id}`, workload: "eval.judge",
      system_prompt: ANSWER_SYSTEM,
      user_prompt: `问题：${query.query_natural}\n\n证据：\n${evidenceBlock}`,
      max_output_tokens: 512, budget,
      snapshots: { prompt: "eval.answer.v1", context: pack.query_id, policy: "eval" },
    });
    generationMs = performance.now() - tGeneration;
    answer = generated.text.trim();
    // usage 来自模型网关的账本口径，与 questlab.model_invocation 同源，不在评测侧重算。
    const usage = generated.usage ?? {};
    tokens.answer_input += usage.input_tokens ?? 0;
    tokens.answer_output += usage.output_tokens ?? 0;
    tokens.answer_total += usage.total_tokens ?? 0;
    answerCalls += 1;
    latencies.retrieval.push(retrievalMs);
    latencies.generation.push(generationMs);
    latencies.end_to_end.push(retrievalMs + generationMs);
  } catch (error) {
    answerFailures += 1;
    rows.push({ query_id: query.query_id, evidence: pack.evidence.length, citation_precision: citationPrecision, skipped: `answer_failed:${error.message.slice(0, 60)}` });
    continue;
  }

  // 裁判偶发地吐出不完整或带尾巴的 JSON（实测约 1/32；同一提示单独重跑 8/8 正常），
  // 说明这是采样波动而非提示词问题。直接丢弃会让样本量悄悄变小，且丢掉的多是裁判"犹豫"
  // 的样本，统计会偏向好答案，所以重试三次；三次都失败才计入失败并保留最后一次错误。
  let judged;
  let judgeError;
  for (let attempt = 1; attempt <= 3 && judged === undefined; attempt += 1) {
    try {
      const tJudge = performance.now();
      const judgement = await modelGateway.generate({
        request_id: `judge.${query.query_id}.${attempt}`, workload: "eval.judge",
        system_prompt: JUDGE_SYSTEM,
        user_prompt: `问题：${query.query_natural}

证据：
${evidenceBlock}

模型回答：
${answer}`,
        // 1024 而非 512：裁判偶尔把 reason 写得很长，JSON 在 512 处被截断，整条评测就得作废。
        max_output_tokens: 1024, budget,
        snapshots: { prompt: "eval.judge.v1", context: pack.query_id, policy: "eval" },
      });
      latencies.judge.push(performance.now() - tJudge);
      tokens.judge_total += judgement.usage?.total_tokens ?? 0;
      judged = parseJudgement(judgement.text);
    } catch (error) {
      judgeError = error;
    }
  }
  if (judged === undefined) {
    judgeFailures += 1;
    rows.push({ query_id: query.query_id, evidence: pack.evidence.length, citation_precision: citationPrecision, answer, skipped: `judge_failed:${judgeError.message.slice(0, 60)}` });
    continue;
  }

  rows.push({
    query_id: query.query_id, topic_id: query.topic_id,
    evidence: pack.evidence.length, citation_precision: Number(citationPrecision.toFixed(3)),
    faithfulness: judged.faithfulness, relevance: judged.relevance, completeness: judged.completeness,
    reason: judged.reason, answer_chars: answer.length,
    retrieval_ms: Math.round(retrievalMs), generation_ms: Math.round(generationMs),
    end_to_end_ms: Math.round(retrievalMs + generationMs),
    // 打过分的内容必须可复核。只留分数不留原文，第二标注者无从校验，
    // 分数就变成不可审计的数字。
    question: query.query_natural,
    answer,
    evidence_preview: pack.evidence.map((item) => item.untrusted_content.slice(0, 120)),
  });
  process.stderr.write(`  ${query.query_id}: F=${judged.faithfulness} R=${judged.relevance} C=${judged.completeness} 引用精确率=${citationPrecision.toFixed(2)}\n`);
}

const scored = rows.filter((row) => row.faithfulness !== undefined);
const meanOf = (pick) => scored.length === 0 ? null : Number((scored.reduce((a, r) => a + pick(r), 0) / scored.length).toFixed(3));
const distribution = (pick) => {
  const out = {};
  for (const row of scored) out[pick(row)] = (out[pick(row)] ?? 0) + 1;
  return out;
};

console.log(JSON.stringify({
  intent, rerank: useRerank, queries: queries.length, judged: scored.length,
  answer_failures: answerFailures, judge_failures: judgeFailures,
  skipped: rows.filter((r) => r.skipped).map((r) => ({ query_id: r.query_id, reason: r.skipped })),
  // 裁判打分（0-5）
  faithfulness: { mean: meanOf((r) => r.faithfulness), distribution: distribution((r) => r.faithfulness) },
  relevance: { mean: meanOf((r) => r.relevance), distribution: distribution((r) => r.relevance) },
  completeness: { mean: meanOf((r) => r.completeness), distribution: distribution((r) => r.completeness) },
  // 客观指标，独立于裁判，用标注直接算
  citation_precision_mean: meanOf((r) => r.citation_precision),
  mean_evidence: meanOf((r) => r.evidence),
  mean_answer_chars: meanOf((r) => r.answer_chars),
  // 时延分三层。end_to_end = 检索 + 生成，**不含裁判**：裁判是评测装置的开销，
  // 把它算进去会让被测系统看起来比实际慢一倍。
  latency_ms: {
    retrieval: summarize(latencies.retrieval),
    generation: summarize(latencies.generation),
    end_to_end: summarize(latencies.end_to_end),
    judge_harness_only: summarize(latencies.judge),
  },
  // token 成本。answer_* 是被测系统的真实成本；judge_* 只是评测开销，分开报。
  token_cost: {
    answer_calls: answerCalls,
    answer_input_total: tokens.answer_input,
    answer_output_total: tokens.answer_output,
    answer_total: tokens.answer_total,
    answer_per_query: answerCalls === 0 ? null : Math.round(tokens.answer_total / answerCalls),
    judge_total_harness_only: tokens.judge_total,
  },
  per_query: rows,
}, null, 2));
await db.destroy();
