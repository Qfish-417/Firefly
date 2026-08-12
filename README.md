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
2. [v3 目标架构图](./FireFly-QuestLab-目标架构-v3.drawio)：23 页分层主图，包含联邦治理、循环防护、Model Gateway、RAG、索引切换、后台 Worker、Parent/Child 扩展、固定索引质量评测、删除修复调度、retired 索引回收与 vector/hybrid 评测视图。
3. [产品与三 Agent 详细设计](./FireFly-QuestLab产品与三Agent详细设计.md)：产品、领域对象、状态机和太阳能纵向切片。
4. [RAG 与记忆系统设计](./FireFly-RAG与记忆系统设计.md)：聚合检索、记忆分层、压缩、多模态与安全。
5. [工具系统设计](./FireFly-工具系统设计.md)：五类工具、发现、异步、动态加载和 KV Cache。
6. [开放式架构分析](./FireFly-开放式架构分析.md)：早期问题分析与决策背景。
7. [目标架构构建文档](./FireFly-目标架构构建文档.md)：更详细的阶段性建设要求。
8. [Model Gateway 构建设计](./FireFly-Model-Gateway构建设计.md)：M4 代码边界、配置、失败语义和真实 Engineer 工程生命周期。

`FireFly-开放式目标架构.drawio` 是旧的 11 页分析图，内容较密且存在重复；保留作历史参考，不再作为主图。`FireFly-Agent设计.drawio` 和 `FireFly-Agent设计说明.md` 均属于 Legacy Prototype v0。

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
- M5.3 Parent/Child 检索扩展已落地：Markdown 按标题层级生成无 Embedding 的 Parent Section 与可召回 Child Chunk；FTS/pgvector 只召回 Child，选证据后再扩展共享 Parent，并重新校验 active 索引、租户和 Memory ACL。Parent 超过剩余 Token 预算时保留 Child，跨 Memory/索引版本父引用和扩展越权均 fail closed。PDF、代码与表格的结构化 Chunker 已在 M5.8 补齐，`ParserBackedIndexSourcePort` 已完成严格/降级边界；M5.13 新增受治理 HTTP Parser Adapter，M5.14-M5.17 已接入 TypeScript/JavaScript AST、CSV 单表、版本化转录 JSON 以及受 digest 核验的 PDF.js Parser，OCR、XLSX 和真实 ASR/说话人分离引擎仍待接入。
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
npm run admin:start
docker compose -p firefly-questlab-dev -f infra/compose/questlab-dev.yml down
```

M5.8 结构化 Chunker 已落地：`PdfLayoutChunker` 保留 page/bbox/heading/region，`CodeAstChunker` 保留 language/symbol/AST/line，`TableStructureChunker` 保留 sheet/table/header/row/column；默认在缺失 parser output 时 fail closed，也支持显式 `fallback_mode=degraded` 的纯文本降级并标记 Citation Locator。架构图新增第 24 页，决策记录见 [ADR 0021](./docs/adr/0021-structured-document-chunkers.md)。

M5.9 已落地 `ConversationTurnChunker`：保留轮次、说话人、角色和时间定位，Parent 使用连续对话窗口，Child 优先按轮次召回；解析器不可用时同样只能显式降级并留下可审计标记。

Parser 接入已抽象为 `ParserBackedIndexSourcePort`：可按 `source_type` 插拔本地、远程或模型解析器；严格模式阻断缺失/失败/非法输出，显式降级模式保留原文并传递 parser 诊断码。详见 [ADR 0023](./docs/adr/0023-parser-backed-source-port.md)。

降级索引不会自动进入生产：`allow_degraded_build` 与 `allow_degraded_activation` 必须分别显式开启，默认均关闭。详见 [ADR 0024](./docs/adr/0024-degraded-index-activation-policy.md)。

Admin API 默认只监听 `http://127.0.0.1:3100`，运行轨迹入口为 `GET /admin/evolution-runs/{run_id}`，响应同时包含因果边、预算、哨兵、PluginRelease、Sandbox、Canary 与当前活动 PluginVersion。该 Compose 环境使用 `tmpfs`，仅用于本地集成测试；执行 `down` 后测试数据不会保留。

删除 reconciliation 独立进程至少需要 `DATABASE_URL`，可选配置为 `MEMORY_RECONCILIATION_SCHEDULER_ID`、`MEMORY_RECONCILIATION_INSTANCE_ID`、`MEMORY_RECONCILIATION_INTERVAL_MS`、`MEMORY_RECONCILIATION_STALE_AFTER_MS` 和 `MEMORY_RECONCILIATION_BATCH_SIZE`。启动命令为 `npm run memory:reconcile`；SIGINT/SIGTERM 会在当前周期结束后停止并关闭数据库连接。

retired 索引回收进程同样需要 `DATABASE_URL`，可选配置为 `MEMORY_INDEX_GC_COLLECTOR_ID`、`MEMORY_INDEX_GC_INSTANCE_ID`、`MEMORY_INDEX_GC_INTERVAL_MS`、`MEMORY_INDEX_GC_RETENTION_MS` 和 `MEMORY_INDEX_GC_BATCH_SIZE`。启动命令为 `npm run memory:index-gc`；默认保留期为 7 天，生产值应按回滚、审计和合规要求显式配置。

M5 的运行时决策依次记录在 [ADR 0008](./docs/adr/0008-model-invocation-projection.md)、[ADR 0009](./docs/adr/0009-memory-acl-and-structured-aggregation.md)、[ADR 0010](./docs/adr/0010-governed-retrieval-gateway.md)、[ADR 0011](./docs/adr/0011-versioned-retrieval-contracts.md)、[ADR 0012](./docs/adr/0012-postgresql-hybrid-retrieval-and-deletion.md)、[ADR 0013](./docs/adr/0013-versioned-index-activation-and-deletion-ack.md)、[ADR 0014](./docs/adr/0014-durable-index-and-deletion-workers.md)、[ADR 0015](./docs/adr/0015-auditable-index-quality-gate.md)、[ADR 0016](./docs/adr/0016-parent-child-retrieval-expansion.md)、[ADR 0017](./docs/adr/0017-fixed-building-index-evaluation.md)、[ADR 0018](./docs/adr/0018-deletion-reconciliation-scheduler.md)、[ADR 0019](./docs/adr/0019-retired-index-retention-garbage-collection.md) 和 [ADR 0020](./docs/adr/0020-vector-hybrid-fixed-index-evaluation.md)。
