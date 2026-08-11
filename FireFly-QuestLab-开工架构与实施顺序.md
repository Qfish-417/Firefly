# FireFly QuestLab 开工架构与实施顺序

> 状态：v3 开工基线，2026-08-05。本文是进入编码阶段的唯一导航；产品语义见产品设计，RAG 和工具细节见专项文档，整体关系见 `FireFly-QuestLab-目标架构-v3.drawio`。

## 1. 开工结论

FireFly QuestLab 应从“模块化单体 + 异步 Worker”开始，而不是先部署三个微服务。三个 Agent 是三个稳定的能力与权限边界，不等于三个必须独立运行的进程。

这不是完全去中心化架构，而是**联邦式执行架构**：Agent 可以拆分、独立部署和独立扩缩容，但策略、预算、审批、因果审计与工作流事实必须集中治理。这样既保留 Agent 的自治能力，也避免多个 Agent 通过相互委派形成不可审计的自循环。

推荐主体：

```text
TypeScript monorepo
├─ Web / Admin Console
├─ Learning Runtime
├─ Control Plane
├─ Governance / Loop Sentinel
├─ Model Gateway（pi-ai 多模型适配）
├─ 三个 Agent Bundle
└─ Tool / Plugin / Memory 端口

PostgreSQL
├─ 业务事实与状态机
├─ Workflow / Task / Approval
├─ Outbox / Inbox
└─ pgvector（MVP 检索）

独立进程
├─ Sandbox Runner
├─ Replay / Evaluation Worker
└─ Python Analytics Worker（确有统计或科学计算需求时）
```

选择理由：

- `pi-ai` 位于 TypeScript Model Gateway，Agent 不绑定模型供应商。
- MVP 共享契约、事务和调试链路，避免过早承担三套部署与分布式一致性。
- Sandbox、Replay 和高风险工具从第一天进程隔离。
- Agent Bundle 只依赖端口和事件契约，后续可以原样拆为独立服务。
- 当前 Java/Python 教育电商代码保留为 `prototype-v0` 参考，不作为迁移底座。

## 2. 三 Agent 究竟如何协作

### 2.1 一句话规则

三个 Agent 不直接修改彼此内部状态，也不以自由文本聊天作为正式交接。`Control Plane` 创建任务、校验结果并推进状态；Agent 通过版本化任务、事实事件和制品引用协作。

### 2.2 职责与交付物

| Agent | 负责 | 接收 | 交付 | 无权执行 |
|---|---|---|---|---|
| Learning Director | 运营学习旅程和用户沟通 | Goal、Profile、Mastery、MissionState、策略 | MissionPlan、NextAction、Intervention、LearnerMessage | 改代码、改评测基线、批准上线 |
| Learning Scientist | 观察、聚合、诊断和复评 | LearningEvent、ArtifactRef、Assessment、版本暴露 | LearningFinding、EvidencePack、OutcomeEvaluation | 直接改学习状态、直接发布策略 |
| Experience Engineer | 实现批准后的软件或配置变更 | ApprovedImprovementPlan、Finding、目标快照、验证契约 | ChangeSet、PatchCommit、PluginDigest、GeneratedTests | 改门禁、改基线、批准或发布自身变更 |

控制面、Policy Engine、Reviewer、Sandbox、CI、Release 和 Rollback 是确定性平台能力，不是第四个 Agent。

### 2.3 四条通信通道

| 通道 | 表达的含义 | 适合内容 | 不适合内容 |
|---|---|---|---|
| Task | 希望某项能力执行动作 | `AnalyzeLearningOutcomeTask`、`BuildPluginChangeTask` | 已经发生的事实 |
| Event | 已经发生且不可改写的事实 | `LearningFindingCreated`、`PluginChangeVerified` | 命令、超大正文 |
| ArtifactRef | 大对象或不可变制品的引用 | 作品、证据包、Git Commit、报告、OCI Digest | 小状态、权限判断 |
| Sync API | 短时查询或无副作用校验 | 健康、能力查询、Schema 校验、流式用户回复 | 构建、审批等待、Canary |

### 2.4 唯一事实源

- PostgreSQL 中的业务状态和工作流状态是唯一事实源。
- 状态更新和 Outbox 写入处于同一数据库事务。
- Consumer 先写 Inbox，以 `event_id` 去重，再处理任务。
- MQ 只是投递加速层；缓存、向量库和 Agent 上下文都不是事实源。
- Agent 重启后从 Task、Checkpoint 和 ArtifactRef 恢复，不依赖历史对话。

### 2.5 完整协作链

```text
Learner / Learning Runtime
  -> LearningEvent + ArtifactRef

Control Plane
  -> AnalyzeLearningOutcomeTask

Learning Scientist
  -> LearningFinding + EvidencePack

Control Plane + Policy / Human
  -> ApprovedImprovementPlan

Experience Engineer
  -> ChangeSet + PatchCommit + GeneratedTests

Independent Gates
  -> VerificationReport

Control Plane + Release Policy
  -> PluginCanary

Learning Director / Learning Runtime
  -> 让授权对象使用候选插件，不改变评测标准

Learning Scientist
  -> LearningOutcome

Control Plane
  -> activate | rollback | needs_human
```

Learning Director 与 Experience Engineer 之间没有“请直接把插件改掉”的私聊调用。必须先由 Scientist 形成证据，再由控制面产生经批准的计划。

### 2.6 联邦治理与循环防护

Agent 的执行能力可以分布，但治理决定不能分散到 Agent 自身。每次受治理的 Task 都携带 `root_run_id`、父任务、跳数、任务指纹、策略快照和 epoch；Control Plane 只接受符合当前策略快照的任务。

三层防护：

| 层次 | 机制 | 处理的问题 |
|---|---|---|
| 规范层 | 版本化契约、禁止自委派、固定所有者与允许的状态迁移 | 在产生任务前减少非法协作 |
| 哨兵层 | Loop Sentinel、任务/迁移/重试预算、跳数限制、指纹去重、事件窗口 | 在运行时阻断重复、风暴和无限委派 |
| 事实层 | `causal_edge`、`run_budget_usage`、`sentinel_incident`、`quarantine` | 保留不可变证据，支持人工恢复、审计和策略调优 |

阻断策略不是一刀切：同一 epoch 的重复任务直接拒绝；自委派隔离违规 Agent；因果环、事件风暴、跳数或 Run 预算耗尽则隔离整个 Run 并转人工处理。解除隔离必须是显式治理操作，不能由触发隔离的 Agent 自行完成。

## 3. 必须先冻结的契约

编码前先冻结 JSON Schema v1：

1. `TaskEnvelope`
2. `EventEnvelope`
3. `ArtifactRef`
4. `AgentResult`
5. `LearningEvent`
6. `LearningFinding`
7. `ImprovementPlan`
8. `ChangeSet`
9. `VerificationReport`
10. `LearningOutcome`

统一信封至少包含：

```json
{
  "message_id": "msg_01",
  "message_type": "BuildPluginChangeTask",
  "schema_version": 1,
  "correlation_id": "evolution_01",
  "causation_id": "evt_08",
  "trace_id": "trace_01",
  "producer": "control-plane",
  "subject": "experience-engineer",
  "idempotency_key": "build:plan_01:solar-energy@1.2.0",
  "deadline": "2026-08-05T12:00:00Z",
  "artifact_refs": [],
  "governance": {
    "root_run_id": "evolution_01",
    "parent_task_id": "task_07",
    "hop_count": 3,
    "max_hops": 8,
    "task_fingerprint": "sha256:...",
    "policy_snapshot": "governance.default.v1",
    "epoch": 1,
    "cooldown_key": "solar-energy:improvement"
  },
  "payload": {}
}
```

契约规则：

- Schema 只向后兼容演进；破坏性变化增加主版本。
- 每个 Task 声明租约、取消令牌、重试策略和预算。
- 受治理 Task 的父子深度必须连续；同一 Agent 不得成为直接父子任务的双方。
- `task_fingerprint` 由 Task 类型、目标 Agent、规范化 payload 和 ArtifactRef 计算，不能由 Agent 任意声明。
- 每个结果带输入快照版本、模型/Prompt/Tool Snapshot 和证据谱系。
- 大内容不塞入消息，只传 `ArtifactRef + digest + media_type + ACL`。
- Agent 输出先做 Schema 和权限校验，再进入业务状态机。

## 4. 目标模块边界

| Bounded Context | 拥有的数据 | 对外能力 |
|---|---|---|
| Identity & Consent | User、Tenant、Role、Consent、Retention | 鉴权、范围与删除策略 |
| Learning Runtime | World、Mission、Attempt、Assessment、Mastery | 确定性学习状态机 |
| Agent Control Plane | Run、Task、Lease、Checkpoint、Approval | 调度、恢复、状态推进 |
| Knowledge & Memory | MemoryItem、IndexEntry、Lineage、ACL | 写入、结构化、检索、压缩 |
| Tool Platform | ToolDescriptor、Lease、Operation | 发现、授权、同步/异步执行 |
| Plugin Platform | Manifest、Version、Digest、Release | 安装、沙箱、Canary、回滚 |
| Evaluation | Dataset、Invariant、Replay、Report | 独立门禁与效果比较 |
| Model Gateway | Provider、Route、Usage、PromptSnapshot | pi-ai 路由、流式、预算、审计 |

硬边界：

- Learning Runtime 接受 Agent 建议，但独立校验状态转换。
- Model Gateway 不执行工具副作用。
- Experience Engineer 只能写计划声明的 worktree 范围。
- Candidate 不能修改自己的 Rubric、Dataset、Policy 或 Approval。
- 用户私有、Agent 私有、租户和公共知识在检索前授权，不能检索后再过滤。

## 5. 建议仓库结构

```text
FireFly/
├─ apps/
│  ├─ web/
│  ├─ api/
│  └─ worker/
├─ packages/
│  ├─ contracts/
│  ├─ learning-domain/
│  ├─ control-plane/
│  ├─ governance/
│  ├─ model-gateway/
│  ├─ agent-kernel/
│  ├─ tool-platform/
│  ├─ memory-platform/
│  ├─ plugin-platform/
│  ├─ plugin-sdk/
│  └─ evaluation/
├─ agents/
│  ├─ learning-director/
│  ├─ learning-scientist/
│  └─ experience-engineer/
├─ plugins/
│  └─ solar-energy/
├─ evaluation/
│  ├─ datasets/
│  ├─ invariants/
│  └─ replay/
├─ infra/
│  ├─ migrations/
│  └─ compose/
├─ docs/
└─ legacy/
   └─ prototype-v0/
```

第一阶段不要先拆 `director/scientist/engineer` 三个网络服务。每个 Agent 包暴露同一个 `AgentWorker` 接口，通过进程内适配器消费任务；独立部署时只替换 Transport Adapter。

## 6. 数据库与实现顺序

### Step 0：仓库基线（已完成）

- 当前目录已经初始化为 Git 仓库并关联 `Qfish-417/Firefly`。
- 旧原型只移动到 `legacy/prototype-v0`，不删除。
- 建立 ADR、格式化、Lint、Test 和迁移约定。

### Step 1：契约与状态机

- 建 `packages/contracts` 和 JSON Schema 测试。
- 实现 Journey、Mission、PluginRelease、EvolutionRun 状态机。
- 用纯函数测试合法转换、非法转换和幂等重放。

### Step 2：PostgreSQL 事实层

按顺序建立：

```text
learning_world / mission / attempt / evidence / assessment / mastery
evolution_run / workflow_task / task_checkpoint / approval
outbox_event / inbox_receipt
artifact / artifact_acl / lineage
plugin / plugin_version / plugin_release
learning_finding / improvement_plan / verification_report / learning_outcome
```

先用 PostgreSQL 和 pgvector；MVP 不要求 RocketMQ、Milvus、Elasticsearch、Nacos 同时启动。

### Step 3：人工纵向闭环

- 不接 LLM，使用固定输入跑通 `LearningEvent -> LearningOutcome`。
- 三 Agent 先作为可替换 Stub，验证任务租约、重试、取消和恢复。
- 所有状态和制品在 Admin API 可查询。

### Step 3.5：治理与 Loop Sentinel

- 给 Task / Event 增加可选治理上下文，保持 v1 契约向后兼容。
- 持久化父子 Task 因果边、Run 预算、哨兵事件、事件窗口与隔离状态。
- 在同一数据库事务中校验并消耗任务预算；状态迁移同样原子消耗迁移预算。
- 阻断跳数越界、同 epoch 重复指纹、自委派、因果环、事件风暴和重试越界。
- Admin Trace 同时返回因果边、预算用量、哨兵事件和隔离记录。

### Step 4：太阳能插件与独立门禁（已完成）

- 建 `solar-energy@1.2.0` 缺陷版本和 `1.3.0` 候选版本。
- 固定物理不变量、Rubric 不变性、可访问性和历史 Replay。
- 实现 worktree、Sandbox、Digest、Canary 和真实回滚。

实际实现约束：

- `GitWorktreeBuilder` 只写 ImprovementPlan 明确批准且位于目标插件根目录内的路径，拒绝重复路径、路径逃逸和符号链接。
- 基线制品 Digest 必须与 `base_ref` 内容一致；文本制品统一 LF 后计算稳定 Digest。
- 变更生成真实 Git Commit，并保存在 `refs/firefly/changes/*` 审计引用中。
- Docker Sandbox 镜像必须固定 SHA-256 Digest，使用无网络、只读根文件系统、只读 worktree、capability 清空、`no-new-privileges`、PID/内存/CPU/超时限制。
- 物理不变量、Assessment 契约不变性、可访问性和历史 Replay 全部通过后，才能请求独立 PluginRelease 审批。
- Canary 只解析给显式 allowlist 或 subject prefix 内的合成/内部对象；未授权对象即使百分比为 100 也继续使用基线 Digest。
- 激活候选和回滚基线都在 PluginRelease 状态迁移事务中原子更新活动版本指针并写 Outbox。
- Control Plane 的 `PluginReleaseWorkflow` 是正式用例入口，负责构建验证、等待发布审批、解析 Canary 和按最新评估完成激活/回滚；测试不直接拼接发布状态。

### Step 5：Model Gateway 与 Agent（已完成）

- `packages/model-gateway` 已接入维护中的 `@earendil-works/pi-ai@0.83.0`，提供 generate/stream 与独立 embed/rerank 端口；后两者不伪装成 pi-ai 原生能力。
- 已实现 workload 主备路由、Gateway 级重试、超时、取消、Token/成本预检与后检，以及 Model/Routing/Prompt/Tool/Knowledge Snapshot。
- Learning Scientist 已使用模型解释授权证据，Learning Director 已使用模型生成固定五阶段内的指导；可信代码绑定身份、证据、插件曝光、阶段顺序和 Canary 决策。
- 模型不接收工具，任何 tool call 都被拒绝；流式调用只允许在输出首个 delta 前切换 Provider。
- Experience Engineer 已通过 `IsolatedPluginEngineeringTool` 接入：授权源码读取、PatchProposal、Git worktree、真实 Commit、Sandbox 和 cleanup 位于同一受控生命周期；模型不能声明 Commit、Digest、门禁结果或发布决策。
- Control Plane 持久化真实 VerificationReport；失败进入 `verification_failed`，通过且存在证据才进入 Canary。PluginRelease 直接消费已验证候选，不重复构建，并继续等待独立发布审批。

### Step 6：RAG、记忆与工具动态化

M5 starts with the model invocation projection (`questlab.model_invocation`) so model budget, retry and provider health are observable before enabling durable memory writes. See [ADR 0008](./docs/adr/0008-model-invocation-projection.md).

- 已完成授权记忆事实层、确定性聚合、动态 TopK、版本化 EvidencePack、PostgreSQL FTS/pgvector 混合检索和双重 ACL。
- 已完成版本化索引构建合同、Chunk 版本绑定、单 active 原子切换，以及外部删除逐目标任务/Ack 和全局完成判定。
- 已完成租约式索引构建 Worker、确定性分块、Embedding 维度校验、基础 Ready Gate 与崩溃恢复；已通过官方 AWS S3 SDK 跑通真实 MinIO 删除、退避重试、attempt 耗尽终态和 failed 目标 reconciliation。
- 已完成可持久化 `IndexQualityReport` 和高级 Ready Gate 框架，强制结构、来源水位、ACL、Recall、Citation 五项检查与不可变构建身份绑定；生产 ACL/Recall/Citation Probe 和评测集待接入。
- 已完成 Markdown Parent/Child 分块与授权扩展：Parent 无 Embedding，FTS/pgvector 只召回 Child；选证据后扩展 Parent，再校验 active 索引、租户和 Memory ACL，超预算回退 Child，共享 Parent 去重。
- 下一步接入生产质量 Probe/评测集，再补 reconciliation 定时调度和 retired 版本回收，扩展 PDF/代码/表格 Chunker，最后接生产 BM25/ANN。
- 之后做长期记忆压缩、多模态派生索引和动态工具发现。
- 动态加载只加载描述与受控 Provider，不把未知代码装入 Agent 主进程。

## 7. 第一个纵向切片

场景固定为“火星基地太阳能 Mission”：旧插件忽略昼夜变化，使学习者形成 `constant_solar_output` 错误概念。

首切必须证明：

1. Director 能运行 Mission 并记录插件暴露版本。
2. Scientist 能以确定性聚合加模型解释生成可复现 Finding。
3. 人工批准后，Engineer 只能在声明范围内生成 ChangeSet。
4. 独立门禁验证物理、评测、可访问性和 Replay。
5. Canary 只面向合成学习者或内部授权账号。
6. Scientist 比较掌握、保持、迁移和无伤害指标。
7. 达标激活 `1.3.0`；退化真实回滚 `1.2.0`。

暂不做支付、商城、全学科知识图谱、真实未成年人实验、生产核心自修改和多集群部署。

## 8. 里程碑与完成定义

| 里程碑 | 交付 | 验收 |
|---|---|---|
| M0 契约 | Schema、状态机、ADR | 合同测试与非法转换测试通过 |
| M1 事实层 | Postgres、Outbox/Inbox、Artifact | 重启可恢复，重复消息无重复副作用 |
| M2 人工闭环 | 三 Stub Agent、Admin 查询 | 一条因果链完整跑通 |
| M2.1 治理哨兵 | 规范、预算、因果图、Loop Sentinel、隔离 | 循环、风暴、自委派和预算耗尽均被确定性阻断 |
| M3 插件闭环（完成） | Worktree、Docker Sandbox、门禁、Canary、Rollback | 缺陷基线被拒绝；候选四门禁通过；故障注入恢复指定 Digest |
| M4 模型闭环（完成） | pi-ai Gateway、三个真实 Agent、Stub 后备、Engineer 隔离构建 | Provider 可替换；模型输出可追溯；真实 Commit、门禁失败和发布证据均受治理 |
| M5 记忆工具（进行中） | 授权检索、聚合、版本索引、质量报告、后台 Worker、删除 Ack、Parent/Child 扩展 | 索引构建/激活、五类质量门禁框架、Markdown Parent/Child 和 MinIO 删除恢复已通过；生产评测 Probe、其他结构化 Chunker、调度器、旧版 GC、BM25/ANN 与多模态待补齐 |

不满足以下条件，不称为“自闭环”：

- 真实业务指标可测，不用模型自评替代。
- Agent 结果不直接越过状态机和门禁。
- 失败、超时、重复投递和进程重启可恢复。
- 候选版本不能修改自身验收标准。
- 发布与回滚不依赖 Experience Engineer 在线。

## 9. Git 与 GitHub 权限

### 9.1 当前状态

- 当前目录已经是 Git 仓库，远端 `origin` 指向 `https://github.com/Qfish-417/Firefly.git`。
- M0、M1、M2、M2.1、M3、M4 及当前 M5 增量均在 `feat/m4-pi-ai-model-gateway` 持续形成可审查提交并推送到远端。
- HTTPS Git 凭据已能完成分支推送；当前实现和测试不依赖 GitHub API。

### 9.2 本地写代码是否需要 GitHub

不需要。创建目录、编写代码、运行测试、Commit 和本地 worktree 都不需要 GitHub API 密钥。当前远端使用 Git HTTPS 凭据进行推送，不应把 Personal Access Token 或其他密钥写进对话、代码、日志或仓库。

### 9.3 什么时候需要 GitHub

| 动作 | 最小需求 |
|---|---|
| 创建远端仓库 | 个人账号建仓权限，或组织 `Create repository` 权限 |
| 推送分支 | Repository Contents: Read/Write |
| 创建和更新 PR | Pull requests: Read/Write |
| 查看 CI | Actions: Read |
| 修改 workflow | Contents: Write，并允许修改 `.github/workflows` |
| 推送 OCI/Package | Packages: Read/Write |
| 配置 Secrets / Environments | 对应仓库或环境的管理权限，仅部署阶段需要 |
| 配置 Branch Protection | Administration: Write，仅治理阶段需要 |

不建议一开始申请组织管理员权限。首个远端阶段只需：仓库访问、分支推送、PR 读写和 Actions 只读；需要配置 CI、Secrets 或分支保护时再单独授权。

### 9.4 后续远端操作原则

1. 普通 Commit、分支和 Push 沿用当前 Git 凭据，不需要额外 API 密钥。
2. 创建 PR 可由用户打开 GitHub 提示链接，或后续安装并登录 `gh`；只有自动创建 PR 时才需要相应授权。
3. Actions、Secrets、Environments 和 Branch Protection 在实际使用前分别确认，不默认扩大权限。
4. 任何凭据只进入本机凭据管理器或 GitHub Secret，不进入 `.env` 示例、测试夹具和 Agent 记忆。

## 10. 文档事实源

| 问题 | 文档 |
|---|---|
| 产品与业务对象 | `FireFly-QuestLab产品与三Agent详细设计.md` |
| 三 Agent 通信与开工顺序 | 本文 |
| 总体架构图 | `FireFly-QuestLab-目标架构-v3.drawio` |
| RAG、记忆、检索、多模态、安全 | `FireFly-RAG与记忆系统设计.md` |
| 工具分类、发现、异步、动态加载、KV Cache | `FireFly-工具系统设计.md` |
| Model Gateway、模型路由、预算、Agent 接入 | `FireFly-Model-Gateway构建设计.md` |
| 旧架构推演 | `FireFly-开放式架构分析.md` |

发生冲突时，按“本文 -> v3 主图 -> 专项文档 -> 旧推演”的顺序解释；代码契约最终以 `packages/contracts` 中已版本化 Schema 为准。
