# FireFly QuestLab

FireFly QuestLab 是一个以项目制学习世界为业务主体、以真实学习效果驱动受控改进的三 Agent 系统。

当前阶段是 **v3 架构落地**。M0 契约与状态机、M1 PostgreSQL 工作流事实层、M2 无 LLM 人工闭环、M2.1 治理与循环哨兵、M3 插件发布闭环、M4 三 Agent 模型闭环已经完成。现有 Java/Python 教育买课与秒杀实现属于 `prototype-v0`，仅用于追溯早期实验，不代表目标架构，也不应继续在其上补业务功能。

## 三 Agent

| Agent | 角色 | 核心产物 |
|---|---|---|
| Learning Director | 业务 Agent / 学习导演 | MissionPlan、NextAction、Intervention、LearnerMessage |
| Learning Scientist | 侦察 Agent / 学习科学家 | LearningFinding、EvidencePack、OutcomeEvaluation |
| Experience Engineer | 代码处理 Agent / 体验工程师 | ChangeSet、PatchCommit、PluginDigest、GeneratedTests |

三个 Agent 不通过自由文本直接接力，也不直接修改彼此状态。Control Plane 通过版本化 `Task` 调度能力，Agent 通过 `Event` 报告事实，通过 `ArtifactRef` 交付大对象；PostgreSQL 工作流状态是唯一事实源。整体采用“执行可分布、治理与事实源集中”的联邦式架构，Loop Sentinel 是确定性平台能力，不是第四个 Agent。

## 文档入口

按以下顺序阅读：

1. [开工架构与实施顺序](./FireFly-QuestLab-开工架构与实施顺序.md)：编码阶段的事实源，包含通信协议、模块边界、仓库结构、里程碑和 GitHub 权限。
2. [v3 目标架构图](./FireFly-QuestLab-目标架构-v3.drawio)：43 页分层主图，包含联邦治理、循环防护、Model Gateway、RAG、索引切换、后台 Worker、Parent/Child 扩展、固定索引质量评测、删除修复调度、retired 索引回收、结构化图事实、受治理重排、本地轻量运行、三 Agent CLI 与审计视图。
3. [产品与三 Agent 详细设计](./FireFly-QuestLab产品与三Agent详细设计.md)：产品、领域对象、状态机和太阳能纵向切片。
4. [RAG 与记忆系统设计](./FireFly-RAG与记忆系统设计.md)：聚合检索、记忆分层、压缩、多模态与安全。
5. [工具系统设计](./FireFly-工具系统设计.md)：五类工具、发现、异步、动态加载和 KV Cache。
6. [开放式架构分析](./FireFly-开放式架构分析.md)：早期问题分析与决策背景。
7. [目标架构构建文档](./FireFly-目标架构构建文档.md)：更详细的阶段性建设要求。
8. [Model Gateway 构建设计](./FireFly-Model-Gateway构建设计.md)：M4 代码边界、配置、失败语义和真实 Engineer 工程生命周期。
9. [本地轻量运行说明](./docs/local-lite-profile.md)：低资源 Compose、可接受降级矩阵与不可降级的安全边界。
10. [本地最小降级运行说明](./docs/local-min-profile.md)：仅 PostgreSQL 容器，宿主 Node 进程完成迁移、三 Agent 闭环、检索与审计，使用独立端口与数据卷。
11. [模型 Provider 接入说明](./docs/model-provider-integration.md)：内置模型目录、三 Agent 选型、凭据变量与无付费接入诊断。
12. [M5.33 加固说明](./docs/hardening-m5.33.md)：本轮安全、健壮性与解耦改动的清单、验证方式与行为变更。
13. [性能基线](./docs/performance-baseline.md)：RAG 检索与三 Agent 闭环的可复跑量化、瓶颈定位与已知不足。
14. [量化评测报告](./docs/evaluation-report.md)：30720 chunk 带标注语料、真实远程模型下的全量数据——11 个检索场景 x 5 个 k 值（1/3/5/10/20）的 MRR / MAP / nDCG / Recall / Precision，7 个 intent 的检索计划，4 档语料规模曲线，halfvec 相对 fp32 的精度损失拆分（fp16 舍入 vs HNSW 近似），LLM-as-judge 答案质量与客观引用精确率，以及 Agent 顺序与并发（每档 >=100 次调用，p99 可信）。
15. [Agent 能力五维评测](./docs/agent-capability-evaluation.md)：任务完成率、步数效率、工具调用正确率、Token 成本与人工评分的端到端 + 单步双轨评测。工具调用正确率过真实 `validateRetrievalRequest` 边界而非比对字符串；步数分母由状态机声明的理论最小值给出而非实测值；含 A/B 验证，以及满分意味着题目太容易的处理。

`FireFly-开放式目标架构.drawio` 是旧的 11 页分析图，内容较密且存在重复；保留作历史参考，不再作为主图。`FireFly-Agent设计.drawio` 和 `FireFly-Agent设计说明.md` 均属于 Legacy Prototype v0。

Legacy Prototype v0 的全部代码已移入 `legacy/prototype-v0/`（Java 主力、两个 Python Agent、gRPC proto、RAG 脚本、11 服务 Compose 与 `init-db.sql`）。它与 v3 主干无任何依赖关系，仓库根目录只保留一个可运行系统，`infra/` 只承载 v3 部署资产。详见 [ADR 0047](./docs/adr/0047-legacy-prototype-isolation.md)。

## 推荐起步形态

```text
TypeScript 模块化单体
├─ Learning Runtime
├─ Control Plane
├─ Governance / Loop Sentinel
├─ Model Gateway（pi-ai）
├─ Learning Director
├─ Learning Scientist
├─ Experience Engineer
└─ Tool / Memory / Plugin Ports

独立隔离 Worker
├─ Docker Sandbox Runner（无网络 / 只读 / 资源上限）
├─ Replay / Evaluation
└─ Python Analytics（按需）

PostgreSQL + pgvector
├─ 业务与工作流事实
├─ Outbox / Inbox
└─ 初期混合检索
```

三个 Agent 先逻辑拆分、进程内组合；当权限、故障域、吞吐或扩缩容提出真实要求时，再通过不变的契约拆成服务。

## 第一个纵向切片

首个切片固定为“火星基地太阳能 Mission”：

```text
solar-energy@1.2.0 忽略昼夜变化
→ 学习者形成 constant_solar_output 错误概念
→ Scientist 产生可复现 Finding
→ 人工批准 ImprovementPlan
→ Engineer 在 worktree / sandbox 生成 ChangeSet
→ 独立门禁验证物理、Rubric、Replay、可访问性和安全
→ 授权 Canary
→ 达标激活 1.3.0，退化回滚 1.2.0
```

编码顺序不是先接模型，而是：契约与状态机 → PostgreSQL 事实层 → 无 LLM 人工闭环 → 治理与 Loop Sentinel → 插件门禁与真实回滚 → pi-ai Model Gateway → RAG、记忆和动态工具。

## 当前仓库状态

- Git 仓库已关联 `Qfish-417/Firefly`，开发采用短分支和可审查提交。
- M0 第一批已落地：`packages/contracts` 提供 v1 Schema 与运行时校验，`packages/learning-domain` 提供四个可测试状态机。
- M1 PostgreSQL 事实层已落地：`packages/persistence` 提供迁移、EvolutionRun 原子状态迁移、WorkflowTask 租约与检查点、Outbox / Inbox，以及 Artifact ACL 与血缘元数据。
- M2 人工闭环已落地：`packages/agent-kernel`、`agents/*` 和 `packages/control-plane` 提供三个可拆分 Stub Agent、人工审批边界、确定性验证/Outcome 以及只读 Admin API。
- M2.1 治理与循环哨兵已落地：`packages/governance`、治理契约和 PostgreSQL 因果图实现跳数、任务数、状态迁移数、重试上限、同一 epoch 指纹去重、自委派阻断、事件风暴检测与 Agent/Run 隔离。
- M3 插件发布闭环已落地：`packages/control-plane` 的 `PluginReleaseWorkflow` 编排 `packages/plugin-platform` 和 `plugins/solar-energy`，提供批准路径约束、真实 Git worktree Commit、跨平台稳定 Digest、固定镜像 Docker Sandbox、四项独立门禁、二次发布审批、授权 Canary、原子激活与按 Digest 回滚。
- M3 发布事实由 PostgreSQL 的 PluginVersion、PluginRelease、SandboxRun、CanaryEvaluation 与 Outbox 记录；发布必须引用已完成的受治理 Experience Engineer Task。
- M4 Model Gateway 已落地：`packages/model-gateway` 使用维护中的 `@earendil-works/pi-ai@0.83.0`，提供 generate/stream、主备路由、预算、重试/超时/取消、不可变快照，并显式保留独立 embed/rerank 端口。
- 三个 Agent 均已有真实模型 Worker，并保留确定性 Stub。Director 只补充固定阶段内的指导；Scientist 只解释授权证据；Engineer 只产生批准路径内的 PatchProposal，再由受控工程工具完成真实 Git Commit、Docker Sandbox、ChangeSet 与 VerificationReport。
- `PluginReleaseWorkflow.prepareVerified` 直接消费已完成的受治理 Engineer 任务和门禁证据，仍需独立发布审批；模型不能改写 Mission、证据身份、Canary、门禁、审批或发布状态。
- M5 RAG 基础已落地：`packages/retrieval-planner` 动态计算 candidate/fusion/rerank/context K，`packages/persistence` 提供 Memory ACL 与 StructuredEvent 确定性聚合事实层，`packages/retrieval-service` 提供并行召回、RRF、融合后 ACL 复检、证据充分性门禁和结构化聚合边界。
- M5 检索合同已版本化：`packages/contracts` 统一定义 `QueryPlan`、`EvidenceCitation`、`StructuredResult`、`EvidenceItem` 与 `EvidencePack` v1 类型和 JSON Schema；Gateway 在返回前强制校验，不充分、冲突或非法聚合结果均 fail closed。
- M5 PostgreSQL 混合检索已落地：`packages/retrieval-postgres` 提供真实 FTS、pgvector、幂等 Chunk 索引和最终 ACL 复检；Memory 删除事务同步清理本地派生索引与来源事件，并通过 Outbox 继续传播到外部存储。
- M5 索引生命周期已落地：`RetrievalIndexRepository` 保存不可变构建快照，Chunk 绑定索引版本，同一租户/逻辑索引通过事务锁和唯一约束原子切换 active 版本；Retriever 与最终授权只读取 active 版本。
- M5 删除完成语义已落地：本地删除回执按 allowlist 目标记录 `pending/failed/completed`，每个外部目标必须提交版本化 Ack；只有全部完成才产生全局删除完成状态和事件。
- M5.1 后台执行闭环已落地：`packages/memory-workers` 通过定向 Outbox 租约运行索引构建与删除消费者；索引 Worker 支持确定性分块、Embedding 形状校验、基础 Ready Gate、崩溃恢复和可选原子激活；对象删除通过官方 AWS S3 SDK 兼容 MinIO/S3，失败按指数退避并可由 reconciliation 重新排队。
- M5.1 明确区分 Provider 删除失败与 Ack/数据库/Outbox 发布失败：只有 Provider 失败才写 failed Ack；若 completed Ack 已提交而发布标记失败，重放只补齐发布，不重复改变删除事实。
- M5.2 可审计索引质量门禁已落地：`IndexQualityReport` 将结构、来源水位、ACL、Recall、Citation 检查与 build/version/configuration Digest 绑定并持久化；`AdvancedIndexReadyGate` 强制五项检查齐全、名称唯一、分数与阈值自洽，任一失败即阻止激活。
- M5.3 Parent/Child 检索扩展已落地：Markdown 按标题层级生成无 Embedding 的 Parent Section 与可召回 Child Chunk；FTS/pgvector 只召回 Child，选证据后再扩展共享 Parent，并重新校验 active 索引、租户和 Memory ACL。Parent 超过剩余 Token 预算时保留 Child，跨 Memory/索引版本父引用和扩展越权均 fail closed。PDF、代码与表格的结构化 Chunker 已在 M5.8 补齐，`ParserBackedIndexSourcePort` 已完成严格/降级边界；M5.13 新增受治理 HTTP Parser Adapter，M5.14-M5.20 已接入 TypeScript/JavaScript AST、CSV、版本化转录 JSON、受 digest 核验的 PDF.js、ExcelJS XLSX、HTTP OCR Layout 和 HTTP ASR/说话人分离 Provider 合同；具体 OCR/ASR 服务仍待按环境部署。
- M5.4/M5.7 固定质量评测已落地：`IndexEvaluationSet` 用不可变 Artifact Digest 固定查询、主体、允许/禁止 Memory、Citation 期望、阈值以及 vector/hybrid 的查询 Embedding 模型快照；ACL/Recall/Citation Probe 共享一次真实评测。`PostgresBuildingIndexQualityEvaluator` 支持 FTS、pgvector cosine 和确定性 50/50 hybrid 融合，只读取任务绑定的 building 版本并复用真实 Memory ACL，版本激活后旁路立即关闭。
- M5.5 删除修复调度已落地：`DeletionReconciliationScheduler` 周期扫描超时 failed 目标，合并同实例并发 tick，并依赖数据库行锁、状态复核和幂等 Outbox 身份支持多实例运行；失败周期不会终止循环，AbortSignal 可优雅停止，周期结果通过结构化 Observer 输出。`npm run memory:reconcile` 提供独立进程入口。
- M5.6 retired 索引回收已落地：迁移 011 记录 `purged_at` 和显式 retention hold；`RetiredIndexGarbageCollector` 只清理超过保留期、没有有效审计 hold 的 retired 版本切片。active、未到期和受 hold 保护的版本均跳过；版本身份、原始计数与质量报告保留，并通过幂等 `RetrievalIndexPurged` Outbox 事件记录事实。
- 旧 Java/Python 原型仍在原目录，只作追溯参考，不被新 TypeScript packages 依赖。

开发检查：

```bash
npm install
npm run check
```

M5.11 retrieval context expansion is governed by the Gateway: deterministic region, neighbor, entity and temporal candidates are ranked, deduplicated, budgeted and ACL rechecked. See [ADR 0025](./docs/adr/0025-deterministic-evidence-expansion.md) and diagram page 28.

M5.12 maintenance cycles are durable: migration 012 adds an idempotent `maintenance_cycle` ledger used by deletion reconciliation and retired-index GC. Ledger failures are observable and do not alter the underlying maintenance result. See [ADR 0026](./docs/adr/0026-durable-maintenance-cycle-ledger.md).

M5.13 adds a governed HTTP parser provider boundary with fixed HTTPS endpoints, MIME allowlists, timeout/response limits, no redirects and versioned structured JSON. Strict or explicit degraded behavior remains owned by `ParserBackedIndexSourcePort`. See [ADR 0027](./docs/adr/0027-governed-http-parser-provider.md).

M5.14 includes a real TypeScript/JavaScript parser based on the official Compiler API. It emits declaration/member structure, signatures and exact line ranges with bounded source, node and depth limits. See [ADR 0028](./docs/adr/0028-typescript-compiler-api-parser.md).

M5.15 includes a standards-compliant CSV table parser based on `csv-parse`. It preserves quoted fields, enforces deterministic headers and row widths, and bounds source, row, column and cell sizes before `TableStructureChunker`. See [ADR 0029](./docs/adr/0029-csv-table-parser.md).

M5.16 adds a versioned canonical transcript JSON parser with dedicated MIME types, stable turn/speaker identity, governed roles, ISO timestamps and bounded-resource validation before `ConversationTurnChunker`. ASR and diarization remain external providers. See [ADR 0030](./docs/adr/0030-versioned-transcript-json-parser.md).

M5.17 adds bounded binary artifact hydration with SHA-256 Citation verification and a real PDF.js layout parser. It emits page text lines and bounding boxes; malformed or scanned PDFs fail closed and require an explicit OCR provider. See [ADR 0031](./docs/adr/0031-binary-source-hydration-and-pdfjs-parser.md).

M5.18 adds a real ExcelJS XLSX parser over the verified binary source boundary. It preserves worksheet identity, rectangular headers/rows and cached formula results under bounded resources, while never evaluating formulas or macros. See [ADR 0032](./docs/adr/0032-exceljs-xlsx-table-parser.md).

M5.19 adds a governed `HttpOcrLayoutParser` and an explicit `PdfTextOrOcrParser`. Verified binary artifacts are sent only to a fixed HTTPS endpoint; versioned page/block output is bounded and validated for digest, coordinates, confidence and provider identity. OCR is selected only when PDF.js reports no extractable text. See [ADR 0033](./docs/adr/0033-governed-http-ocr-layout-provider.md).

M5.20 adds a governed `HttpAsrDiarizationParser`. Verified audio is sent to a fixed HTTPS endpoint and normalized into deterministic timed turns with explicit speaker identity, confidence, language and provider/model lineage before `ConversationTurnChunker`. See [ADR 0034](./docs/adr/0034-governed-http-asr-diarization-provider.md).

M5.21 adds a text-first production index-build boundary. `PostgresMemoryIndexSourcePort` resolves active public/tenant Memories to persisted Artifact identities, verifies source watermarks, SHA-256 text bytes and UTF-8, and rejects non-text input until a governed parser produces text. Run the non-activating worker with `npm run memory:index-build`; see [ADR 0035](./docs/adr/0035-text-first-runtime-boundary.md).

M5.22 adds an explicit text Embedding boundary. `HttpEmbeddingProvider` targets a governed OpenAI-compatible endpoint, validates vector count, ordering, dimensions and budgets, and is optional in both the index Worker and Retrieval API. pi-ai remains the generation/streaming gateway; vector/hybrid retrieval requires `EMBEDDING_ENDPOINT`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS` and the retrieval-side `EMBEDDING_MODEL_SNAPSHOT`; see [ADR 0036](./docs/adr/0036-text-embedding-provider-boundary.md).

M5.23 completes the durable deletion runtime boundary. `memory:delete` runs one targeted consumer for object storage or a governed fixed HTTPS endpoint for external lexical/vector, multimodal, cache, summary and evaluation projections. External success requires an immutable, identity-bound deletion receipt; see [ADR 0037](./docs/adr/0037-governed-external-deletion-consumers.md).

M5.24 completes production Index Ready Gate composition. `memory:index-build` now defaults to the full source-watermark/ACL/Recall/Citation gate and loads a digest-verified fixed evaluation set from `MEMORY_INDEX_EVALUATION_SET_FILE`. Explicit `structural` development mode cannot auto-activate and its incomplete report is rejected by the repository activation boundary; see [ADR 0038](./docs/adr/0038-production-advanced-index-ready-gate.md).

M5.25 completes deterministic comparison and temporal aggregation over the PostgreSQL `StructuredEvent` fact layer. Typed `structured_query` variants are validated at HTTP and adapter boundaries; visible events are ordered, deduplicated and conflict-aware before calculating left-minus-right counts or selecting first/last event time. At that milestone `multi_hop` remained fail closed pending the graph-edge contract completed by M5.26; see [ADR 0039](./docs/adr/0039-structured-comparison-temporal-aggregation.md) and diagram page 38.

M5.26 completes governed multi-hop retrieval. Migration 013 and the v1 `StructuredEdge` contract define directional, time-valid, provenance-bound and ACL-scoped graph facts; `find_relation_path` runs a deterministic, cycle-safe breadth-first search with a maximum of six hops and a bounded readable graph. Memory deletion removes dependent edges transactionally. Missing paths and conflicts remain explicit and fail closed; see [ADR 0040](./docs/adr/0040-versioned-structured-edge-multi-hop.md) and diagram page 39.

M5.27 completes the optional governed reranking boundary. `HttpRerankerProvider` sends only the ACL-authorized dynamic `rerank_k` window to a fixed HTTPS endpoint, enforces request, response, index, normalized-score and budget limits, and never routes reranking through pi-ai. Retryable provider outages may fall back to deterministic RRF order; malformed identities, duplicate indexes, invalid scores and budget violations fail closed. Configure it with `RERANK_ENDPOINT` and `RERANK_MODEL`; see [ADR 0041](./docs/adr/0041-governed-http-reranker.md) and diagram page 40.

M5.28 defines the local completion target. `npm run lite:up` starts only a resource-bounded PostgreSQL fact layer, one-shot migration and lexical Retrieval API; persistent local data survives ordinary shutdown. Embedding, exact pgvector and reranking remain opt-in, while MinIO, background Workers, OCR/ASR and Sandbox stay off by default. Quality and infrastructure may degrade explicitly, but ACL, structured truth, Loop Sentinel, citations, budgets and approvals remain strict; see [ADR 0042](./docs/adr/0042-local-lite-degradation-profile.md), the [local guide](./docs/local-lite-profile.md) and diagram page 41.

M5.32.1 adds the further-degraded `npm run min:up` local profile without changing lite or dev. It runs only the pgvector-backed PostgreSQL fact layer in Docker, while migration, the deterministic three-Agent loop, lexical Retrieval API and read-only Admin API run as host Node processes. Its project, volume and loopback-only ports (`55433 / 53201 / 3101`) are isolated from lite/dev; MinIO, Workers, Sandbox, multimodal, Embedding, reranking and real models remain explicitly unavailable. See [ADR 0046](./docs/adr/0046-minimal-local-degradation-profile.md) and the [minimal local guide](./docs/local-min-profile.md).

M5.29 makes the local three-Agent loop directly operable. `npm run demo:start` persists a deterministic learning run and stops at `awaiting_approval`; `npm run demo:approve` requires an explicit run ID, approver and reason before resuming Engineer build, Director canary and Scientist outcome stages. The commands reuse the integration-tested workflow and zero-cost Stub Agents, while the read-only Admin API exposes the resulting causal trace; see [ADR 0043](./docs/adr/0043-local-manual-evolution-cli.md) and diagram page 42.

M5.30 adds attributed model accounting and a deterministic, read-only Audit Agent. Every pi-ai generation attempt can be bound to its run, task and business Agent; replay-safe PostgreSQL settlement updates the run token/cost budget atomically. `GET /admin/audit/agents` exposes three-Agent totals and `GET /admin/audit/runs/{run_id}` exposes a redacted causal activity report with failure, retry, telemetry-gap and budget-threshold alerts. See [ADR 0044](./docs/adr/0044-attributed-model-usage-audit-agent.md), the [monitoring guide](./docs/audit-monitoring.md) and diagram page 43.

M5.31 adds a no-cost model onboarding diagnostic. `npm run model:catalog` lists the pinned pi-ai Provider/model catalog and `npm run model:doctor` validates configured fallback routes, text-input support and credential availability without exposing keys or sending a paid model request. See the [model integration guide](./docs/model-provider-integration.md).

M5.33 是一次全仓库安全与健壮性加固，并把 Legacy Prototype v0 隔离到 `legacy/prototype-v0/`。Admin API 与 Retrieval API 补上鉴权、常量时间比较、请求超时、错误信息脱敏与有界优雅关闭；Embedding 客户端补齐 SSRF、重定向与响应体上限防护；XLSX 解压炸弹、PDF 行分组的 O(n²) 与栈溢出、无界扇出与无界事件读取全部收口；任务租约新增 `fail()`/`reapExpired()`，迁移引入校验和防漂移。检索在全部 retriever 或授权后端失效时返回 503 而不是空的 200。首次加入 CI，并且集成测试被跳过会判为失败。详见[加固说明](./docs/hardening-m5.33.md)、[ADR 0047](./docs/adr/0047-legacy-prototype-isolation.md)。

M5.32 adds governed custom OpenAI-compatible relays through `FIREFLY_MODEL_PROVIDERS`. Relay models join the same pi-ai catalog and reuse FireFly routing, budgets, snapshots and audit records; remote endpoints require HTTPS, while localhost HTTP requires explicit opt-in. See [ADR 0045](./docs/adr/0045-governed-custom-model-relays.md) and the [model integration guide](./docs/model-provider-integration.md).

性能量化（PowerShell，需专用 `questlab_perf` 库，脚本对非 perf 库 fail closed）：

```powershell
docker exec firefly-questlab-min-postgres-1 psql -U questlab -d postgres `
  -c "DROP DATABASE IF EXISTS questlab_perf;" -c "CREATE DATABASE questlab_perf OWNER questlab;"
docker exec firefly-questlab-min-postgres-1 psql -U questlab -d questlab_perf -c "CREATE EXTENSION IF NOT EXISTS vector;"
$env:DATABASE_URL = "postgresql://questlab:questlab@127.0.0.1:55433/questlab_perf"
node packages/persistence/src/migrate.ts
Get-Content scripts/perf-seed.sql | docker exec -i firefly-questlab-min-postgres-1 `
  psql -U questlab -d questlab_perf -v docs=2000 -v chunks=5 -v ON_ERROR_STOP=1 -f -
node scripts/perf-retrieval.mjs --iterations 60 --label 10k
node scripts/perf-agent-loop.mjs --iterations 16 --concurrency 1,4,8
```

带标注语料的质量评测（需要真实 Embedding 与生成端点，PowerShell）：

```powershell
# 建独立评测库，避免污染主库；.eval.env 的 DATABASE_URL 指向 questlab_eval
docker exec firefly-questlab-remote-postgres-1 psql -U questlab -d postgres -c "CREATE DATABASE questlab_eval OWNER questlab;"
node --env-file=.eval.env packages/persistence/src/migrate.ts
node --env-file=.eval.env scripts/eval-seed.mjs --depth 240 --run d240 --batch 32 --embed-concurrency 2
node --env-file=.eval.env scripts/eval-rag.mjs --repeats 4 --cutoffs 1,3,5,10,20 > eval-rag.json
node --env-file=.eval.env scripts/eval-halfvec.mjs --queries 32 --k 10 > eval-halfvec.json
node --env-file=.eval.env scripts/eval-answer.mjs --queries 32 > eval-answer.json
node --env-file=.eval.env scripts/eval-agent.mjs --rounds 60 --concurrency 1,4,8,12 --min-calls-per-level 100 > eval-agent.json
```

实测结论见[量化评测报告](./docs/evaluation-report.md)。30720 chunk 语料、真实远程模型下发现并修复了 6 个缺陷，其中 5 个只有在真实规模或真实模型下才会暴露：

1. `selectEvidence` 的收益递减判据**方向写反了**：`(prev - score) / prev < floor` 的含义是「下一条没有明显更差就停止」，而「没有明显更差」恰恰意味着这条候选和上一条一样好、应该继续取。两种分数尺度都会踩中——RRF 在两个检索器一致命中同一文档时分数完全并列（实测输入序列 `1.0000, 1.0000, 0.9839, ...`，差值为 0，低于任何正阈值），reranker 在近重复候选上返回平台期（相邻差值 0.00001~0.0024）。而真正的断崖不会看错：`agreement` 从 2 降到 1 处的差值是 0.3896~0.4639，是平台期噪声的 25 倍。判据改为 `>=` 并把 7 个 intent 的阈值重标定到两个区间之间后，11 个场景全部改善：`exploratory-natural` Recall@10 0.453 → 0.938、证据 5.0 → 12.9，重排链路 nDCG@10 0.237 → 0.502、证据 2.0 → 6.0，`marginal_gain` 从主导停止原因（27/32）降到只在 2~4 条真实断崖上触发。
2. PostgreSQL `simple` 配置不切分中文，自然整句的词法检索 32/32 查询返回 0 条，混合检索静默退化为纯向量检索。迁移 018 新增字符 bigram 生成列（不依赖 `pg_bigm` / `zhparser` 等外部扩展），`lexical-only-natural` 的 MRR 0.000 → 0.875、nDCG@10 0.000 → 0.610。
3. RRF 平局时排序落到 `Map` 插入顺序，也就是检索器的声明顺序，词法的错误结果压过向量的正确结果。改为按「检索器一致度 → 最佳名次 → id」打破平局，顺序变为全序且可复现。
4. 单个跨词边界的 bigram 巧合（`热斑是怎么形成的` 与 `形成性评估` 共享 `形成`）足以让词法返回 10 条全错文档。要求 CJK 侧至少命中 2 个 bigram 后，`hybrid-natural` MRR 恢复到 1.000（该缺陷修复时 `exploratory-natural` nDCG@10 为 0.419 → 0.497；判据方向修复后同一场景已达 0.773）。
5. `fail()` 要求租约未过期，而慢失败恰恰是租约已耗尽的场景：一次挂了 561 秒的模型调用之后任务停在 `leased` 且 `last_error` 为空，失败原因彻底丢失。改为只校验所有权。
6. `readBoundedJson` 的 reader 循环只有 `finally` 没有 `catch`，响应体读取阶段的超时以原始 `DOMException` 逃逸出 Model Gateway，调用方拿不到 `TIMEOUT` 码与 `retryable` 标志、账本也记不到。

Agent 侧顺序 60 轮 100% 成功、120 次模型调用 p99 3316ms（n=120，p99 可信）；并发 1→12 每档累计 100~120 次调用（p99 全部可信）、全部 100% 成功，零重试，并发 12 下未出现越权领取。

本轮另做了两项**保持质量不变**的性能优化（11 个场景的证据数/nDCG/Recall/MRR 与优化前逐位相同）：

- **授权复查由逐条往返改为单条批量语句**。原先融合后每个候选一次 ACL 查询，24 个候选实测 54.7ms（单次 1.6ms），约占 `fact_lookup` 端到端 33%；改为 `unnest` 批量语句后 3.5ms，放行结果完全一致。`canReadAll` 是**可选**扩展点，缺失时回落原逻辑；契约是「返回被放行的集合」，所以任何遗漏都表现为拒绝而非放行，批量语句抛错时整批记为授权失败并回落串行。这同时解释了此前报告里"无法解释的延迟随规模增长"：单次往返隔离测量看不出问题，但候选数随语料增长，每个候选一次独立往返把尾延迟逐次放大。30720 chunk 下 `hybrid-natural` p50 1111ms → **401ms**、p99 4829ms → **600ms**。
- **向量检索新增 `ann_recall_mode` 选项**。ACL 谓词跨表形成 `Join Filter`，使 ANN 索引完全无法生效（实测 30720 行全部物化后排序，4092ms）。把向量搜索移到基表先跑、再用 ACL 过滤其输出可让 HNSW 生效，但 chunk 级召回从 100% 降到 86.7%。因为有损，它是显式选项而**不是**默认值——13% 的召回损失必须由调用方知情决定。默认 `exact` 保持优化前行为。过程中三处推断被数据否证并记录在案：ef_search=512 的"100% 召回"其实是计划器放弃了索引改走顺序扫描；下推对 `exact` 反而更慢（476ms vs 442ms）；`halfvec` 距离在纯排序场景比 `vector` 慢 4.5 倍。

halfvec 相对 fp32 精确解的 chunk 级 recall@10 为 0.69，但拆开后 **HNSW 近似零损失**，差异全部来自 fp16 舍入且发生在距离实质相等的文档之间（实测 rank10/rank11 距离差 2.71e-4 < fp16 精度 4.88e-4），按标注 topic 口径一致率 0.875，而 fp32 精确解要慢 60 倍。另外 `score_floor` 在全部 11 个场景中一次未触发，这条路径仍缺实测覆盖。

实测结论见[性能基线](./docs/performance-baseline.md)。三 Agent 闭环曾因 `executeTask` 用 `claimNext` 按 `subject` 认领、而 `subject` 不含 run 维度，导致并发 run 互相抢任务（新增 `claimById` 后并发 4/8 失败率 75%/100% → 0%，吞吐 4.04 → 20.18 run/s）。另有一条旧结论已更正：向量检索慢 5 倍的原因是**每行 2048 维 fp32→fp16 的 `halfvec` 转换**，不是 `MATERIALIZED` CTE 物化——四组合隔离测量显示 CTE 只值 9ms（109ms vs 100ms），而换成 `halfvec` 距离是 100ms → 453ms。

PostgreSQL 集成检查（PowerShell）：

```powershell
docker compose -p firefly-questlab-dev -f infra/compose/questlab-dev.yml up -d
$env:DATABASE_URL = "postgresql://questlab:questlab@127.0.0.1:55432/questlab"
npm run db:migrate
$env:TEST_DATABASE_URL = $env:DATABASE_URL
$env:TEST_S3_ENDPOINT = "http://127.0.0.1:59000"
$env:TEST_S3_ACCESS_KEY = "minioadmin"
$env:TEST_S3_SECRET_KEY = "minioadmin"
$env:TEST_SANDBOX_IMAGE = "node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43"
npm run test:integration
$env:ADMIN_API_TOKEN = "at-least-16-characters"
npm run admin:start
docker compose -p firefly-questlab-dev -f infra/compose/questlab-dev.yml down
```

低资源电脑优先使用：

```powershell
npm run lite:up
Invoke-RestMethod http://127.0.0.1:53200/health
npm run demo:start -- --run-id run.local.001
npm run demo:approve -- --run-id run.local.001 --approver local.user --reason "reviewed locally"
npm run lite:down
```

`lite:down` 保留 PostgreSQL 命名卷；完整开发栈只在需要验证 MinIO、索引/删除 Worker 或 Sandbox 时启动。

资源更紧或需要离线启动时使用最小降级档。它只启动 PostgreSQL 容器，迁移、三 Agent 闭环、Retrieval API 与 Admin API 都是宿主 Node 进程，不构建镜像；端口 `55433 / 53201 / 3101` 只绑定 `127.0.0.1`，Compose project 与数据卷都与 lite / dev 档独立，可以并存：

```powershell
npm run min:up
npm run min:ps
npm run min:migrate
npm run min:demo:start -- --run-id run.min.001
npm run min:demo:approve -- --run-id run.min.001 --approver local.user --reason "reviewed locally"
npm run min:retrieval   # 另一个终端，健康检查 http://127.0.0.1:53201/health
npm run min:admin       # 另一个终端，轨迹 http://127.0.0.1:3101/admin/evolution-runs/run.min.001
npm run min:down
```

最小档默认关闭 MinIO、索引/删除 Worker、Sandbox、OCR/ASR、Embedding、Reranker 和真实模型调用，检索只宣告 PostgreSQL FTS；ACL、结构化事实、Loop Sentinel、Citation、预算和人工审批仍然严格。详见[本地最小降级运行说明](./docs/local-min-profile.md)。

The development Compose stack also builds and starts the database migration job, Retrieval API and non-activating index Worker. The Retrieval health endpoint is published at `http://127.0.0.1:53200/health`. `RETRIEVAL_API_TOKEN` and `RETRIEVAL_IDENTITY_HMAC_SECRET` have no defaults: the lite and development stacks refuse to resolve without them, and `53200` is published on `127.0.0.1` only. The identity HMAC secret is the whole cross-tenant trust anchor, so a committed default would let anyone on the LAN mint a valid identity for any tenant. Optional vector search uses the M5.22 `EMBEDDING_*` configuration; optional reranking uses the M5.27 `RERANK_*` configuration.

The default stack also runs the S3/MinIO object-deletion consumer. To run one external deletion target, set `MEMORY_DELETION_TARGET`, `MEMORY_DELETION_ENDPOINT` and optionally `MEMORY_DELETION_PROVIDER_TOKEN`, then enable the `external-deletion` Compose profile. Deploy a separate process per external target in production so targeted Outbox leases and failure domains remain isolated.

The development Compose index Worker explicitly uses `MEMORY_INDEX_READY_GATE_MODE=structural` and never auto-activates. Production should omit that override, mount one immutable evaluation-set JSON file, set its absolute container path in `MEMORY_INDEX_EVALUATION_SET_FILE`, and run a separate Worker for each tenant/logical-index evaluation corpus.

M5.8 结构化 Chunker 已落地：`PdfLayoutChunker` 保留 page/bbox/heading/region，`CodeAstChunker` 保留 language/symbol/AST/line，`TableStructureChunker` 保留 sheet/table/header/row/column；默认在缺失 parser output 时 fail closed，也支持显式 `fallback_mode=degraded` 的纯文本降级并标记 Citation Locator。架构图新增第 24 页，决策记录见 [ADR 0021](./docs/adr/0021-structured-document-chunkers.md)。

M5.9 已落地 `ConversationTurnChunker`：保留轮次、说话人、角色和时间定位，Parent 使用连续对话窗口，Child 优先按轮次召回；解析器不可用时同样只能显式降级并留下可审计标记。

Parser 接入已抽象为 `ParserBackedIndexSourcePort`：可按 `source_type` 插拔本地、远程或模型解析器；严格模式阻断缺失/失败/非法输出，显式降级模式保留原文并传递 parser 诊断码。详见 [ADR 0023](./docs/adr/0023-parser-backed-source-port.md)。

降级索引不会自动进入生产：`allow_degraded_build` 与 `allow_degraded_activation` 必须分别显式开启，默认均关闭。详见 [ADR 0024](./docs/adr/0024-degraded-index-activation-policy.md)。

Admin API 默认只监听 `http://127.0.0.1:3100`，并且必须配置 `ADMIN_API_TOKEN`（≥16 字符）才会启动；除 `GET /health` 外所有路由都要求 `Authorization: Bearer`，比较使用 `crypto.timingSafeEqual`。仅在本机回环场景下可以用 `ADMIN_ALLOW_UNAUTHENTICATED=true` 显式放开。运行轨迹入口为 `GET /admin/evolution-runs/{run_id}`，响应同时包含因果边、预算、哨兵、PluginRelease、Sandbox、Canary 与当前活动 PluginVersion，并在单个 `REPEATABLE READ` 快照内读取，因此 21 条查询不会拼出运行从未处于过的混合状态。该 Compose 环境使用 `tmpfs`，仅用于本地集成测试；执行 `down` 后测试数据不会保留。

删除 reconciliation 独立进程至少需要 `DATABASE_URL`，可选配置为 `MEMORY_RECONCILIATION_SCHEDULER_ID`、`MEMORY_RECONCILIATION_INSTANCE_ID`、`MEMORY_RECONCILIATION_INTERVAL_MS`、`MEMORY_RECONCILIATION_STALE_AFTER_MS` 和 `MEMORY_RECONCILIATION_BATCH_SIZE`。启动命令为 `npm run memory:reconcile`；SIGINT/SIGTERM 会在当前周期结束后停止并关闭数据库连接。

retired 索引回收进程同样需要 `DATABASE_URL`，可选配置为 `MEMORY_INDEX_GC_COLLECTOR_ID`、`MEMORY_INDEX_GC_INSTANCE_ID`、`MEMORY_INDEX_GC_INTERVAL_MS`、`MEMORY_INDEX_GC_RETENTION_MS` 和 `MEMORY_INDEX_GC_BATCH_SIZE`。启动命令为 `npm run memory:index-gc`；默认保留期为 7 天，生产值应按回滚、审计和合规要求显式配置。

M5 的运行时决策依次记录在 [ADR 0008](./docs/adr/0008-model-invocation-projection.md)、[ADR 0009](./docs/adr/0009-memory-acl-and-structured-aggregation.md)、[ADR 0010](./docs/adr/0010-governed-retrieval-gateway.md)、[ADR 0011](./docs/adr/0011-versioned-retrieval-contracts.md)、[ADR 0012](./docs/adr/0012-postgresql-hybrid-retrieval-and-deletion.md)、[ADR 0013](./docs/adr/0013-versioned-index-activation-and-deletion-ack.md)、[ADR 0014](./docs/adr/0014-durable-index-and-deletion-workers.md)、[ADR 0015](./docs/adr/0015-auditable-index-quality-gate.md)、[ADR 0016](./docs/adr/0016-parent-child-retrieval-expansion.md)、[ADR 0017](./docs/adr/0017-fixed-building-index-evaluation.md)、[ADR 0018](./docs/adr/0018-deletion-reconciliation-scheduler.md)、[ADR 0019](./docs/adr/0019-retired-index-retention-garbage-collection.md) 和 [ADR 0020](./docs/adr/0020-vector-hybrid-fixed-index-evaluation.md)。
