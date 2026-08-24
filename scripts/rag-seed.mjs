/**
 * RAG 测试语料生成器。
 *
 * 与 scripts/perf-seed.sql 的区别：
 *   perf-seed.sql 直接写表，用合成向量，只为量化延迟；
 *   本脚本走真实的 PostgresMemoryIndexer 与真实 Embedding provider，
 *   因此产出的数据可以被真实检索链路命中，能用来判断"检索到底找得对不对"。
 *
 * 语料是关于太阳能学习课程的中文/英文混合内容，围绕若干可验证的事实点生成，
 * 因此可以用已知答案的问题去检验召回质量，而不是只看延迟。
 *
 * 用法（需要 SSH 隧道或本机 vLLM 可达）：
 *   node --env-file=infra/compose/questlab-vllm.env scripts/rag-seed.mjs --docs 200 --chunks 6
 *
 * 无 Embedding 配置时只写词法可检索的内容，不伪造向量。
 */
import { createHash } from "node:crypto";

import { createDatabase } from "../packages/persistence/src/database.ts";
import { PostgresMemoryIndexer } from "../packages/retrieval-postgres/src/index.ts";
import { HttpEmbeddingProvider } from "../packages/model-gateway/src/http-embedding-provider.ts";
import { sql } from "kysely";

const argument = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const documents = Number(argument("docs", "200"));
const chunksPerDocument = Number(argument("chunks", "6"));
const tenantId = argument("tenant", "tenant.demo");
const logicalName = argument("logical-name", process.env.RETRIEVAL_LOGICAL_NAME?.trim() || "memory.hybrid");
const indexVersionId = argument("index-version", "iv.demo.001");
const batchSize = Number(argument("batch", "32"));
/**
 * chunk_id 与 memory_id 的命名空间。
 *
 * Chunk 内容是不可变的：同一个 chunk_id 配不同内容会被 ChunkIdentityConflictError 拒绝
 * （这是设计上的保护，不是缺陷）。因此改变 --chunks 后重新灌数据必须换 --run 前缀，
 * 否则前 N 个 chunk_id 会与上一批重合而内容不同。
 */
const runTag = argument("run", "001");

if (!Number.isSafeInteger(documents) || documents < 1) throw new TypeError("--docs must be a positive integer");
if (!Number.isSafeInteger(chunksPerDocument) || chunksPerDocument < 1) throw new TypeError("--chunks must be a positive integer");
if (!process.env.DATABASE_URL) throw new TypeError("DATABASE_URL is required");

/**
 * 主题矩阵。每个主题带一个可验证的事实点，用于后续断言"问 X 是否召回到 X 的来源"。
 * 内容刻意让不同主题共享部分词汇（如 "efficiency"、"角度"），这样词法检索会产生
 * 真实的竞争与排序压力，而不是每个查询只有唯一命中。
 */
const topics = [
  { key: "tilt-angle", title: "固定倾角与纬度的关系", fact: "固定式光伏阵列的最佳倾角约等于当地纬度", terms: ["倾角", "纬度", "tilt", "latitude"] },
  { key: "temperature-coefficient", title: "温度系数对输出的影响", fact: "晶硅组件功率温度系数约为每摄氏度负零点三五个百分点", terms: ["温度系数", "temperature", "coefficient", "输出"] },
  { key: "albedo", title: "地表反射率与双面组件", fact: "雪地反射率可达零点八，显著提升双面组件背面增益", terms: ["反射率", "albedo", "双面", "bifacial"] },
  { key: "shading-loss", title: "阴影遮挡与旁路二极管", fact: "单个电池片被遮挡可使整串输出下降超过三分之一", terms: ["遮挡", "阴影", "shading", "二极管"] },
  { key: "inverter-clipping", title: "逆变器限幅与容配比", fact: "直交流容配比超过一点三时限幅损失开始显著", terms: ["逆变器", "限幅", "clipping", "容配比"] },
  { key: "spectral-response", title: "光谱响应与大气质量", fact: "大气质量一点五是光伏标准测试条件的参考光谱", terms: ["光谱", "spectral", "大气质量", "AM1.5"] },
  { key: "degradation-rate", title: "衰减率与质保", fact: "主流组件线性衰减率约为每年零点五个百分点", terms: ["衰减", "degradation", "质保", "线性"] },
  { key: "clearness-index", title: "晴空指数与辐照资源", fact: "晴空指数是地表辐照与大气层外辐照之比", terms: ["晴空指数", "clearness", "辐照", "irradiance"] },
];

/** 面向不同学习阶段的表述，使同一事实点有多个可召回的表达。 */
const audiences = [
  { key: "beginner", label: "初学者导入", frame: "用生活化的类比先建立直觉" },
  { key: "intermediate", label: "进阶推导", frame: "引入公式与单位换算" },
  { key: "advanced", label: "工程实践", frame: "结合实测数据与误差范围" },
  { key: "misconception", label: "常见误解", frame: "指出典型错误理解并给出反例" },
];

const sourceTypes = ["text/markdown", "application/pdf", "text/html", "text/plain"];

/** 确定性伪随机：同一参数下语料完全可复现，便于对比两次检索结果的差异。 */
function hashInt(...parts) {
  const digest = createHash("sha256").update(parts.join(":"), "utf8").digest();
  return digest.readUInt32BE(0);
}

function buildContent(documentIndex, chunkIndex) {
  const topic = topics[hashInt("topic", documentIndex, chunkIndex) % topics.length];
  const audience = audiences[hashInt("audience", documentIndex, chunkIndex) % audiences.length];
  const lesson = 1 + (hashInt("lesson", documentIndex) % 12);
  const detail = 1 + (hashInt("detail", documentIndex, chunkIndex) % 5);

  // 段落长度随哈希变化：内容长度一致会让 ts_rank_cd 给出雷同分数，
  // 证据选择阶段就无法体现真实的排序竞争。
  const filler = Array.from(
    { length: 2 + (hashInt("len", documentIndex, chunkIndex) % 6) },
    (_, index) => `补充说明${detail}-${index + 1}：该结论在课程第${lesson}讲的随堂练习中被反复使用。`,
  ).join("");

  return {
    topic,
    audience,
    content:
      `【${topic.title}｜${audience.label}】` +
      `${audience.frame}。核心事实：${topic.fact}。` +
      `关键词：${topic.terms.join("、")}。` +
      `本段属于太阳能课程第${lesson}讲的第${chunkIndex}个知识片段。${filler}`,
  };
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
      timeout_ms: 60_000,
      allow_insecure_localhost: process.env.EMBEDDING_ALLOW_INSECURE_LOCALHOST === "true",
      send_dimensions: process.env.EMBEDDING_SEND_DIMENSIONS === "true",
      ...(process.env.EMBEDDING_API_KEY?.trim() ? { api_key: process.env.EMBEDDING_API_KEY.trim() } : {}),
    }),
    snapshot: process.env.EMBEDDING_MODEL_SNAPSHOT?.trim() || model,
    dimensions,
  };
}

const embedding = embeddingProvider();
const indexer = new PostgresMemoryIndexer(db);

try {
  // 索引版本与 memory/ACL 行必须先存在：缺 ACL 行时检索会返回 0 行，
  // 看起来像"没有数据"而不是"没有权限"。
  await sql`
    INSERT INTO questlab.retrieval_index_version
      (index_version_id, build_id, tenant_id, logical_name, index_kind, provider,
       configuration_digest, embedding_model, embedding_dimensions, source_watermark, status,
       document_count, chunk_count, requested_at, ready_at, activated_at)
    VALUES (${indexVersionId}, ${`build.${indexVersionId}`}, ${tenantId}, ${logicalName},
       ${embedding ? "hybrid" : "lexical"}, 'postgres',
       ${`sha256:${createHash("sha256").update(indexVersionId).digest("hex")}`},
       ${embedding?.snapshot ?? null}, ${embedding?.dimensions ?? null}, 'wm.1', 'active',
       0, 0, now(), now(), now())
    ON CONFLICT DO NOTHING
  `.execute(db);

  let indexed = 0;
  let embedded = 0;

  for (let documentIndex = 1; documentIndex <= documents; documentIndex += 1) {
    const memoryId = `mem.demo.${runTag}.${documentIndex}`;
    await sql`
      INSERT INTO questlab.memory_record
        (memory_id, tenant_id, owner_type, owner_id, scope, stage, kind, content_digest,
         confidence, sensitivity, status)
      VALUES (${memoryId}, ${tenantId}, 'tenant', ${tenantId}, 'tenant', 'semantic', 'fact',
         ${`sha256:${createHash("sha256").update(memoryId).digest("hex")}`}, 0.9, 'internal', 'active')
      ON CONFLICT DO NOTHING
    `.execute(db);
    await sql`
      INSERT INTO questlab.memory_acl (memory_id, principal_type, principal_id, permission)
      VALUES (${memoryId}, 'tenant', ${tenantId}, 'read')
      ON CONFLICT DO NOTHING
    `.execute(db);

    const pending = [];
    for (let chunkIndex = 1; chunkIndex <= chunksPerDocument; chunkIndex += 1) {
      const { content, topic } = buildContent(documentIndex, chunkIndex);
      pending.push({
        chunk_id: `chunk.demo.${runTag}.${documentIndex}.${chunkIndex}`,
        memory_id: memoryId,
        index_version_id: indexVersionId,
        ordinal: chunkIndex,
        chunk_level: "child",
        content,
        chunk_digest: `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`,
        token_count: Math.max(1, Math.round(content.length / 2)),
        source_type: sourceTypes[hashInt("src", documentIndex, chunkIndex) % sourceTypes.length],
        entity_keys: [`topic.${topic.key}`, `lesson.${1 + (hashInt("lesson", documentIndex) % 12)}`],
        citation: {
          artifact_id: `artifact.demo.${runTag}.${documentIndex}`,
          uri: `https://artifacts.firefly.local/solar/${documentIndex}.md`,
          digest: `sha256:${createHash("sha256").update(`artifact.${documentIndex}`).digest("hex")}`,
          locator: { chunk: chunkIndex, topic: topic.key },
        },
      });
    }

    // Embedding 按批请求：逐条会让 200 篇文档变成上千次往返。
    if (embedding) {
      for (let offset = 0; offset < pending.length; offset += batchSize) {
        const slice = pending.slice(offset, offset + batchSize);
        const result = await embedding.provider.embed({
          request_id: `rag-seed:${documentIndex}:${offset}`,
          workload: "retrieval.corpus.embed",
          inputs: slice.map((item) => item.content),
          budget: { max_tokens: 1_000_000, max_cost_usd: 0, max_duration_ms: 120_000 },
        });
        result.vectors.forEach((vector, position) => {
          slice[position].embedding = vector;
          slice[position].embedding_model = embedding.snapshot;
        });
        embedded += slice.length;
      }
    }

    for (const chunk of pending) {
      await indexer.index(chunk);
      indexed += 1;
    }

    if (documentIndex % 25 === 0 || documentIndex === documents) {
      process.stdout.write(`  已写入 ${documentIndex}/${documents} 篇，${indexed} 个 chunk\n`);
    }
  }

  await sql`
    UPDATE questlab.retrieval_index_version
       SET document_count = (SELECT count(*) FROM questlab.memory_record WHERE tenant_id = ${tenantId}),
           chunk_count = (SELECT count(*) FROM questlab.memory_chunk WHERE index_version_id = ${indexVersionId})
     WHERE index_version_id = ${indexVersionId}
  `.execute(db);
  await sql`ANALYZE questlab.memory_chunk`.execute(db);
  await sql`ANALYZE questlab.memory_record`.execute(db);
  await sql`ANALYZE questlab.memory_acl`.execute(db);

  console.log(JSON.stringify({
    tenant_id: tenantId,
    run_tag: runTag,
    index_version_id: indexVersionId,
    logical_name: logicalName,
    documents,
    chunks: indexed,
    embedded_chunks: embedded,
    vector_search: embedding ? "enabled" : "disabled (EMBEDDING_* not configured)",
    topics: topics.map((topic) => topic.key),
  }, null, 2));
} finally {
  await db.destroy();
}
