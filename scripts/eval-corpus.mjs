/**
 * 带标注的评测语料定义（纯数据 + 生成函数，不连数据库、不发网络请求）。
 *
 * 与 scripts/rag-seed.mjs 的区别：rag-seed 只负责"造出足够多的数据"，
 * 本文件额外提供**分级相关性标注**，因此可以算 MRR / nDCG / MAP，而不只是延迟。
 *
 * 标注不是事后人工打的，而是由生成规则决定的：每个 chunk 由 (topic, facet, 深度) 唯一确定，
 * 查询也绑定到一个 topic，所以"哪些 chunk 对该查询相关"是构造时就已知的事实。
 * 这避免了"用检索结果反推标注"的循环论证。
 *
 * 分级标准（nDCG 需要分级，二值标注会把 nDCG 退化成 Recall 的单调函数）：
 *   3 = 该 topic 的 definition facet：直接回答问题的定义/事实句
 *   2 = 该 topic 的其他 facet：同主题但换了角度（推导、实践、误解）
 *   1 = 同 cluster 的邻近 topic：语义相关但不是答案，检索到不算错
 *   0 = 其余
 *
 * 中文分词的已知限制（必须在标注设计里正面处理，不能掩盖）：
 * PostgreSQL 的 `simple` 配置不切分中文，整句会变成单个 token——
 * 实测 websearch_to_tsquery('simple','固定倾角应该设成多少度') 得到
 * 单个 lexeme '固定倾角应该设成多少度'，命中 0 条；空格分开的 '倾角 纬度' 命中 110 条。
 * 因此查询集同时提供 `query_natural`（自然整句）与 `query_tokenized`（空格分词），
 * 用来量化"词法检索在中文下到底损失多少"，而不是悄悄只用对自己有利的那种。
 */
import { createHash } from "node:crypto";

/** 确定性哈希，保证同参数下语料与标注完全可复现。 */
export function hashInt(...parts) {
  return createHash("sha256").update(parts.join(":"), "utf8").digest().readUInt32BE(0);
}

/**
 * 主题簇。同簇内的 topic 互为"部分相关"（grade 1）。
 * 簇的存在是为了让 nDCG 有意义：如果所有非答案都是 0 分，
 * 排序质量的差异会被压缩，指标对"检索到相关但非最优"不敏感。
 */
export const clusters = [
  {
    id: "geometry",
    label: "阵列几何与朝向",
    topics: [
      { id: "tilt-angle", title: "固定倾角与纬度", fact: "固定式光伏阵列的最佳倾角约等于当地纬度", terms: ["倾角", "纬度", "tilt", "latitude"], question: "固定倾角应该设成多少度" },
      { id: "azimuth", title: "方位角与正南偏移", fact: "北半球固定阵列朝向正南时全年发电量最高", terms: ["方位角", "正南", "azimuth", "朝向"], question: "阵列朝向应该朝哪个方向" },
      { id: "row-spacing", title: "阵列间距与遮挡角", fact: "阵列前后间距由冬至日太阳高度角决定", terms: ["间距", "遮挡角", "spacing", "冬至"], question: "前后排间距怎么算" },
      { id: "tracker-gain", title: "跟踪支架增益", fact: "单轴跟踪相比固定倾角可提升约百分之十五到二十五发电量", terms: ["跟踪", "单轴", "tracker", "增益"], question: "单轴跟踪能多发多少电" },
      { id: "ground-coverage", title: "土地覆盖率", fact: "地面覆盖率是组件面积与占地面积之比", terms: ["覆盖率", "占地", "coverage", "容积"], question: "什么是地面覆盖率" },
    ],
  },
  {
    id: "electrical",
    label: "电气特性与损耗",
    topics: [
      { id: "temperature-coefficient", title: "温度系数", fact: "晶硅组件功率温度系数约为每摄氏度负零点三五个百分点", terms: ["温度系数", "temperature", "coefficient", "功率"], question: "温度升高对输出功率有什么影响" },
      { id: "shading-loss", title: "遮挡损失与旁路二极管", fact: "单个电池片被遮挡可使整串输出下降超过三分之一", terms: ["遮挡", "阴影", "shading", "二极管"], question: "一片被树叶挡住会损失多少" },
      { id: "mismatch-loss", title: "组串失配损失", fact: "同一组串内组件电流失配会使输出受最小电流限制", terms: ["失配", "组串", "mismatch", "电流"], question: "组串失配是怎么产生的" },
      { id: "inverter-clipping", title: "逆变器限幅", fact: "直交流容配比超过一点三时限幅损失开始显著", terms: ["逆变器", "限幅", "clipping", "容配比"], question: "容配比多大会开始限幅" },
      { id: "wiring-loss", title: "线缆损耗", fact: "直流线缆损耗设计上通常控制在百分之二以内", terms: ["线缆", "损耗", "wiring", "压降"], question: "直流线损一般控制在多少" },
      { id: "iv-curve", title: "伏安特性曲线", fact: "最大功率点位于伏安曲线的膝部", terms: ["伏安", "IV", "最大功率点", "MPPT"], question: "最大功率点在曲线哪个位置" },
    ],
  },
  {
    id: "radiation",
    label: "太阳辐射与光谱",
    topics: [
      { id: "spectral-response", title: "光谱响应与大气质量", fact: "大气质量一点五是光伏标准测试条件的参考光谱", terms: ["光谱", "spectral", "大气质量", "AM1.5"], question: "标准测试条件用的是什么光谱" },
      { id: "clearness-index", title: "晴空指数", fact: "晴空指数是地表辐照与大气层外辐照之比", terms: ["晴空指数", "clearness", "辐照", "irradiance"], question: "晴空指数是怎么定义的" },
      { id: "albedo", title: "地表反射率与双面组件", fact: "雪地反射率可达零点八，显著提升双面组件背面增益", terms: ["反射率", "albedo", "双面", "bifacial"], question: "雪地对双面组件有什么好处" },
      { id: "diffuse-fraction", title: "散射辐射比例", fact: "阴天散射辐射可占总水平辐照的绝大部分", terms: ["散射", "diffuse", "阴天", "水平辐照"], question: "阴天时散射占多少" },
      { id: "incidence-angle", title: "入射角修正", fact: "入射角偏离法线越大，玻璃表面反射损失越高", terms: ["入射角", "IAM", "反射损失", "法线"], question: "斜射光损失为什么更大" },
    ],
  },
  {
    id: "degradation",
    label: "衰减与可靠性",
    topics: [
      { id: "degradation-rate", title: "线性衰减率", fact: "主流组件线性衰减率约为每年零点五个百分点", terms: ["衰减", "degradation", "质保", "线性"], question: "组件每年衰减多少" },
      { id: "lid-effect", title: "光致衰减", fact: "光致衰减主要发生在组件投运初期的头几百小时", terms: ["光致衰减", "LID", "初期", "投运"], question: "光致衰减什么时候发生" },
      { id: "pid-effect", title: "电位诱导衰减", fact: "电位诱导衰减与组件对地负偏压和高湿度相关", terms: ["电位诱导", "PID", "负偏压", "湿度"], question: "PID 是什么条件下发生的" },
      { id: "hotspot", title: "热斑效应", fact: "热斑由被遮挡电池片反向偏置发热引起", terms: ["热斑", "hotspot", "反向偏置", "发热"], question: "热斑是怎么形成的" },
      { id: "encapsulant-yellowing", title: "封装材料黄变", fact: "封装胶膜黄变会降低透光率并加速功率衰减", terms: ["黄变", "封装", "胶膜", "透光率"], question: "胶膜黄变有什么后果" },
    ],
  },
  {
    id: "pedagogy",
    label: "学习设计与评估",
    topics: [
      { id: "spaced-repetition", title: "间隔重复", fact: "间隔重复通过在遗忘曲线临界点复习来强化长期记忆", terms: ["间隔重复", "遗忘曲线", "复习", "长期记忆"], question: "间隔重复为什么有效" },
      { id: "zpd", title: "最近发展区", fact: "最近发展区指学习者在支持下能完成但独立无法完成的区间", terms: ["最近发展区", "ZPD", "支架", "独立"], question: "最近发展区怎么界定" },
      { id: "formative-assessment", title: "形成性评估", fact: "形成性评估的目的是调整教学而非给出最终成绩", terms: ["形成性", "评估", "反馈", "教学调整"], question: "形成性评估和终结性评估差别在哪" },
      { id: "cognitive-load", title: "认知负荷", fact: "外在认知负荷来自呈现方式而非学习内容本身", terms: ["认知负荷", "外在", "内在", "呈现"], question: "外在认知负荷指什么" },
      { id: "misconception-repair", title: "错误概念矫正", fact: "错误概念需要通过引发认知冲突才能被有效替换", terms: ["错误概念", "认知冲突", "矫正", "替换"], question: "怎么纠正学生的错误概念" },
      { id: "mastery-threshold", title: "掌握阈值", fact: "掌握学习要求达到设定阈值后才进入下一单元", terms: ["掌握", "阈值", "单元", "进阶"], question: "掌握阈值怎么设定" },
    ],
  },
  {
    id: "measurement",
    label: "测量与数据质量",
    topics: [
      { id: "pyranometer", title: "总辐射表", fact: "总辐射表测量水平面上的半球总辐照度", terms: ["总辐射表", "pyranometer", "半球", "辐照度"], question: "总辐射表测的是什么量" },
      { id: "soiling-ratio", title: "污渍比", fact: "污渍比是脏组件输出与洁净组件输出之比", terms: ["污渍", "soiling", "清洗", "比值"], question: "污渍比怎么算" },
      { id: "performance-ratio", title: "系统效率比", fact: "系统效率比是实际发电量与理论发电量之比", terms: ["系统效率比", "PR", "实际发电量", "理论"], question: "PR 值是什么意思" },
      { id: "data-gap-filling", title: "数据缺失填补", fact: "短时数据缺失可用相邻测点线性插值填补", terms: ["缺失", "插值", "填补", "测点"], question: "监测数据断了怎么补" },
      { id: "uncertainty-budget", title: "不确定度分析", fact: "测量不确定度由各分量按平方和根合成", terms: ["不确定度", "合成", "平方和根", "分量"], question: "不确定度怎么合成" },
    ],
  },
];

/**
 * 干扰 topic 的词表。刻意选与光伏/教学相邻但不重叠的技术领域：
 * 完全无关的文本太容易被区分，测不出检索难度；重叠则会污染标注。
 */
const distractorDomains = [
  { label: "风力发电", terms: ["叶片", "偏航", "塔筒", "变桨"] },
  { label: "储能电池", terms: ["荷电状态", "循环寿命", "热失控", "均衡"] },
  { label: "配电网", terms: ["馈线", "无功补偿", "继电保护", "谐波"] },
  { label: "工业控制", terms: ["组态", "现场总线", "回路整定", "联锁"] },
  { label: "建筑节能", terms: ["围护结构", "传热系数", "冷负荷", "新风"] },
  { label: "水处理", terms: ["混凝", "膜通量", "污泥龄", "反冲洗"] },
];

/** 每个 topic 的四个 facet。definition 是标准答案（grade 3），其余是同主题变体（grade 2）。 */
export const facets = [
  { id: "definition", label: "定义与核心事实", frame: "先给出准确定义，再给一句可验证的判据", grade: 3 },
  { id: "derivation", label: "推导与公式", frame: "引入公式与单位换算，说明每一步的依据", grade: 2 },
  { id: "practice", label: "工程实践", frame: "结合实测数据与误差范围说明如何落地", grade: 2 },
  { id: "misconception", label: "常见误解", frame: "指出典型错误理解并给出反例", grade: 2 },
];

/**
 * 干扰 topic：只提供语料体积，永不被查询。
 *
 * 为什么需要它们：相关集大小与语料规模必须解耦。原设计用 depth 同时承担两件事，
 * depth=240 时每条查询的相关 chunk 达 960 条，而 Recall@10 的分母就是这 960 —— 取 10 条
 * 不可能召回 960 的 10%，指标被构造方式锁死在 0.01，测不出任何区别。
 *
 * 现在体积由干扰 topic 承担：它们有独立的 cluster_id，因此对任何真实查询
 * `gradeFor` 都返回 0（既不是同 topic，也不在同 cluster），纯粹充当检索噪声。
 * 真实 topic 则用很小的 depth，让相关集降到十几条，Recall@k 因此可达。
 */
const distractorClusterCount = 24;
const distractorTopicsPerCluster = 16;

export const distractorTopics = Array.from({ length: distractorClusterCount }, (_, clusterIndex) =>
  Array.from({ length: distractorTopicsPerCluster }, (_, topicIndex) => {
    const id = `noise-${clusterIndex + 1}-${topicIndex + 1}`;
    const domain = distractorDomains[clusterIndex % distractorDomains.length];
    return {
      id,
      title: `${domain.label}专题 ${topicIndex + 1}`,
      fact: `${domain.label}中的${domain.terms[topicIndex % domain.terms.length]}需要按规程逐项核对`,
      terms: domain.terms,
      question: null,
      cluster_id: `noise-${clusterIndex + 1}`,
      cluster_label: `${domain.label}簇 ${clusterIndex + 1}`,
      is_distractor: true,
    };
  }),
).flat();

/**
 * 每个真实 topic 的相关集大小倍数。
 *
 * 为什么必须不均匀：相关集恒定时，一个固定的 `context_k` 在每条查询上都接近最优，自适应 k
 * 再聪明也只能打平，测不出任何差别。要让固定 k 必然出错，相关集必须因查询而异：
 * 相关集只有 4 条时取 11 条必然掺 7 条噪声，相关集 40 条时取 11 条必然漏掉 29 条。
 *
 * 倍数按 topic 序号轮转，与 topic 内容无关，避免"某类主题恰好稀疏"这种混淆变量。
 * 用 depth 的倍数而不是绝对条数，这样 `--depth` 仍然是唯一的规模旋钮。
 */
const relevantSetMultipliers = [1, 1, 2, 4, 8, 1, 3, 6];

export function relevantMultiplierFor(topicIndex) {
  return relevantSetMultipliers[topicIndex % relevantSetMultipliers.length];
}

export const realTopics = clusters.flatMap((cluster) =>
  cluster.topics.map((topic) => ({ ...topic, cluster_id: cluster.id, cluster_label: cluster.label, is_distractor: false })),
);

export const allTopics = [...realTopics, ...distractorTopics];

const sourceTypes = ["text/markdown", "application/pdf", "text/html", "text/plain"];

/**
 * 生成一个 chunk 的内容与标注。
 *
 * `depth` 让同一个 (topic, facet) 能产出多条不同长度的内容：内容长度全一致会让
 * ts_rank_cd 给出雷同分数，排序竞争就变成了 chunk_id 的字典序，测不出真实排序能力。
 */
export function buildChunk({ topicIndex, facetIndex, depth, runTag }) {
  const topic = allTopics[topicIndex];
  const facet = facets[facetIndex];
  const paragraphs = 2 + (hashInt("len", topic.id, facet.id, depth) % 7);
  const filler = Array.from({ length: paragraphs }, (_, index) =>
    `要点${depth}-${index + 1}：${topic.terms[(index + depth) % topic.terms.length]}在本节的作用是把结论与可观测量连起来。`,
  ).join("");

  const content =
    `【${topic.title}｜${facet.label}】${facet.frame}。` +
    `核心事实：${topic.fact}。` +
    `关键词：${topic.terms.join(" ")}。` +
    `所属主题簇：${topic.cluster_label}。${filler}`;

  return {
    content,
    topic_id: topic.id,
    cluster_id: topic.cluster_id,
    facet_id: facet.id,
    grade: facet.grade,
    source_type: sourceTypes[hashInt("src", topic.id, facet.id, depth) % sourceTypes.length],
    // entity_keys 必须多样化：selectEvidence 会把 source_type 与 entity_keys 都相同的候选
    // 视为冗余而丢弃，全表一致会让最终 evidence 只剩 1 条，指标失去意义。
    entity_keys: [`topic.${topic.id}`, `cluster.${topic.cluster_id}`, `facet.${facet.id}`, `depth.${depth}`],
    chunk_suffix: `${runTag}.${topic.id}.${facet.id}.${depth}`,
  };
}

/**
 * 查询集。每个 topic 一条查询，标注由构造规则直接给出。
 *
 * 同时给出两种查询形态，用来量化中文分词对词法检索的影响：
 *   query_natural   自然整句，用户真实会输入的形式
 *   query_tokenized 空格分词，PostgreSQL simple 配置能切开的形式
 */
export function buildQuerySet() {
  // 只有真实 topic 有查询。干扰 topic 的 question 是 null，它们只充当噪声。
  return realTopics.map((topic, index) => ({
    query_id: `q.${topic.id}`,
    topic_id: topic.id,
    cluster_id: topic.cluster_id,
    query_natural: topic.question,
    query_tokenized: topic.terms.join(" "),
    // 同簇邻近 topic 记为 grade 1：检索到它们不算错，只是不如答案好。
    related_topic_ids: realTopics
      .filter((other) => other.cluster_id === topic.cluster_id && other.id !== topic.id)
      .map((other) => other.id),
    ordinal: index,
  }));
}

/**
 * 给定 chunk 的标注元数据，返回它对某条查询的相关性等级。
 * 这是唯一的判定入口，评测脚本不得另行推断，否则标注与打分会漂移。
 */
export function gradeFor(query, chunkLabel) {
  if (!chunkLabel) return 0;
  if (chunkLabel.topic_id === query.topic_id) return chunkLabel.facet_id === "definition" ? 3 : 2;
  if (query.related_topic_ids.includes(chunkLabel.topic_id)) return 1;
  return 0;
}
