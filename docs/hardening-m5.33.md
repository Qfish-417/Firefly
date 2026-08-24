# M5.33 加固说明：安全、健壮性与解耦

本轮不新增产品能力，只做三件事：关闭已确认可复现的安全与健壮性缺陷、把 Legacy Prototype v0 与 v3 主干解耦、
补齐防止同类缺陷再次静默的验证手段。

## 触发原因

集成测试套件在缺少 `TEST_DATABASE_URL` 时会静默跳过，且仓库此前没有 CI。把它真正跑起来之后，立刻暴露了三个
只在真实 PostgreSQL 上才会出现的缺陷（BIGINT 比较、Artifact 摘要冲突、`dedupe_key` 唯一约束与 ADR 0009/0039
的读侧去重语义矛盾）。静态审查与单元测试都没有发现这些问题，因此本轮的首要结论是：**缺少针对真实依赖的
自动验证，比任何单个缺陷都更危险**。

## 安全

| 位置 | 问题 | 处理 |
|---|---|---|
| `admin-api.ts` | 所有路由无鉴权，向任何能访问端口的进程返回完整运行轨迹、任务/审批历史与成本账本 | Bearer Token + `timingSafeEqual`；未配置 Token 时拒绝启动 |
| `admin-api.ts` | 500 响应回显 `error.message`，泄露 SQL、schema 与连接信息 | 固定返回 `{"error":"internal_error"}`，明细只进服务端日志 |
| `retrieval-server.ts` | Token 用 `===` 比较，非常量时间 | 比较固定长度 SHA-256 摘要 |
| `http-api.ts` | `authenticate` 与 `resolve_identity` 均为可选，缺失时直接信任调用方传入的 `principal.tenant_id` | 两者变为必需，测试需显式 `allow_unauthenticated: true` |
| `http-api.ts` | 422 分支回显任意内部错误文本 | 仅 `RetrievalPolicyError` 回显，其余 500 + 固定文案 |
| `http-embedding-provider.ts` | 无 `redirect: "error"`、不要求 HTTPS、允许 URL 凭据、`response.json()` 无上限 | 抽出 `http-provider-boundary.ts` 与 reranker 共用同一套出网策略 |
| `questlab-lite.yml` / `questlab-dev.yml` | committed 默认 Token 与身份 HMAC secret，且 `53200` 发布在所有网卡 | 改为 `:?` 强制显式提供，端口仅绑 `127.0.0.1` |
| `approval-repository.ts` | 重放校验缺失，同一 approval ID 可授权不同 subject | 校验 `run_id`/`subject_type`/`subject_id`，不一致抛 `ApprovalIdentityConflictError` |
| `model-invocation-repository.ts` | `error_message` 原样入库，无长度上限 | `redactErrorMessage`：脱敏 Bearer/`sk-`/`key=value`/URI 凭据/长 hex，截断至 1000 字符 |
| `canary-router.ts` | `subject_prefixes: [""]` 因 `startsWith("")` 命中一切 | 前缀至少 2 字符，授权 subject 不得为空 |
| `pi-ai-adapter.ts` | 缓存 token 计价硬编码为 0，缓存花费不进账本也不受预算约束 | 新增 `cache_read/write_cost_per_million`，缺省回退到 `input_cost_per_million` |
| `.gitignore` | 只覆盖 `.env` / `.env.*`，`infra/compose/*.env` 会被 `git add .` 带入 | 增加 `*.env` 与 `!*.env.example`，实际配置改为从 `.env.example` 复制 |
| Legacy Python Agents | Token 用 `!=` 比较 | 改为 `secrets.compare_digest` |
| Legacy `docker-compose.yml` | 全部端口发布在所有网卡，Java 管理端点与业务端口共用 | 全部绑 `127.0.0.1`，management 独立端口 |

## 健壮性

**失败必须表现为失败。** 检索在全部 retriever 失败、或授权后端对所有候选都抛错时，此前返回空的 `200`，
与"确实没有证据"无法区分。现在抛 `RetrievalUnavailableError` → `503`。Legacy 的 `QualityScorer` 同样把缺失
指标当作达标，采集器宕机会伪装成质量合格；现在缺失指标记 0 分并置 `degraded`，`ScoutClient` 在无 Token 或
无评分时不再编造 `score: 0.90`。

**任务不会再永久卡住。** `workflow_task` 没有 `fail()` 路径：worker 抛异常后行停在 `leased`，`attempt` 用尽后
`claimNext` 永久跳过它。新增 `fail()`（未用尽 → `pending` + backoff，用尽 → 终态 `failed`）与 `reapExpired()`
（回收租约过期且无剩余尝试、或已过 deadline 的任务），并在 `manual-evolution-workflow.ts` 的失败路径释放租约。

**资源上限。** XLSX 此前只校验压缩后大小，实测 200MB 空白压缩到 203KB（1029 倍），50MB 上限等于允许约 50GB
解压；现在解析前读 ZIP 中央目录校验声明解压大小与单条目压缩比。PDF 行分组由 O(n²) 改为线性（20k 行 549ms →
2ms），同时修掉 `Math.min(...line)` 的栈溢出——修复过程中发现旧逻辑是"取第一个匹配行"而非"最近行"，在 2000 组
随机页面上新分组每次都更紧凑。`mapWithConcurrency` 收口三处无界扇出；`listReadableEvents` 加上行上限并把截断
作为 `excluded_reasons` 上报（截断的计数被当作精确值是正确性问题，不是性能问题）。

**任务隔离。** `ManualEvolutionWorkflow.executeTask` 刚入队一个特定任务，却调 `claimNext`
（语义是"给我这个 subject 的下一个可用任务"）来租它。`subject` 是 Agent id、不含 run 维度，
所以并发 run 会互相认领对方的任务：实测并发 4 时 75% 的 run 失败、并发 8 时 100% 失败。
新增 `claimById(taskId, ...)` 按任务身份认领，资格判定与 `claimNext` 完全一致，因此无法借它
绕过队列保证或抢占活跃租约；`claimNext` 保持原样，仍是真实队列 Worker 的入口。修复后并发
4 / 8 的失败率均为 0，吞吐 4.04 → 20.18 run/s。

**向量检索形态。** `PostgresVectorRetriever` 原先把全部谓词放在 `WITH candidates AS MATERIALIZED`
里再对 CTE 排序，迫使先物化再排序，且 ANN 索引只能加速对基表的 `ORDER BY … <=>`。改为单条语句
（谓词一条未减，全部仍由数据库执行），同数据同实例各 8 次采样：p50 486ms → **97ms**。
排序表达式改用 `::vector(N)`，因为无维度 `VECTOR` 列只能建表达式索引，查询必须发出相同的转换
才可能匹配；`embedding_dimensions = N` 已在同一 `WHERE` 中断言，转换永不扩展或截断。

**一致性。** `getTrace` 的 21 条查询改为在单个 `REPEATABLE READ` 只读快照内执行，否则可能拼出运行从未处于过的
状态组合。迁移新增校验和表：已应用的迁移文件被改动会直接报错（实测能捕获）。migration 016 用部分唯一索引在
数据库层保证"每个 plugin 至多一个 active version"（实测第二个 active 被拒）。`reportIncident` 在复发时把
`status` 重置为 `open`，否则已解决的事件复发后会从 open 索引里消失。

**输入校验。** `required_entity_count: "abc"` 可复现地打瘫检索：经 planner 变成 `candidate_k=NaN` → SQL
`LIMIT NaN` → 驱动报错被 `Promise.allSettled` 吞掉 → 全部 retriever 标记失败 → 422。现在 HTTP 边界与 planner
双重校验，并拒绝未知顶层字段与超界 `filters`。

## 解耦

Legacy Prototype v0 整体移入 `legacy/prototype-v0/`，边界由工具链而非文档约束：`tsconfig.json` 只包含
`packages/**` 与 `agents/**`；`.dockerignore` 以单条 `legacy` 排除；CI 专设 `legacy` job 做 Python 字节编译与
Java `mvn compile`。`infra/` 只保留 v3 部署资产。详见 [ADR 0047](./adr/0047-legacy-prototype-isolation.md)。

## 验证

```powershell
npm run typecheck        # 0 错误
npm test                 # 222 tests / 213 pass / 0 fail / 9 skipped

docker compose -p firefly-questlab-min -f infra/compose/questlab-min.yml up -d
$env:DATABASE_URL = "postgresql://questlab:questlab@127.0.0.1:55433/questlab_it"
npm run db:migrate
$env:TEST_DATABASE_URL = $env:DATABASE_URL
npm run test:integration # 32 tests / 30 pass / 0 fail / 2 skipped
```

CI（`.github/workflows/ci.yml`，本仓库首个）分四个 job：`typescript`（typecheck + 单测）、`integration`
（`pgvector/pgvector:pg17` service，**任何跳过都判失败**）、`compose`（四个 compose 文件均可解析，且携带机密的
三个在缺机密时必须解析失败）、`legacy`（Python 字节编译 + Java 编译）。

## 行为变更（升级须知）

1. `ADMIN_API_TOKEN` 变为必需（或显式 `ADMIN_ALLOW_UNAUTHENTICATED=true`）。
2. lite / dev 档缺少 `RETRIEVAL_API_TOKEN` 或 `RETRIEVAL_IDENTITY_HMAC_SECRET` 时拒绝启动。
3. `RERANK_FAILURE_MODE` 默认由 `fallback` 改为 `strict`：静默降级排序质量与"不可用能力必须显式上报"冲突。
4. `WorkflowTaskRepository.enqueue` 更名为 `enqueueUngoverned`，使绕过治理计数在每个调用点可见；生产派发路径
   仍为 `LoopSentinel.dispatch` → `enqueueGoverned`。
5. `FIREFLY_MODEL_ROUTES="{}"`、`api_key_env` 指向未设置的变量、路由指向 provider 未声明的模型，现在都在启动时
   拒绝，而不是等到首次调用报 provider 401。
6. Legacy 路径变更：`./main-agent` 等改为 `./legacy/prototype-v0/main-agent`，根 `docker-compose.yml` 改为
   `legacy/prototype-v0/docker-compose.yml`。
7. `EventAggregate` 新增 `truncated` 字段。

## 仍然开放

- Legacy Prototype v0 的 `improvement` 生产/消费闭环、`evaluation_baseline` 趋势之外的完整评估流程仍不完整，
  且没有测试；它不是受支持的部署目标。
- Admin API 目前是单一共享 Token。跨越回环暴露前需要按操作者的身份、租户维度查询谓词、响应审计与限流。
- 检索身份声明仍无 nonce，也未绑定请求体：观测到一次签名对可在有效期内重放。
- SotaModel 中继的 `claude-opus-5-max` 计价仍是占位值（15 / 75 每百万），需按真实价目核对。
- 检索身份声明仍无 nonce（见上），且 ANN 索引尚未下推到基表扫描：ACL 谓词跨表形成 `Join Filter`，
  计划器无法把向量排序下推。彻底解决需要改数据布局（如按 `(tenant_id, index_version_id)` 分区），
  是安全性与性能的取舍，应在有明确 SLA 后决定。详见[性能基线](./performance-baseline.md)结论二。
- 生产部署需要为每个 `(embedding_model, embedding_dimensions)` 路由各建一条 HNSW 表达式索引。
  仓库不内置该迁移：`memory_chunk.embedding` 是无维度 `VECTOR`（一表多路由），写死一个维度会让
  其他路由的索引静默失效。
