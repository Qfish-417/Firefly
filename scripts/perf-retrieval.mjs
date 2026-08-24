/**
 * RAG 检索延迟基准。
 *
 * 走真实的 RetrievalGateway（计划、RRF 融合、ACL 授权、证据选择、契约校验），而不是裸 SQL：
 * 裸 SQL 只能量化数据库，量化不了治理层在每次查询上的固定开销。
 *
 * Embedding 用确定性本地 stub，因此测出的是数据库与网关成本，不含 provider 网络延迟。
 * 真实 provider 的延迟应当单独测量，混在一起会掩盖数据量带来的退化。
 *
 * 用法：
 *   node --env-file=<env> scripts/perf-retrieval.mjs [--iterations 50] [--warmup 5] [--label 100k]
 *
 * 需要 DATABASE_URL 指向已用 scripts/perf-seed.sql 灌过数据的库。
 */
import { createDatabase } from "../packages/persistence/src/database.ts";
import {
  PostgresMemoryAuthorization,
  PostgresLexicalRetriever,
  PostgresVectorRetriever,
} from "../packages/retrieval-postgres/src/index.ts";
import { RetrievalGateway } from "../packages/retrieval-service/src/index.ts";

const argument = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const iterations = Number(argument("iterations", "50"));
const warmup = Number(argument("warmup", "5"));
const label = argument("label", "unlabelled");
const logicalName = argument("logical-name", "memory-main");
const embeddingModel = argument("embedding-model", "perf-embed-256");
const dimensions = Number(argument("dimensions", "256"));

if (!Number.isInteger(iterations) || iterations < 1) throw new TypeError("--iterations must be a positive integer");
if (!Number.isInteger(warmup) || warmup < 0) throw new TypeError("--warmup must be a non-negative integer");
if (!process.env.DATABASE_URL) throw new TypeError("DATABASE_URL is required");

/**
 * 确定性 embedding：同一 query 恒定产生同一向量，且与 perf-seed.sql 的生成方式同族，
 * 因此相似度分布有意义，而不是随机噪声。
 */
const stubEmbeddings = {
  async embed(request) {
    const text = request.inputs[0] ?? "";
    let seed = 0;
    for (let index = 0; index < text.length; index += 1) seed = (seed * 31 + text.charCodeAt(index)) % 100_000;
    const vector = Array.from({ length: dimensions }, (_, g) => ((seed + g * 17) % 1000) / 1000);
    return {
      vectors: [vector],
      usage: { input_tokens: 4, output_tokens: 0, cached_input_tokens: 0, total_tokens: 4, cost_usd: 0 },
    };
  },
};

const budget = { max_tokens: 1_000, max_cost_usd: 0, max_duration_ms: 30_000 };
/**
 * 基准脚本会写入并删除数据，必须指向专用库。
 * 误跑在 questlab 主库上会污染运行事实表与审计账本，因此这里 fail closed 而不是给出警告。
 */
function assertPerfDatabase(url) {
  const database = url.split("/").pop()?.split("?")[0] ?? "";
  // 本脚本只读（无 INSERT/UPDATE/DELETE），但仍然限制库名：
  // 误指向 questlab 主库虽不会改数据，却会让"基准数字"实际反映生产库的缓存状态。
  // 允许 demo 是为了量化 rag-seed.mjs 灌入的真实语料。
  if (!/perf|demo/i.test(database)) {
    throw new Error(
      `Refusing to run a benchmark against database "${database}": ` +
      `the name must contain "perf" or "demo" (e.g. questlab_perf). Benchmarks may write and delete rows.`,
    );
  }
}

assertPerfDatabase(process.env.DATABASE_URL);
const db = createDatabase(process.env.DATABASE_URL);

const tenantId = argument("tenant", "tenant.perf");
const indexVersionId = argument("index-version", "iv.perf.001");
const principal = { tenant_id: tenantId };

/**
 * 合成语料（perf-seed.sql）与真实语料（rag-seed.mjs）的查询词不同，
 * 用合成语料的词去查真实语料会得到 0 命中，测出的是"空结果有多快"，没有意义。
 * 因此 --corpus 决定查询集，默认沿用合成语料。
 */
const corpora = {
  synthetic: [
    "solar cohort seasonal",
    "irradiance mastery latitude",
    "photovoltaic retention equinox",
    "zenith scaffold declination",
    "albedo beginner atmosphere",
  ],
  // 对应 rag-seed.mjs 的 8 个事实点，中英混合，覆盖不同学习阶段表述
  demo: [
    "固定倾角 纬度 关系",
    "温度系数 对输出 的影响",
    "反射率 双面组件 背面增益",
    "阴影遮挡 旁路二极管 损失",
    "逆变器 限幅 容配比",
    "光谱 大气质量 AM1.5",
    "组件 衰减率 质保",
    "晴空指数 辐照 资源",
  ],
};
const corpusName = argument("corpus", "synthetic");
const queries = corpora[corpusName];
if (!queries) throw new TypeError(`--corpus must be one of: ${Object.keys(corpora).join(", ")}`);

function gateway(stages) {
  const retrievers = [];
  if (stages.includes("lexical")) retrievers.push(new PostgresLexicalRetriever(db, "postgres.fts.simple.v1", logicalName));
  if (stages.includes("vector")) {
    retrievers.push(new PostgresVectorRetriever({
      db,
      embeddings: stubEmbeddings,
      embedding_model: embeddingModel,
      embedding_budget: budget,
      logical_name: logicalName,
    }));
  }
  return new RetrievalGateway({ retrievers, authorization: new PostgresMemoryAuthorization(db, logicalName) });
}

function request(index) {
  return {
    query_id: `q.perf.${label}.${index}`,
    original_query: queries[index % queries.length],
    intent: "fact_lookup",
    agent_id: "learning-scientist",
    principal,
    purpose: "answer",
    token_budget: 4_000,
    estimated_chunk_tokens: 40,
    require_citations: true,
  };
}

function summarize(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  const mean = sorted.reduce((total, value) => total + value, 0) / sorted.length;
  return {
    n: sorted.length,
    mean: Number(mean.toFixed(2)),
    p50: Number(at(0.5).toFixed(2)),
    p95: Number(at(0.95).toFixed(2)),
    p99: Number(at(0.99).toFixed(2)),
    max: Number(sorted.at(-1).toFixed(2)),
  };
}

async function measure(name, stages) {
  const service = gateway(stages);
  let hits = 0;
  for (let index = 0; index < warmup; index += 1) {
    await service.retrieve(request(index));
  }
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    const pack = await service.retrieve(request(index));
    samples.push(performance.now() - startedAt);
    hits += pack.evidence.length;
  }
  return { stage: name, ...summarize(samples), mean_evidence: Number((hits / iterations).toFixed(1)) };
}

try {
  const counts = await db
    .selectFrom("questlab.memory_chunk")
    .select((expression) => expression.fn.countAll().as("chunks"))
    .where("index_version_id", "=", indexVersionId)
    .executeTakeFirst();

  const rows = [];
  rows.push(await measure("lexical", ["lexical"]));
  rows.push(await measure("vector", ["vector"]));
  rows.push(await measure("hybrid", ["lexical", "vector"]));

  console.log(JSON.stringify({
    label,
    corpus: corpusName,
    tenant_id: tenantId,
    index_version_id: indexVersionId,
    chunks: Number(counts?.chunks ?? 0),
    iterations,
    warmup,
    unit: "ms",
    results: rows,
  }, null, 2));
} finally {
  await db.destroy();
}
