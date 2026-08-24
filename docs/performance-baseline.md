# 性能基线：RAG 检索与三 Agent 闭环

本文记录一次可复跑的量化，以及量化得到的三个结论。数字全部来自实测，不是估算。
测量环境是 `questlab-min` 档：单容器 PostgreSQL 17 + pgvector，`mem_limit: 384m`、`cpus: 1.0`，
宿主 Node 24.14.1。**这不是生产容量结论**，是同一环境下的相对退化曲线与瓶颈定位。

## 复跑步骤

```powershell
# 1. 专用库。基准脚本会写入并删除数据，指向非 perf 库时会拒绝执行
docker exec firefly-questlab-min-postgres-1 psql -U questlab -d postgres `
  -c "DROP DATABASE IF EXISTS questlab_perf;" -c "CREATE DATABASE questlab_perf OWNER questlab;"
docker exec firefly-questlab-min-postgres-1 psql -U questlab -d questlab_perf `
  -c "CREATE EXTENSION IF NOT EXISTS vector;"
$env:DATABASE_URL = "postgresql://questlab:questlab@127.0.0.1:55433/questlab_perf"
node packages/persistence/src/migrate.ts

# 2. 灌数。重复执行是累加式的，增大 docs 即可扩容到下一量级
Get-Content scripts/perf-seed.sql | docker exec -i firefly-questlab-min-postgres-1 `
  psql -U questlab -d questlab_perf -v docs=2000 -v chunks=5 -v ON_ERROR_STOP=1 -f -

# 3. 三项基准
node scripts/perf-retrieval.mjs --iterations 60 --label 10k
node scripts/perf-agent-loop.mjs --iterations 16 --concurrency 1,4,8
Get-Content scripts/perf-vector-index.sql | docker exec -i firefly-questlab-min-postgres-1 `
  psql -U questlab -d questlab_perf -v ON_ERROR_STOP=1 -f -
```

## 口径

检索基准走**完整的 `RetrievalGateway`**：计划、RRF 融合、ACL 授权、证据选择、契约校验。裸 SQL
只能量化数据库，量化不了治理层在每次查询上的固定开销。Embedding 用确定性本地 stub，因此结果
不含 provider 网络延迟——真实 provider 延迟必须单独测，混在一起会掩盖数据量导致的退化。

Agent 基准用 Stub Agent，在**进程内**直接调用。命令行方式每次要付约 930ms 的 TypeScript 转译
（`node --env-file` 冷启动 119ms，`control-plane` 模块加载 934ms），会把 150ms 级的闭环成本完全淹没。

所有数字都在预热之后采集：首个 run 要付 JIT、连接池建立与 prepared statement 首次编译。

## 结论一：向量检索在 10 万 chunk 时退化 30 倍

`RetrievalGateway` 端到端，每量级 60 次采样，单位毫秒：

| 阶段 | 10k chunks p50 | 10k p95 | 100k p50 | 100k p95 | p95 退化 |
|---|---|---|---|---|---|
| lexical | 27.4 | 37.3 | 34.3 | 47.8 | 1.3x |
| vector | 78.3 | 84.8 | 620.1 | **2540.7** | **30x** |
| hybrid | 92.6 | 120.6 | 602.0 | 1676.1 | 14x |

以上是**修复前**在 min 档测得的原始退化曲线，保留作为对照。结论二的修复把 100k 的 vector
p50 降到 152ms、p95 降到 195ms（内存充足实例）；min 档因索引装不进内存仍在 400ms 量级，
详见"已知不足"。

词法检索靠 `memory_chunk_search_idx`（GIN）扩展良好。向量检索走全表扫描：10k 时是
`Seq Scan`，100k 时升级为 `Parallel Seq Scan`（3 worker，每个扫 33333 行），
p95 达到 2.5 秒。`docs/local-lite-profile.md` 已把"ANN/HNSW 不要求，延迟随数据量增长"
列为显式降级；本次把"增长"量化为 **10 万 chunk 时 p95 2.5 秒**。

## 结论二（归因已更正）：慢 5 倍的原因是距离类型转换，不是 CTE 物化

原始测量（256 维、10 万行）记录为「`WITH candidates AS MATERIALIZED (...)` 迫使先物化再排序，
去掉 CTE 后 p50 486ms → 97.3ms」，并把成因归给 CTE 物化。**这个归因是错的**，在 2048 维语料上
用四组合隔离测量（30720 chunk、10 条查询、同进程交替，排除环境漂移）：

| 形态 | p50 |
|---|---|
| `MATERIALIZED` CTE + `vector` 距离 | 109ms |
| 无 CTE + `vector` 距离 | **100ms** |
| `MATERIALIZED` CTE + `halfvec` 距离 | 461ms |
| 无 CTE + `halfvec` 距离 | 453ms |

CTE 只值约 9ms；**4.5 倍的差距完全来自 `halfvec` 转换**——每行都要做一次 2048 维
fp32 → fp16 转换。旧测量之所以看起来像 CTE 的问题，是因为那次同时改了两个变量。

结论随之改变：`PostgresVectorRetriever` 的默认路径**保留** `MATERIALIZED` CTE（它让 ACL 先完成
过滤，排序只作用于已授权行），但距离表达式用 `vector` 而不是 `halfvec`。`halfvec` 转换存在的
唯一目的是匹配 ANN 表达式索引，而默认路径本就用不上该索引（见下一节），此时转换是白付的开销。

### 为什么必须写成 `::vector(256)`

`memory_chunk.embedding` 是无维度的 `VECTOR`，这样一张表才能容纳多个 embedding 路由。pgvector
拒绝在这种列上建索引（实测 `ERROR: column does not have dimensions`），唯一可索引的形式是表达式
索引 `(embedding::vector(N))`。因此查询必须发出**完全相同**的强制转换，否则计划器无法匹配。
`embedding_dimensions = N` 已在同一个 `WHERE` 中断言，所以这个转换永不扩展或截断已存向量。

对应的索引形态是：

```sql
CREATE INDEX ... ON questlab.memory_chunk
  USING hnsw ((embedding::vector(256)) vector_cosine_ops)
  WHERE embedding IS NOT NULL AND chunk_level = 'child';
```

每个 `(embedding_model, embedding_dimensions)` 路由需要各自一条这样的索引。仓库**没有**内置这条
迁移：维度取决于部署选用的 embedding 模型，写死一个维度会让其他路由的索引失效而无人察觉。

### ANN 索引仍未完全下推——已知剩余限制

无论是否使用 CTE，`EXPLAIN` 显示计划都是 `Parallel Seq Scan` + `Sort`，而不是 `Index Scan`。原因是
ACL 谓词跨表：`memory.scope = 'public' OR index_version.tenant_id = ...` 与 `memory_acl` 的
`EXISTS` 子查询都依赖 join 后的行，形成 `Join Filter`，计划器无法把 ANN 排序下推到基表扫描。

用内联字面量、单一固定查询向量并预热后可以打到 `Index Scan using perf_hnsw_idx`，**2.2ms**；
但网关每次查询向量不同，所以这条路径在真实调用序列下不稳定命中。

**后续已做了一半**：`PostgresVectorRetriever` 增加了 `ann_recall_mode` 选项。`approximate` 先在基表上
只带索引自身的谓词跑向量搜索，再用 ACL 过滤其输出——这让 HNSW 真正生效（4092ms → 约 3ms），
代价是 chunk 级召回从 100% 降到 86.7%（30720 chunk、8 查询、top-16、对照 fp32 精确解）。
因为是有损的，所以它是显式选项而非默认值，默认仍是 `exact`。详见
[量化评测报告](./evaluation-report.md) 第 12.2 节，那里还记录了三处被数据否证的推断。

按 `(tenant_id, index_version_id)` 分区、让 ACL 判定变成分区裁剪，从而**同时**拿到索引速度和
精确召回，仍是未做的决策。

## 结论三（已修复）：三 Agent 闭环曾无法并发跑多个 run


串行延迟（16 次采样，预热后，单位毫秒）：

| 阶段 | p50 | p95 | 跨 4 轮的 p50 区间 |
|---|---|---|---|
| `demo:start`（Director + Scientist，2 任务） | 63.7 | 78.5 | 63.7 – 86.0 |
| `demo:approve`（Engineer + canary + outcome，3 任务） | 111.6 | 164.2 | 111.6 – 172.0 |
| `getTrace`（21 条查询，单 REPEATABLE READ 快照） | 14.1 | 20.7 | 14.1 – 20.8 |
| 单 run 全流程 | 183.8 | 218.2 | — |

区间列是重复执行 4 轮（每轮 12-16 次采样）观察到的 p50 波动范围，约 ±25%。单机单核、
容器内 PostgreSQL 且宿主同时跑着其他容器，因此这个量级的抖动是环境噪声，不是回归信号；
判断改动是否引入回归时应比较区间而不是单个数字。

这个延迟**不随 RAG 数据量变化**，五个任务是 `await` 串行推进的，符合治理状态机的设计。

并发段曾暴露一个未记录的正确性缺陷，现已修复：

| 并发度 | 尝试 | 修复前成功 | 修复前失败率 | 修复后成功 | 修复后失败率 | 修复后吞吐 |
|---|---|---|---|---|---|---|
| 1 | 16 | 16 | 0% | 16 | 0% | 4.04 run/s |
| 4 | 16 | 4 | **75%** | 16 | **0%** | 14.63 run/s |
| 8 | 16 | 0 | **100%** | 16 | **0%** | 20.18 run/s |

失败信息曾是 `Task task.generatemissionplan.run.… could not be leased by learning-director`。

根因：`ManualEvolutionWorkflow.executeTask` 用 `subject = agentId`（如 `learning-director`）派发任务，
然后调 `claimNext` 认领。但 `claimNext` 回答的是"给我这个 subject 的下一个可用任务"，而
`subject` 不含 run 维度——两个 run 并发时，A 的 Director 会认领到 B 的 Director 任务，随后
`claimed.id === taskId` 断言失败。这不是性能问题：任务被别的 run 抢走本身就是隔离破损。

修复：新增 `WorkflowTaskRepository.claimById(taskId, ...)`，按任务身份认领。资格判定与
`claimNext` 完全一致（可用、未过 deadline、未取消、尚有尝试次数、pending 或租约已过期），
因此无法借它绕过队列保证或抢占活跃租约。`executeTask` 改用 `claimById`：它刚入队了一个特定任务，
要租的就是**那一个**，而不是"该 subject 的队首"。`claimNext` 保持原样，仍是真实队列 Worker 的入口，
两个方法的语义差异写进了各自的文档注释。

并发吞吐随并发度线性提升(4.04 → 14.63 → 20.18 run/s)，说明五任务串行只发生在单个 run 内部，
不同 run 之间是真并行的。

回归测试：`concurrent runs do not steal each other's Agent tasks` 并发跑 6 个 run，断言无一失败、
全部到达 `learned`，并逐个校验每个 run 恰好拥有自己的 5 个任务且全部 `completed`——被偷走的任务
表现为"某个 run 少了一个任务"而不是报错，所以只断言完成状态是不够的。

## 已知不足

- 合成语料不代表真实召回质量，只用于量化延迟随数据量的变化。召回质量由
  `packages/memory-workers` 的固定评测集负责，两者不可互相替代。
- 未测真实 Embedding provider 延迟、未测重排、未测 HTTP 层（Retrieval API 经
  `node:http`），因此这些不是端到端用户延迟。
- 单机单容器、`cpus: 1.0`，没有测网络往返与多副本。
- **min 档的容器限制会主导向量检索结果。** min 档 `mem_limit: 384m`、`shared_buffers=48MB`，
  而 100k × 256 维的 HNSW 索引占 130MB、表占 195MB：索引装不进内存，每个新查询向量都要冷读磁盘。
  实测差异极大——min 档索引构建 3 分 47 秒、查询 p50 434ms；同数据在 2GB/768MB 实例上构建 17 秒、
  p50 152ms。因此**向量检索的数字必须在放开内存后才有意义**，min 档的向量数字只说明"降级档不适合
  跑向量检索"。另外 Docker 的 `/dev/shm` 默认 64MB，与 `--memory` 无关，建索引需要 `--shm-size`。
- 语料设计上踩过四个坑，都已在 `scripts/perf-seed.sql` 内注释说明：三组词用线性函数选词会
  让多词查询命中率塌成 0；每条 chunk 结构相同会让 `ts_rank_cd`（按词距打分）给出完全一致的分数；
  `source_type` 与 `entity_keys` 全表同值会让 `selectEvidence` 的去重逻辑只选出 1 条证据；
  embedding 用线性式 `(d*31+c*17+g) % 1000` 生成会有周期性，实测造成 100 个距离为 0 的并列邻居，
  top-k 不唯一因而召回率指标失去意义。四者任一未处理，测出的都不是真实流水线的成本。
- 合成随机向量在 256 维下近邻区分度天然很差：实测第 24 名与第 25 名的余弦距离只差 0.00002，
  top-k 边界本身是任意的，因此**召回率不是这批数据上的有效指标**。改用距离质量比更稳健：
  ANN 返回结果的平均距离 / 精确结果的平均距离 = **1.0164**，即近邻质量只差 1.6%。
  真实 embedding 有语义聚簇，不会出现这种区分度塌陷。

## 建议的下一步

1. 先定目标数据量与 SLA。没有目标值，基准只能产出数字，不能判定是否还需要继续优化。
2. 结论二剩下的部分：`approximate` 模式已让 ANN 索引生效但有 13% 召回损失，`exact` 精确但走顺序
   扫描。要同时拿到两者需要改数据布局（按 `(tenant_id, index_version_id)` 分区，让 ACL 判定变成
   分区裁剪而非 join 过滤）。这是安全性与性能的取舍，应在有明确 SLA 后再决定。
3. 生产部署需要为每个 `(embedding_model, embedding_dimensions)` 路由各建一条 HNSW 表达式索引；
   仓库不内置该迁移，因为写死维度会让其他路由的索引静默失效。
4. 向量检索的容量测试必须在放开内存限制的实例上进行，不能用 min 档。
