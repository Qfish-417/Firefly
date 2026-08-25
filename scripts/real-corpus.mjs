/**
 * 真实文档语料：把仓库内的 Markdown 切成 chunk，并从文件路径推导相关性标注。
 *
 * 为什么需要它：`eval-corpus.mjs` 是合成语料，同一个 `(topic, facet)` 下只有 depth 不同的近重复
 * 段落。它能让 Recall@k 可算，但分数分布、术语多样性、文档长度都不像真实文本，所以
 * halfvec 近似召回率、`relative_floor` 定标这类结论的适用范围一直无法确认。
 *
 * 标注怎么来：真实文档没有相关性标签，而 R@10 必须有。三种来源里——
 *   1. 人工标注：最可信，但 96 查询 × 5432 chunk 无法穷举
 *   2. LLM 判断：裁判与被测同模型，且已测出裁判与独立标注者相关系数只有 0.248
 *   3. 结构化弱标注：用文档自身结构推导
 * 选 3。查询以「某个 npm 包 / 某个文档主题」为目标，相关集就是该来源下的全部 chunk。这个映射
 * 来自文件路径，是客观事实，不依赖任何判断，任何人都能复核。
 *
 * 这个标注的**已知偏差**必须写明：它假设「同一个包的文档都与该包的查询相关」。对
 * `pkg:openai` 这种 847 chunk 的大包，其中确实有与查询无关的段落（更新日志、许可证），
 * 所以标注偏宽松，Recall 会被高估、Precision 会被低估。反过来，跨包讲同一概念的段落
 * （多个包都讲 stream）会被判为不相关，这部分让 Precision 又被高估。两个偏差方向相反，
 * 不能假设互相抵消，因此本语料的绝对值只用于与合成语料对照，不作为达标依据。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep, basename } from "node:path";
import { createHash } from "node:crypto";

/**
 * 把任意路径/主题名压成合法的 entity_key。契约限制 `^[A-Za-z0-9][A-Za-z0-9._:@/-]*$`，而真实路径
 * 里有中文文件名、空格、括号。非 ASCII 换成短哈希后缀而不是直接删除，否则 `a/中文.md` 与
 * `a/日本語.md` 会塌成同一个 key，两份不同来源被当成一份。
 *
 * 播种与评测必须用同一份实现：曾经各写一份，评测侧没编码，导致所有查询判成零命中。
 */
export function safeKey(value) {
  const ascii = value.replace(/[^A-Za-z0-9._/:-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "");
  const suffix = createHash("sha256").update(value).digest("hex").slice(0, 8);
  return `${ascii || "key"}.${suffix}`;
}

const MIN_CHUNK_CHARS = 120;
const MAX_CHUNK_CHARS = 700;

/** 相关集至少这么大才配得上一条查询：太小的 topic 一次检索就能穷尽，测不出排序能力。 */
const MIN_RELEVANT = 8;

/**
 * 相关集上限。超过这个大小的 topic 不生成查询（chunk 仍留在语料里当干扰项）。
 *
 * 不是为了把数字做得好看，而是因为超大相关集让 R@10 失去分辨力：`pkg:openai` 有 847 个 chunk，
 * 取 10 条最多覆盖 1.2%，无论排序多好 R@10 都接近 0，指标不再反映检索质量。实测相关集 >100 的
 * 10 条查询 R@10 全部低于 0.02，其中 `pkg:dayjs` 的 P@10 已经是 1.00（前 10 条全对）却仍只有
 * R@10 = 0.018 —— 这时 Recall 衡量的是标注粒度，不是检索能力。
 */
const MAX_RELEVANT = 60;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

/**
 * 切分策略：先按 h1-h4 分节，再按空行分段累积到 MAX_CHUNK_CHARS。
 *
 * 不按固定字符数硬切，因为那样会把代码块和表格截断在中间，产生语义不完整的 chunk ——
 * 检索器会拿到半个句子，评测出来的分数就不反映真实能力。
 */
export function chunkMarkdown(text) {
  const out = [];
  for (const section of text.split(/\n(?=#{1,4} )/)) {
    const trimmed = section.trim();
    if (trimmed.length < MIN_CHUNK_CHARS) continue;
    let buffer = "";
    for (const paragraph of trimmed.split(/\n\s*\n/)) {
      const para = paragraph.trim();
      if (!para) continue;
      if (buffer.length + para.length < MAX_CHUNK_CHARS) {
        buffer = buffer ? `${buffer}\n\n${para}` : para;
      } else {
        if (buffer.length >= MIN_CHUNK_CHARS) out.push(buffer);
        buffer = para.length < MAX_CHUNK_CHARS ? para : para.slice(0, MAX_CHUNK_CHARS);
      }
    }
    if (buffer.length >= MIN_CHUNK_CHARS) out.push(buffer);
  }
  return out;
}

/** 从路径推导 topic。这是全部标注的来源，所以必须只依赖路径，不看内容。 */
export function topicOf(path) {
  const p = path.split(sep).join("/");
  const pkg = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(p);
  if (pkg) return `pkg:${pkg[1]}`;
  if (p.includes("/docs/adr/")) return "doc:adr";
  if (p.includes("/legacy/")) return "doc:legacy";
  if (p.includes("/docs/")) return `doc:${basename(p, ".md")}`;
  return "doc:root";
}

/**
 * 标注粒度。两种都由路径推导，都可复核，但对 R@10 的分辨力不同：
 * - `package`：一个 npm 包 / 一个文档主题算一个 topic。相关集 8~847，粒度粗。
 * - `file`：一个 Markdown 文件算一个 topic。相关集 8~58，粒度细，R@10 上限 0.642。
 *
 * 默认用 `file`，因为它让 Recall 真正反映排序质量而不是标注宽窄；`package` 保留用于对照，
 * 它更接近"用户问一个库怎么用"的真实意图，只是不适合做 Recall 的分母。
 */
export function buildRealCorpus(rootDir, granularity = "file") {
  const byTopic = new Map();
  for (const file of walk(rootDir)) {
    if (statSync(file).size > 4_000_000) continue;
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const relative = file.split(sep).join("/").replace(rootDir.split(sep).join("/"), "").replace(/^\//, "");
    const topic = granularity === "file" ? `file:${relative}` : topicOf(file);
    const list = byTopic.get(topic) ?? [];
    for (const [index, content] of chunkMarkdown(text).entries()) {
      list.push({ content, topic_id: topic, source_path: relative, ordinal: index });
    }
    byTopic.set(topic, list);
  }

  const chunks = [];
  for (const list of byTopic.values()) for (const chunk of list) chunks.push(chunk);

  // 只有相关集足够大的 topic 才生成查询，但**所有** chunk 都进语料：小 topic 继续充当干扰项，
  // 这与合成语料里干扰 topic 的作用一致。
  const queryTopics = [...byTopic.entries()]
    .filter(([, list]) => list.length >= MIN_RELEVANT && list.length <= MAX_RELEVANT)
    .map(([topic]) => topic)
    .sort();

  return { chunks, queryTopics, relevantCounts: new Map([...byTopic].map(([k, v]) => [k, v.length])) };
}

/**
 * 查询文本。用 topic 名字本身当查询，因为它是唯一不看 chunk 内容就能得到的描述 ——
 * 若从 chunk 里挑句子当查询，那句话必然出现在某个 chunk 中，检索退化成字符串匹配。
 */
export function buildRealQuerySet(queryTopics) {
  const built = queryTopics.map((topic, index) => {
    // Scope must stay in the query. Dropping it turned `@anthropic-ai/sdk` into "how do I use sdk",
    // which is a different question entirely: measured, that query returned chunks from `openai` and
    // from an ADR, scoring P@10 = 0 against a 473-chunk relevant set. 16 of 96 queries were affected.
    // 文件级粒度：用「包名 + 文件名」当查询，两者都来自路径。只用文件名不行——node_modules 里
    // 有 200 多个 README.md，查询会完全无法区分；只用包名也不行，那就退回粗粒度了。
    if (topic.startsWith("file:")) {
      const path = topic.slice(5);
      const pkg = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(path);
      const file = basename(path, ".md").replace(/[-_]/g, " ");
      const scope = pkg ? pkg[1].replace(/^@/, "").replace(/\//g, " ").replace(/[-_]/g, " ") : "firefly questlab";
      const readable = file.toLowerCase() === "readme" ? scope : `${scope} ${file}`;
      return {
        query_id: `rq.${String(index + 1).padStart(3, "0")}`,
        topic_id: topic,
        query_natural: `how do I use ${readable}`,
        query_tokenized: readable,
      };
    }
    const bare = topic.replace(/^pkg:/, "").replace(/^doc:/, "").replace(/^@/, "").replace(/\//g, " ");
    const readable = bare.replace(/[-_]/g, " ");
    return {
      query_id: `rq.${String(index + 1).padStart(3, "0")}`,
      topic_id: topic,
      query_natural: topic.startsWith("pkg:")
        ? `how do I use ${readable}`
        : `what does the ${readable} document specify`,
      query_tokenized: readable,
    };
  });
  // 同名查询必须丢掉：两个 topic 得到同一句查询时，任何一次检索对其中一个是正确答案、对另一个
  // 就是错误答案，Recall 与 Precision 都不再有意义。实测 file 粒度下有 5 条这样的碰撞。
  const seen = new Map();
  for (const query of built) {
    seen.set(query.query_natural, (seen.get(query.query_natural) ?? 0) + 1);
  }
  return built.filter((query) => seen.get(query.query_natural) === 1);
}

export function gradeForReal(query, label) {
  if (!label) return 0;
  return label.topic_id === query.topic_id ? 3 : 0;
}
