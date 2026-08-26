# FireFly QuestLab 上手指南

给"第一次接触这个仓库、需要在半天内能改代码"的人。
既有文档共 14 个入口，按顺序读完要几小时；本文只讲最短路径。

---

## 1. 这个项目在做什么

一句话：**给每个学习者生成长期项目任务世界，并根据真实学习效果持续改进教学策略和互动软件**。

不卖固定视频课。核心循环是：

```
学习目标与兴趣 → 能力诊断 → 生成学习世界 → 学习者交互
     ↑                                        ↓
     └──────── 受控改进（需人工批准） ←──── 真实学习效果
```

"自进化"指系统自己提出并实施教学改动，但**每一步都可审计、可回滚、需人工批准**。这是设计约束
而不是保守：教学改动作用在真实学习者身上，不可逆的自动化在这里是缺陷。

---

## 2. 三个 Agent 与它们为什么不直接对话

| Agent | 角色 | 产物 |
|---|---|---|
| **Learning Director** | 学习导演（业务） | MissionPlan、NextAction、Intervention、LearnerMessage |
| **Learning Scientist** | 学习科学家（侦察） | LearningFinding、EvidencePack、OutcomeEvaluation |
| **Experience Engineer** | 体验工程师（代码） | ChangeSet、PatchCommit、PluginDigest、GeneratedTests |

**它们不通过自由文本接力，也不互相改状态。** 协作方式：

- Control Plane 用**版本化 `Task`** 派活
- Agent 用 **append-only `Event`** 报告事实
- 大对象走 **`ArtifactRef`**，不进消息体
- **PostgreSQL 工作流状态是唯一事实源**

理由：自由文本接力无法审计——出错时说不清是谁的判断错了。版本化 Task + 事件流让每个决策可回放。

`Loop Sentinel`（循环哨兵）是确定性平台能力，**不是第四个 Agent**，别把它当 Agent 读。

---

## 3. 仓库结构：先看这 4 个包

33.9k 行 TypeScript，12 个包。按重要性：

| 包 | 行数 | 干什么 | 何时要看 |
|---|---|---|---|
| **`contracts`** | 1.3k | JSON Schema + TS 类型，所有 Agent 输出的校验边界 | **改任何数据结构前必看** |
| **`retrieval-service`** | 2.3k | 检索编排：融合 → ACL → 重排 → 证据选择 | 改检索行为 |
| **`retrieval-postgres`** | 3.1k | 词法/向量检索器、索引器、ACL 实现 | 改 SQL 或检索器 |
| **`retrieval-planner`** | 0.8k | 按 intent 决定各档 K 值与停止门槛 | 调检索参数 |
| `persistence` | 7.3k | 40 张表、仓储层、18 个迁移 | 改数据模型 |
| `memory-workers` | 8.5k | 索引构建、删除修复、retired 索引回收 | 改后台任务 |
| `model-gateway` | 3.1k | 模型路由、审计账本、预算 | 接新模型 |
| `control-plane` | 2.9k | 调度、Admin API、检索 API、本地 demo | 改编排 |
| `governance` | 0.7k | 审批、Loop Sentinel | 改治理 |
| `learning-domain` | 0.5k | 学习领域对象与状态机 | 改业务语义 |
| `plugin-platform` | 1.6k | 插件发布闭环 | 改插件 |
| `agent-kernel` | 76 | 极薄，只是类型汇出 | 几乎不用看 |

三个 Agent 在 `agents/{learning-director,learning-scientist,experience-engineer}`。

`legacy/prototype-v0/` 是早期 Java/Python 实验，**与主干无依赖，不要在上面加功能**。

---

## 4. 五分钟跑起来

**没有构建步骤。** Node 24 直接运行 `.ts`，这是刻意的——少一层 source map 就少一类调试噪声。

```bash
npm install

# 静态检查 + 单元测试（不需要数据库）
npm run check          # = tsc --noEmit && node --test

# 最小本地形态：只起 PostgreSQL 容器，其余跑在宿主 Node
cp infra/compose/questlab-min.env.example infra/compose/questlab-min.env
npm run min:config     # 干跑校验，不启动任何东西
npm run min:up
npm run min:ps         # 等到 STATUS 出现 (healthy)
npm run min:migrate    # 应用 18 个迁移，含 vector 扩展

# 跑通一次三 Agent 人工闭环（无 LLM，确定性）
npm run min:demo:start -- --run-id run.min.001
npm run min:demo:approve -- --run-id run.min.001 --approver local.user --reason "reviewed locally"
# 期望终态：state=learned, verification_status=passed, transition_count=9

# 集成测试（缺 TEST_DATABASE_URL 会静默跳过，CI 视跳过为失败）
TEST_DATABASE_URL="postgresql://questlab:questlab@127.0.0.1:55433/questlab" npm run test:integration
```

上面每条命令我都实际执行过。`min:*` 这组脚本此前只存在于
`docs/local-min-profile.md` 里而 `package.json` 从未定义，整份最小降级流程无法执行；已补齐。

**端口互不复用，别改**：

| 形态 | 端口 | 说明 |
|---|---|---|
| `questlab-min` | 55433 | 只有 PostgreSQL，无 MinIO / Worker / 真实模型 |
| `questlab-lite` / `dev` | 55432 | 低资源完整形态 |
| 远端模型评测 | 55473 | 评测与集成测试用 |

---

## 5. 检索链路：改之前必须理解的顺序

```
retrievers（词法 + 向量并行）
  → reciprocalRankFusion(...).slice(0, plan.fusion_k)
  → ACL 过滤（canReadAll 批量）
  → authorized.slice(0, plan.rerank_k)   ← 这一段叫 fusedWindow
  → 可选重排
  → selectEvidence(..., plan)
  → 可选 expander
```

几个容易踩的点，都是我实际踩过的：

- **`expander` 是检索后的证据扩展，不是查询改写。** 名字容易误解。
- **`RoutedModelGateway.embed` 会抛 `CAPABILITY_UNAVAILABLE`**，要 embedding 必须直接用
  `HttpEmbeddingProvider`。
- **`PostgresVectorRetriever` 只接受一个 options 对象**；`PostgresLexicalRetriever(db, id, name)`
  是位置参数。写成 `new PostgresVectorRetriever(db, {...})` 会报
  `Cannot read properties of undefined (reading 'embed')`。
- **`RetrievalRequest` 没有 `plan_overrides` 字段。** 我曾凭印象写它，被静默忽略，导致整轮参数
  扫描的每一行数字都相同。
- `selectEvidence` 有 5 道门：`context_k`、`token_budget`、`score_floor`、`marginal_gain_floor`、
  `relative_floor`（默认关闭），外加 `max_chunks_per_source` 去重上限。

### pgvector 的硬限制

- `vector` 的 HNSW 索引最多 2000 维，`halfvec` 最多 4000。本项目 embedding 是 **2048 维，
  所以必须用 `halfvec`**。
- `SET LOCAL` **在事务外是静默无效的**。我因此得出过"halfvec 有 31% 精度损失"的错误结论。
- ANN 结果被后置过滤时需要 `hnsw.iterative_scan`（默认 `off`），否则 `ef_search=40` 取回的邻居
  可能全被过滤掉。
- `retrieval_index_one_active_idx` 是 `(tenant_id, logical_name) WHERE status='active'` 的唯一索引
  ——**每个语料必须用不同的 `logical_name`**。

---

## 6. 契约优先：改数据结构的正确姿势

所有 Agent 输出经 JSON Schema 校验（Ajv strict 模式）。改结构要同步三处：

1. `packages/contracts/schemas/v1/firefly-contracts.schema.json`
2. `packages/contracts/src/types.ts`
3. `packages/contracts/test/contracts.test.ts` 的 fixture

两个坑：

- Ajv strict 模式下注释关键字是 **`$comment`**，写 `comment` 会抛
  `strict mode: unknown keyword`。
- 别为了放宽长度去改公共类型。我曾遇到 `snapshots/model` 超 160 字符，
  正确做法是新增 `CompositeSnapshot` 类型，而不是放宽被引用 112 处的 `Identifier`。

---

## 7. token 与成本只有一个事实源

`questlab.model_invocation` 审计账本 + 原子 `run_budget_usage`。**脚本不要自己累加 token**，
否则两套数字必然对不上。

---

## 8. 评测:数据在哪、怎么复现

`docs/evaluation-report.md` 是全量记录（1400 行）。**只读第 0 节**就够了解现状:

- **R@10 = 0.912**（真实文档语料，5303 chunk，300 查询）
- 端到端综合 0.979
- 第 0.5 节：6 条被自己的测量推翻的结论 ← 最值得读
- 第 23 节：把 R@10 从 0.706 提到 0.912 的过程，含被排除的 6 条无效杠杆

### R@10 只有一个定义

```
R@10 = 前 10 条命中数 / gold set 大小
P@10 = 前 10 条命中数 / 10
```

**如果 Recall 也除以 10，它会与 Precision 位位相同。** 这个 bug 项目里真出现过：
11 场景 × 3 cutoff 全部 `Recall@k == Precision@k`。

gold set 是"仅针对当前问题最相关的那一小撮文档"，按 h1–h4 小节划分（99% 含 1–5 个 chunk，
对齐 MS MARCO）。曾用"整个文件"当 gold set，把 `#### shiftLeft(n)` 也算成与
"how do I use big integer" 相关，R@10 被压到 0.274。

### 复现命令

```bash
# 播种真实语料
node --env-file=.eval.env scripts/eval-seed.mjs --real true --granularity section \
  --logical-name memory.ctx2 --index-version iv.ctx.002 --run ctx2

# 检索质量
node --env-file=.eval.env scripts/eval-real.mjs \
  --logical-name memory.ctx2 --index-version iv.ctx.002 > out.json

# 答案质量（LLM-as-judge）
node --env-file=.eval.env scripts/eval-answer.mjs --real \
  --logical-name memory.ctx2 --index-version iv.ctx.002 > ans.json

# 端到端 + 单步双轨 Agent 能力
node --env-file=.eval.env scripts/eval-agent-capability.mjs --rounds 6 --repeats 3 > e2e.json
```

---

## 9. 这个仓库的工作方式（隐性约定）

读代码时会注意到大量长注释解释"为什么"。这是刻意的，几条约定：

- **每个行为断言都要有执行过的探针。** 注释里写着数字的地方，那个数字是跑出来的。
- **被推翻的推断写进注释和 commit message**，不只写结论。理由：知道"这条路试过且是错的"比
  知道结论更省时间。
- **拒绝一个查询好过返回 10 条自信的错答案。**
- **慢而正确的授权检查好过快的绕过。**
- 提交前跑 `npm run check`；改了检索还要跑集成测试。

---

## 10. 已知不足（别当成待发现的 bug）

- **跨主体聚合缺失**：检索合同只支持单主体计数与两主体比较。`t.ambig.cross-subject` 3/3 失败，
  模型回退到 `retrieval/exploratory` 而非报告能力缺失。
- ANN 索引未按 `(tenant_id, index_version_id)` 分区。
- `hnsw.iterative_scan` 未接进产品代码。
- 检索身份 HMAC 无 nonce、未绑定请求体，±30s 内可重放。
- `admin-server.ts:49` 硬编码 `127.0.0.1`。
- 用户满意度只有 LLM 打分，缺真人标注（实测 LLM 裁判与独立标注的 Pearson r 仅 0.248，
  两个自动打分器无法互相印证）。
- 重排默认关闭：实测有害（0.910 → 0.875）且多 ~120ms。

---

## 11. 常见环境问题

| 现象 | 原因 |
|---|---|
| 集成测试"全过"但很快 | 缺 `TEST_DATABASE_URL` 时静默跳过。CI 视跳过为失败 |
| 结果 JSON 解析失败 | `2>&1 > out.json` 把日志混进了 JSON。用 `> out.json 2> out.err` |
| 隧道 200 变 000 | 隧道进程死了：`kill $(cat .tunnel.pid); nohup node .tunnel.mjs > .tunnel.err 2>&1 & echo $! > .tunnel.pid` |
| `python3` 退出码 49 | Windows 上是坏的 stub，用 `python` |
| heredoc 写坏 TS 文件 | bash heredoc 会吃掉 `**`、`${...}`、`\n`。改用编辑器或 `python - <<'PY'` |

---

## 12. 下一步该读什么

按你要做的事选：

- **改检索** → 报告第 20~23 节 + `retrieval-service/src/index.ts` 的注释
- **改 Agent** → `docs/agent-capability-evaluation.md` + `FireFly-QuestLab产品与三Agent详细设计.md`
- **改数据模型** → `packages/persistence/migrations/`（18 个） + 相关 ADR
- **接新模型** → `docs/model-provider-integration.md` + ADR 0045
- **部署** → `docs/local-min-profile.md`（最简）或 `local-lite-profile.md`

`docs/adr/` 有 47 份决策记录，是"为什么是这样"的权威来源。
