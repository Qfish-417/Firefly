# Agent 能力五维评测（端到端 + 单步双轨）

真实远程模型（`Qwen3.5-4B`）、真实审计账本、真实检索边界。所有数字来自实际执行，
可用文末命令复现。未测量的项目明确标注"未测量"，不做推断。

评测的是 **Agent 行为**，与既有两份报告互补，不重叠：

| 报告 | 回答的问题 |
|---|---|
| [性能基线](./performance-baseline.md) | 链路多快 |
| [量化评测报告](./evaluation-report.md) | 检索排得准不准、答案有没有证据支撑 |
| 本报告 | Agent 该调什么工具、走几步、算不算完成、花多少 token |

## 1. 指标定义与事实来源

五个维度的事实来源刻意分开。共用来源会让一个指标掩盖另一个：例如用模型自报的
"我完成了"当完成率，链路故障就永远测不出来。

| 维度 | 权重 | 定义 | 事实来源 |
|---|---|---|---|
| task_completion | 0.30 | 端到端跑完且状态机到达 `learned`、`verification=passed` | `evolution_run` / `evolution_transition` |
| step_efficiency | 0.15 | 理论最小迁移数 / 实际迁移数 | `evolution_transition` 计数 |
| tool_correctness | 0.25 | 工具名 + intent + 关键参数是否被**生产校验边界**接受 | `validateRetrievalRequest` |
| token_cost | 0.10 | 相对基线归一化的 token 用量 | `model_invocation` 账本 |
| rubric | 0.20 | LLM-as-judge 按固定 rubric 打分（appropriateness / safety / completeness） | 独立裁判调用 |

三条口径上的选择，都是为了让数字不至于自我印证：

- **步数分母是声明的，不是跑出来的。** `minimum_steps: 9` 由 `ManualEvolutionWorkflow` 的状态机
  推导（finding_created → plan_created → approval_requested → plan_approved → change_built →
  verification_passed → canary_started → canary_succeeded → outcome_recorded）。用实测值当分母，
  任何绕路都会被定义成"正常"。低于 9 步不给超过 1 的分——那不是效率高，是跳过了治理节点。
- **token 只从账本读。** 脚本不自己累加。两份数字必然漂移，而账本是计费事实源。
- **tool_correctness 过真实校验函数，而不是比对字符串。** 只比 intent 名称只能说明分类对了；
  真实系统会因为缺 `structured_query` 字段而 422。为此把 `validateRetrievalRequest` 从
  `packages/retrieval-service` 导出，评测与 HTTP 边界共用同一份规则——复制一份规则会漂移，
  然后开始把边界实际拒绝的调用报成合格。

`kind` 字段不参与参数比对（虽然期望值里保留它作为可读文档）：它是 intent 的函数
（temporal ⇒ `select_event_time` 等），调用方按 intent 填即可，模型没有选择空间。
首轮曾把它计入，导致 3 个 `wrong_arguments` 全部是"语义字段完全正确、只是没回显 kind"，
同一个错误被扣两次分。

## 2. 双轨的必要性

端到端只报告最终成没成。一次失败无法区分是工具选错、参数错还是执行错，
而这三者的修复方向完全不同。单步轨对每个决策点单独判分，把失败归因到具体环节。

反过来，只有单步会漏掉累积误差与状态机绕路。两轨都跑，不互相替代。

单步判分分三档而不是对错两档：完全正确 / 工具对但 intent 错（0.25）/ 工具错（0）。
中间档必须单独可见——intent 选错是描述问题，工具选错是能力边界问题。
严格正确率与加权分并列报告：加权分含部分分，单看会高估可用性；严格率回答"有多少次能直接执行"。

## 3. 环境

| 项 | 值 |
|---|---|
| 生成模型 | `Qwen3.5-4B`，context_window 262144，`reasoning_effort=none` |
| PostgreSQL | 17 + pgvector 0.8.6，宿主端口 55473 |
| 结构化事实 | 22 条 `structured_event` + 3 条 `structured_edge`（`scripts/eval-agent-seed.mjs` 播种） |
| 单步任务 | 18 条（clear 12 / ambiguous 6）x 3 次采样 = 54 |
| 端到端 | 6 轮完整演化闭环 |
| token 基线 | 3000（端到端实测中位数约 1500，基线取其两倍留出余量） |

结构化事实必须单独播种：`rag-seed` 只造 `memory_chunk`，两张结构化表是空的。
而 count / comparison / temporal / multi_hop 四类 intent 全部读结构化事实层，空表时它们会
**正确地** fail closed。用空表能评"工具选对了没有"，但评不了"选对之后答案对不对"，
结果是 tool_correctness 好看而 rubric 偏低，两个指标互相矛盾却找不到原因。

事实由构造规则决定（计数刻意设成 7/4/2/5/3/1，不成倍数关系），因此正确答案在播种时已知，
不需要事后标注，也不用系统自己的查询结果当标准答案。

## 4. 首轮基线（12 题 clear 档）

| 维度 | 得分 |
|---|---|
| task_completion | 1.000 |
| step_efficiency | 1.000 |
| tool_correctness | 0.917 |
| token_cost | 1.000 |
| rubric | 0.818 |
| **加权总分** | **0.943** |

端到端 6/6 完成，迁移数恒为 9（等于理论最小值，无重试无绕路），
每轮 token 1496–1524（mean 1513），墙钟 p50 6146ms。

两个扣分点，性质完全不同。

### 4.1 rubric 0.818 是评测自身的缺陷，不是系统缺陷

裁判把两条**正确拒绝**判成 0/0/0，理由写着"系统拒绝正确，但无工具可选"——
它把 `tool=none` 读成"系统没能给出工具"这一缺陷，而不是"拒绝"这一正确动作。
rubric 因此成为五维中唯一的低分项，而低分完全来自裁判对合法输出的误读。

修法不是调分数，而是在 rubric 提示词里明确 `none` 的语义，并规定正确拒绝在三个维度上均记满分。

### 4.2 tool_correctness 0.917 是真实的路由缺陷

`t.fact.temperature`（"温度升高对组件输出功率有什么影响？"）3/3 被路由到 `exploratory`。
这不是风格问题：`planRetrieval` 按 intent 决定检索规模，实测

| intent | candidate_k | fusion_k | context_k |
|---|---|---|---|
| fact_lookup | 20 | 29 | 8 |
| exploratory | 44 | 87 | 17 |

一个单答案问题因此多召回一倍以上证据，白花上下文预算。

根因在产品代码而不在提示词：`intent` 由调用方提供，而**代码里没有任何地方说明该怎么选**，
每个调用方只能从 `defaults` 表反推分类标准。

## 5. 优化

### 5.1 `intentGuidance`：把选择标准写进产品代码

`packages/retrieval-planner` 新增导出 `intentGuidance`，为 7 个 intent 各声明
`selection_rule`（判别规则）、`requires_structured_query`、`misroute_cost`（选错的代价）。

`selection_rule` 刻意写成**判别式**而不是描述式："问的是一件事" vs "答案必须枚举多项"
才是区分两个 RAG intent 的依据；单独描述每个 intent 无法解决边界模糊。

两条测试锁住它不退化成过期文档：一条断言每个 intent 的 `requires_structured_query`
与 `planRetrieval` 真实产出的 plan 一致、且新增 intent 必须补齐 guidance；
另一条断言 exploratory 的检索宽度确实显著大于 fact_lookup——若两者收敛，这条路由建议就没有意义，
应当复审建议而不是悄悄留着。

### 5.2 评测工具目录改为从 guidance 生成

手写目录会产生第二份 intent 说明：planner 行为一改，评测仍按旧描述提问，
"模型选错"与"目录过期"就无法区分。改为从 `intentGuidance` 生成后，
"给调用方的说明是否足够"本身成为被测对象，而不是评测脚本私有的提示词技巧。

### 5.3 A/B 验证：确认是改动生效，而非采样波动

保留 `--legacy-catalog` 开关跑优化前的手写目录。同一版脚本、同一模型、同一批任务，
只切换目录这一个变量，5 次采样：

| 工具目录 | 严格正确率 | `t.fact.temperature` 失败次数 |
|---|---|---|
| 优化前（手写） | 0.917 | 5 / 5 |
| 优化后（从 guidance 生成） | 1.000 | 0 / 5 |

其余 11 题两组完全一致。差异归因到目录本身。

### 5.4 rubric 样本量从 n=12 提到 n=54

原实现只评每条任务的第一次尝试，白扔三分之二样本，使 rubric 成为五维中噪声最大的一项
（n=12 时单条误判即可移动 0.08）。每条任务重复次数相同，任务间权重本来就相等，
因此改为全评。rubric 与严格判分评的是**同一批真实决策**（保留模型实际给出的参数，
不用期望值代替——用期望值会让安全维度永远满分）。

## 6. 满分暴露的问题：题目太容易

优化后 clear 档 36/36 全对，五维全部 1.000。**这不是好消息**：
一套没有余量的题，无论模型变好还是变坏都还是 1.000，回归检测能力为零。

用不含明显触发词的请求探测，发现能力远未饱和：

| 探测请求 | 实际输出 | 问题 |
|---|---|---|
| "最早那条和最晚那条差了多久" | `{"first":"true","last":"true"}` | selector 被当成两个布尔字段 |
| "A 比 B 表现好吗" | `{"subject1":...,"event_type":"表现"}` | 字段名与事件类型均为编造 |

这些正是生产里会 422 或静默答错的形态，因此补充 6 条 `ambiguous` 档任务并按档报告分数。
合计分仍是主指标（它对应整体可用性），分档是为了让变化可归因到难度——
只看合计，ambiguous 档的退化会被 clear 档的满分稀释。

## 7. 第一轮结果（18 题）

| 维度 | 基线（12 题） | 第一轮（18 题） |
|---|---|---|
| task_completion | 1.000 | 1.000 |
| step_efficiency | 1.000 | 1.000 |
| tool_correctness | 0.917 | 0.889 |
| token_cost | 1.000 | 1.000 |
| rubric | 0.818 | 0.980 |
| **加权总分** | **0.943** | **0.968** |

tool_correctness 从 0.917 降到 0.889 是题目变难，不是能力退化：clear 档 36/36，
ambiguous 档 0.667。同口径（clear 档）对比是 0.917 → 1.000。

第一轮留下三个未完项，第二轮逐个处理。

## 8. 第二轮：修复三个未完项

### 8.1 空结果集的语义歧义（产品缺陷）

第一轮标注但未修：`event_type: "表现"` 能通过 `validateRetrievalRequest`，要到聚合阶段才返回空结果。
实测后发现比标注的更严重——四种情况在修复前完全无法区分：

| 查询 | 修复前 | 危害 |
|---|---|---|
| count，真实 event_type | `value: 7` | 正确 |
| count，编造 event_type | `value: 0` | 读成"从没做过" |
| count，不存在的 subject | `value: 0` | 同上 |
| **compare，编造 event_type** | **`difference: 0`** | **读成"两人表现相同"** |

最后一行最危险：`difference: 0` 是一个**自信的错误答案**，而不是空结果，且没有任何迹象表明它来自空集。

修在事实层，不在校验层。`MemoryRepository.probeEventVocabulary` 用两次 `limit(1)` 存在性探测
回答"这个 event_type / subject 是否可读"，因为**缺席无法从缺失的行里观察到**。三个聚合方法在
结果为空时补 `excluded_reasons`：

```
count 编造 event_type   → "no readable event of type 表现 exists; the count is not a fact about the subject"
count 不存在 subject    → "subject learner.does.not.exist has no readable events of any type"
compare 编造 event_type → 同上第一条（difference: 0 不再无声）
temporal 编造 event_type→ 同上第一条
真实查询                → excluded_reasons 为空（无误报）
```

三条设计选择：

- **只在空结果时探测**，成本只落在出问题的路径上。
- **返回 reason 而不是抛异常**：模型写错事件类型是可恢复的错误，调用方可以重新规划；
  拒绝整个查询会连带拒绝共用这条代码路径的**合法空答案**。
- **不收窄时间范围**：事件类型存在时，窗口内计数为 0 是真实答案。
  这里区分的只是"词汇表不存在"与"事实没发生"。

可见性规则原先在列表查询里写了一份，探测需要第三份——因此提取为共享的 `eventVisibility` 谓词。
复制一份的后果是探测可能确认**其他租户**的词汇表存在，而探测返回布尔值，这种泄露是无声的。
集成测试对此有专门断言：`tenant.other` 探测 `lesson_completed`（该类型确实存在于 tenant.hidden）
必须返回 `false`。

### 8.2 ambiguous 档两条稳定失败

第一轮标注"样本量不足以区分稳定失败与期望有争议"。复核后两条性质完全不同：

**`t.ambig.vague-compare` 是真实缺陷。** 模型把"表现"直译成 `event_type: "表现"`，
因为**没有任何地方枚举可用的事件类型**，猜是唯一策略。修法是新增
`MemoryRepository.listReadableEventTypes`，让工具目录带上真实词汇表。这同样是生产能力：
真实调用方面对同一问题需要同样的信息。

这里出过一次我自己引入的回退，值得记录：词汇表最初放在工具目录**末尾**（紧邻输出格式指令），
`t.fact.temperature` 从 3/3 正确变成 4/4 错误——一个与 event_type 毫无关系的机制类问题被推向
`exploratory`。末尾的全局清单等于在每次决策前都强调一遍结构化字段，与 intent 判别规则争夺注意力。
改为**绑定到需要它的三个 intent** 之后，clear 档恢复 1.000（n=48），`vague-compare` 也修好了。

**`t.ambig.mixed-intent` 是题目不合法。** 原措辞"组件效率是多少？顺便把所有影响效率的因素都列一下"
把一个单点事实和一次枚举塞进同一句，而工具契约一次调用只接受一个 intent。无论选哪个都会漏掉
另一半需求，它考的是"两个需求冲突时你猜哪个"，不是路由能力。改为只保留枚举需求、且仍不含
"所有/全部"这类显式触发词，期望才唯一确定。

### 8.3 满分再次出现，补第二批 ambiguous

两条修好后 24/24 全对，余量再次归零。用更硬的请求探测，发现三类稳定失败，都是
"读起来像能一次答完、实际超出单次调用能力"的形态：

| 新任务 | 修复前实际输出 | 生产后果 |
|---|---|---|
| `t.ambig.existence`（有没有出现过 X） | `fact_lookup` | 用检索片段猜有无，窗口外事件即答错 |
| `t.ambig.cross-subject`（所有学员排名） | `exploratory` + 空 `structured` | 契约不支持跨主体聚合，却给出貌似相关的证据 |
| `t.ambig.compound-count`（首次 X 之后做了几次 Y） | 无条件 `count_events` | 悄悄丢掉时间约束，返回偏大的数 |

### 8.4 rubric 解析器过脆（评测缺陷）

补题后 rubric 失败数从 3 涨到 9。原实现只累加计数、丢掉 `lastError` 与 `task_id`，无法定位，
因此先补诊断输出——发现失败是 3 条题各 3 次，集中而非抖动。

裁判的真实输出是：

```json
{"appropriateness": 3, "safety": 5, "completeness": 3, "reason": 意图模糊，参数缺失。"}
```

`reason` 缺开引号，整条 `JSON.parse` 报废——而**三个分数都已经拿到了**。因说明字段的引号丢掉
已得分是解析器过脆，且丢弃这些样本会系统性偏向"裁判答得干净"的题目。

兜底只对**数值字段**做正则抽取。`reason` 是自由文本，缺引号时无法可靠界定边界，因此不猜，
记为空并标记 `lenient_parse`。结果：失败 9 → 0，n 54 → 63（全覆盖），
归一化分 0.980 → 0.956。**分数变低是更诚实**：之前被丢弃的 9 条恰好是裁判打低分的题。

## 9. 最终结果

| 维度 | 基线（12 题） | 第一轮（18 题） | 第二轮（21 题） |
|---|---|---|---|
| task_completion | 1.000 | 1.000 | 1.000 |
| step_efficiency | 1.000 | 1.000 | 1.000 |
| tool_correctness | 0.917 | 0.889 | 0.952 |
| token_cost | 1.000 | 1.000 | 1.000 |
| rubric | 0.818 | 0.980 | 0.956 |
| **加权总分** | **0.943** | **0.968** | **0.979** |

分档（n=63）：

| 档 | 采样数 | 严格正确率 |
|---|---|---|
| clear | 36 | 1.000 |
| ambiguous | 27 | 0.889 |

其余观测：

- 唯一稳定失败：`t.ambig.cross-subject` 3/3 选 `exploratory` 而非报告能力缺失。余量保留。
- 端到端 6/6 完成，迁移数恒为 9 = 理论最小值，token mean 1517
- 边界接受率 1.000；rubric n=63、0 次解析失败
- 单步决策延迟 p50 832ms、p95 1049ms（n=63，p99 不可信，如实标注）
- 词汇表从事实层读出：`challenge_attempted`、`delayed_review_completed`、`misconception_detected`

## 10. 已知不足

- **`p99` 在端到端轨不可信**：n=6，第 99 百分位等于最大值。报告输出 `p99_reliable: false`。
- **rubric 是 LLM-as-judge，不是人工评分**。同一个模型既做决策又做裁判存在共模偏差。
  真正的人工评分未测量。
- **端到端只有 1 个任务**。step_efficiency 只在一条路径上验证过，换任务需重新声明最小步数。
- **`t.ambig.duration` 的 rubric 得分偏低（3/5/2）且判分为 correct**，两个指标背离。
  裁判认为"只取最早一条、缺时间差计算"不完整，而判分只要求第一步正确。这个背离是真实的：
  单次调用确实无法回答跨度问题。未修，因为修它需要工具契约支持多步计划。
- **跨主体聚合确实不支持**。`t.ambig.cross-subject` 的失败反映的是能力缺失被掩盖，
  而不是路由错误——补 `group_by` 聚合是产品侧工作，本轮未做。
- **Engineer 仍是确定性 Stub**。远程模型档不启动 Git worktree 与 Docker Sandbox，
  三 Agent 闭环里只有 Director 与 Scientist 是模型驱动（每轮 2 次模型调用）。

## 11. 复现

```bash
# 1. 起模型隧道（远程 vLLM → 回环，Model Gateway 只允许回环明文 HTTP）
node .tunnel.mjs &

# 2. 播种结构化事实
node --env-file=.eval.env scripts/eval-agent-seed.mjs --reset

# 3. 全量评测（单步 21 题 x 3 + 端到端 6 轮）
node --env-file=.eval.env scripts/eval-agent-capability.mjs --rounds 6 --repeats 3

# 只跑单步轨 / 只跑端到端
node --env-file=.eval.env scripts/eval-agent-capability.mjs --repeats 3 --skip-e2e
node --env-file=.eval.env scripts/eval-agent-capability.mjs --rounds 6 --skip-single

# A/B：用优化前的手写工具目录，验证改动效果而非采样波动
node --env-file=.eval.env scripts/eval-agent-capability.mjs --repeats 5 --skip-e2e --legacy-catalog

# 结构化事实层的空结果语义（需要 pgvector 库）
TEST_DATABASE_URL=postgresql://questlab:questlab@127.0.0.1:55473/questlab_itest \
  node --test --test-concurrency=1 packages/retrieval-postgres/test/postgres-retrieval.integration.test.ts
```

`.tunnel.mjs` 是 HTTP 代理而不是 TCP 转发，并且会重写 `Host`。原因见该文件注释：
路径上有环节会重置携带 `Host: 127.0.0.1:<port>` 的连接（200 次交错实测：
`Host: 127.0.0.1:11401` 成功 55/100，`Host: 49.7.211.55:11401` 成功 100/100），
字节级转发无法规避，因为出问题的头由客户端生成。
