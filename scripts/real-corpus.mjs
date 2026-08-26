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

/**
 * gold set 的合法区间。
 *
 * 权威数据集（MS MARCO、KILT 等）的标准相关集通常只有 1~5 篇，极少超过 10。之前用"同一文件的
 * 全部 chunk"当 gold set 是错的：`big-integer/README.md` 的 58 个 chunk 全被算成与
 * "how do I use big integer" 相关，其中 `#### shiftLeft(n)`、`#### square()` 这类 API 条目与
 * 查询没有任何词汇或语义重叠，任何检索器都不该把它们排进前 10。分母虚高一个量级，Recall 被
 * 系统性压低到理论上限的 43%，读起来像"检索只有四成能力"，实际衡量的是标注宽度。
 *
 * 改按**小节**（h1~h4）划分 gold set。实测本语料 4058 个小节里 99% 含 1~5 个 chunk，正好落在
 * 权威数据集的量级。上限设 8 而不是 5，是为了不丢掉少量偏长的小节；仍远小于文件粒度的 58。
 */
const MIN_RELEVANT = 1;
const MAX_RELEVANT = 8;

/**
 * 必须排除的文件：评测自身的产物。
 *
 * 起因是实测发现的语料污染。`docs/evaluation-report.md` 逐字包含查询文本——报告里写着
 * `≤6 字符（如"职责"、"产品定位"）`，而查询就是 `in ..., 1. 产品定位`。48 个 chunk 含 "R@10"。
 *
 * 双向都是错的：报告的 chunk 会作为竞争者挤掉真正的小节（污染分子），而报告自己的小节也进了
 * gold set，检索到它算"命中"（虚高）。评测文档描述评测语料，就是自我引用泄漏。
 */
const EXCLUDED_PATHS = [
  "docs/evaluation-report.md",
  "docs/performance-baseline.md",
  "README.md",
];

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
export function chunkMarkdown(text, { contextualize = true, documentLabel = "" } = {}) {
  const out = [];
  // 标题栈：h1~h4 的当前路径。一个 chunk 的上下文不只是它自己的小节标题，还包括所有父级标题
  // ——`## Overview` 在 `# pi-ai` 下和在 `# exceljs` 下是两回事。
  const stack = [];
  for (const [sectionIndex, section] of text.split(/\n(?=#{1,4} )/).entries()) {
    const trimmed = section.trim();
    const headingLine = trimmed.startsWith("#") ? trimmed.split("\n")[0] : "";
    const level = headingLine ? (/^#+/.exec(headingLine)?.[0].length ?? 1) : 0;
    // 小节标题。gold set 以小节为单位，所以每个 chunk 必须记住自己属于哪个小节，
    // 而标题本身又是唯一能不看正文就得到的"这一节讲什么"的描述，正好当查询。
    const heading = headingLine.replace(/^#+\s*/, "").trim();
    if (level > 0) {
      stack.length = Math.max(0, level - 1);
      stack[level - 1] = heading;
    }
    if (trimmed.length < MIN_CHUNK_CHARS) continue;
    // 文档标识 + 标题路径前置到每个 chunk。
    //
    // 起因是两个实测出的缺陷：
    //   1. 一个小节被切成多个 chunk 时，只有第 1 个带标题行，其余是纯正文，完全不含"这一节讲
    //      什么"。前 800 个 chunk 里只有 77% 以标题开头。修复后 gold set>1 的 R@10 从 0.502
    //      涨到 0.692。
    //   2. 文档自身的标识（包名/文件名）只存在 entity_keys 里，不在可检索文本里。查询提到
    //      `exceljs` 时，`exceljs/README.md` 的正文可能根本不含这个词，词法腿匹配不上，向量腿
    //      也拿不到这个信号。
    //
    // 产品侧的后果比跑分更重要：Agent 拿到一个中段 chunk 时，既不知道它属于哪一节，也不知道它
    // 出自哪个文档，引用和上下文都缺失。这是标准做法（contextual retrieval），不是为跑分改口径。
    const prefix = contextualize
      ? [documentLabel, ...stack.filter(Boolean)].filter(Boolean).join(" > ")
      : "";
    let buffer = "";
    const push = (value) => {
      if (value.length < MIN_CHUNK_CHARS) return;
      // 以标题开头的 chunk 只补文档标识，不重复标题路径，否则同一句话出现两次。
      const startsWithHeading = value.trimStart().startsWith("#");
      const applied = startsWithHeading
        ? (documentLabel && contextualize ? `${documentLabel}\n\n${value}` : value)
        : (prefix ? `${prefix}\n\n${value}` : value);
      out.push({
        content: applied,
        heading,
        section_index: sectionIndex,
      });
    };
    for (const paragraph of trimmed.split(/\n\s*\n/)) {
      const para = paragraph.trim();
      if (!para) continue;
      if (buffer.length + para.length < MAX_CHUNK_CHARS) {
        buffer = buffer ? `${buffer}\n\n${para}` : para;
      } else {
        push(buffer);
        buffer = para.length < MAX_CHUNK_CHARS ? para : para.slice(0, MAX_CHUNK_CHARS);
      }
    }
    push(buffer);
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
export function buildRealCorpus(rootDir, granularity = "section") {
  const byTopic = new Map();
  const headings = new Map();
  for (const file of walk(rootDir)) {
    if (statSync(file).size > 4_000_000) continue;
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const relative = file.split(sep).join("/").replace(rootDir.split(sep).join("/"), "").replace(/^\//, "");
    if (EXCLUDED_PATHS.includes(relative)) continue;
    // 文档标识：node_modules 下用包名（用户就是这么称呼它的），其余用文件名。这与查询里用来
    // 消歧的 scope 同源，都只依赖路径，不看正文。
    const packageName = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(relative)?.[1];
    const documentLabel = packageName ?? basename(relative, ".md").replace(/[-_]/g, " ");
    for (const [index, chunk] of chunkMarkdown(text, { documentLabel }).entries()) {
      const topic = granularity === "section"
        ? `sec:${relative}#${chunk.section_index}`
        : granularity === "file" ? `file:${relative}` : topicOf(file);
      const list = byTopic.get(topic) ?? [];
      list.push({ content: chunk.content, topic_id: topic, source_path: relative, ordinal: index });
      byTopic.set(topic, list);
      if (chunk.heading && !headings.has(topic)) headings.set(topic, chunk.heading);
    }
  }

  const chunks = [];
  for (const list of byTopic.values()) for (const chunk of list) chunks.push(chunk);

  // 只有 gold set 落在合法区间的 topic 才生成查询，但**所有** chunk 都进语料：其余继续充当
  // 干扰项，这与合成语料里干扰 topic 的作用一致。
  const queryTopics = [...byTopic.entries()]
    .filter(([topic, list]) => list.length >= MIN_RELEVANT && list.length <= MAX_RELEVANT
      // 小节粒度还要求有标题：没有标题就没有"不看正文可得的查询"，只能靠正文造查询，
      // 那会退化成字符串匹配。
      && (granularity !== "section" || Boolean(headings.get(topic))))
    .map(([topic]) => topic)
    .sort();

  return {
    chunks,
    queryTopics,
    headings,
    relevantCounts: new Map([...byTopic].map(([k, v]) => [k, v.length])),
  };
}

/**
 * 查询文本。用 topic 名字本身当查询，因为它是唯一不看 chunk 内容就能得到的描述 ——
 * 若从 chunk 里挑句子当查询，那句话必然出现在某个 chunk 中，检索退化成字符串匹配。
 */
export function buildRealQuerySet(queryTopics, headings = new Map()) {
  const built = queryTopics.map((topic, index) => {
    // 小节粒度：用小节标题当查询。标题是文档作者写的"这一节讲什么"，是不看正文就能得到的
    // 最贴近查询意图的文本；同时带上包名/文件名消歧，因为 node_modules 里有大量同名标题
    // （`## Installation`、`## License`），不消歧的话同一句查询会对应多个 gold set。
    if (topic.startsWith("sec:")) {
      const path = topic.slice(4).split("#")[0];
      const pkg = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(path);
      const scope = pkg
        ? pkg[1].replace(/^@/, "").replace(/\//g, " ").replace(/[-_]/g, " ")
        : basename(path, ".md").replace(/[-_]/g, " ");
      const heading = (headings.get(topic) ?? "")
        // 标题里常有徽章、链接、行内代码，这些是排版不是语义。
        .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, " ")
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[`*_#|]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const readable = `${scope} ${heading}`.replace(/\s+/g, " ").trim();
      return {
        query_id: `rq.${String(index + 1).padStart(3, "0")}`,
        topic_id: topic,
        query_natural: `in ${scope}, ${heading}`,
        query_tokenized: readable,
      };
    }
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
