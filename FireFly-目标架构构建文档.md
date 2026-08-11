# FireFly QuestLab 目标架构构建文档

> 目标：从零建设 QuestLab，使 Learning Director、Learning Scientist、Experience Engineer 能围绕真实学习效果形成受控自进化闭环。编码顺序与通信契约以 [开工架构与实施顺序](./FireFly-QuestLab-开工架构与实施顺序.md) 为准，产品语义见 [FireFly-QuestLab产品与三Agent详细设计.md](./FireFly-QuestLab产品与三Agent详细设计.md)。

专项设计：[RAG 与记忆系统](./FireFly-RAG与记忆系统设计.md)；[工具系统](./FireFly-工具系统设计.md)。

## 1. 构建原则

1. **先纵向闭环，后横向铺开**：先让“火星基地能源 Mission”完成教学、观察、插件改进和复评，再扩展学科与世界模板。
2. **先可观察，后自动修改**：没有可信评测与回滚之前，Agent 只能提出建议。
3. **先逻辑拆分，后物理拆分**：先建立能力接口，再决定是否独立部署。
4. **事实状态只有一份**：工作流数据库是事实源；MQ、缓存和 RAG 都不是事实源。
5. **所有副作用都可重试**：工具必须接收幂等键，并输出可审计结果。
6. **模型输出默认不可信**：先做 Schema 校验，再做确定性验证。

## 2. 建议代码结构

```text
FireFly/
├─ apps/
│  ├─ control-plane/          # 工作流、状态机、策略、审批、Agent Registry
│  ├─ model-gateway/          # TypeScript + pi-ai，多模型路由与审计
│  ├─ learning-runtime/       # Mission/Attempt/Assessment 确定性状态机
│  ├─ web/                    # 学习者、教师与管理员界面
│  └─ admin-console/          # Finding、证据、审批、Canary、回滚
├─ agents/
│  ├─ learning-director/      # 学习旅程、Mission 决策、用户沟通
│  ├─ learning-scientist/     # 学习观察、诊断、评估
│  ├─ experience-engineer/    # 插件、流程、RAG 和代码变更
│  └─ workers/                # 将来独立扩缩容的能力实现
├─ runtime/
│  └─ questlab/               # 学习世界、Mission、Attempt、Evidence、Mastery
├─ contracts/
│  ├─ json-schema/            # Task、Event、Artifact、Agent Capability
│  ├─ openapi/                # 同步管理与查询接口
│  ├─ asyncapi/               # 领域事件和任务消息
│  └─ proto/                  # 确有低延迟需求时使用
├─ packages/
│  ├─ learning-domain/        # 领域实体、状态机与不变量
│  ├─ plugin-sdk/             # Manifest、沙箱和学习契约
│  ├─ agent-kernel/           # 身份、预算、取消、检查点、工具调用
│  └─ event-envelope/         # 各语言生成的事件类型
├─ platform/
│  ├─ workflow/               # Postgres 工作流，后期可接 Temporal
│  ├─ eventing/               # Outbox/Inbox、MQ、DLQ
│  ├─ artifacts/              # Git、对象存储、OCI Registry
│  ├─ observability/          # OpenTelemetry、Prometheus、日志
│  └─ sandbox/                # worktree、容器隔离、权限策略
├─ evaluation/
│  ├─ datasets/               # 固定评测集和版本
│  ├─ invariants/             # 学科、评测、隐私、公平性和状态机规则
│  ├─ replay/                 # 历史学习轨迹和合成学习者重放
│  └─ reports/
└─ deploy/
   ├─ compose/                # 本地最小部署
   └─ kubernetes/             # 需要规模化后再引入
```

当前代码不建议直接迁移。保留旧实现作为 `prototype-v0`，QuestLab 按上述边界建立干净仓库。

## 3. 核心契约先行

在继续实现工具前，先冻结第一版契约：

### 3.1 实体

- `EvolutionRun`：一次完整闭环，包含目标、预算、风险等级和当前阶段。
- `LearningObservation`：学习事件、作品、评测和插件暴露的证据引用。
- `LearningFinding`：错误概念、策略或插件问题、置信度和影响群体。
- `ImprovementPlan`：教学/软件候选方案、成功标准、风险和回滚计划。
- `ChangeSet`：插件版本、配置、Patch Commit、测试和制品摘要。
- `VerificationReport`：每个门禁结果与证据。
- `PluginRelease`：插件 Digest、配置快照、Canary 阶段和回滚点。
- `LearningOutcome`：掌握、保持、迁移、无伤害指标和经验可信度。

### 3.2 状态机

```text
observed
  -> diagnosed
  -> planned
  -> awaiting_approval
  -> executing
  -> verifying
  -> canary
  -> released
  -> learned

终止/异常：rejected | failed | rolled_back | canceled | needs_human
```

每个转换应声明：允许的来源状态、所需证据、执行主体、幂等键和补偿动作。

### 3.3 事件信封

必须包含 `event_id`、`event_type`、`schema_version`、`correlation_id`、`causation_id`、`trace_id`、`producer`、`idempotency_key`、`artifact_refs`、`payload`。

## 4. 分阶段建设路线

### Phase 0：最小纵向闭环

目标：不接真实 LLM，也能人工触发并完整走通一次闭环。

实现：

- PostgreSQL 中建立 `evolution_run`、步骤、Outbox、Inbox、审批和制品表。
- 控制面实现合法状态转换、重试、取消和人工暂停。
- 只选择一个场景：太阳能模拟器缺少昼夜变化，诱发 `constant_solar_output` 错误概念。
- Learning Scientist 读取固定学习轨迹，产生结构化 LearningFinding。
- Experience Engineer 读取预置 Plugin ChangeSet，在沙箱跑物理不变量和 Replay。
- 人工审批后执行模拟 Canary，再写 LearningOutcome。

验收：

- 任意服务重启后可从 checkpoint 继续。
- 重复投递同一事件不产生两次副作用。
- UI 或 API 能展示完整因果链和每一步制品。
- 可以人工取消，并停在可解释状态。

### Phase 1：Model Gateway 与真实观察

目标：接入真实模型和真实观测，但仍不允许自动修改生产。

实现：

- 建立 TypeScript Model Gateway，内部用 pi-ai 接 Provider。
- 支持结构化输出、流式响应、模型路由、Fallback、预算和审计。
- Java/Python 只调用统一网关，不保存 Provider Key。
- 接入 OpenTelemetry、Prometheus 和集中日志。
- 构建固定评测数据集和初始基线。
- Scout 产出 Finding 与 ChangePlan 建议，管理员只查看不执行。

验收：

- 可按任务路由至少两个不同模型或一个云模型加一个本地模型。
- Provider 故障时按策略降级，调用链完整可查。
- 所有 Finding 都能回溯到指标时间窗、日志或 Replay 证据。
- 模型成本和质量按 Agent、任务、Prompt 版本统计。

### Phase 2：A1 配置自动闭环

目标：开放低风险、可立即恢复的配置变更。

范围：Prompt、模型路由、RAG 参数、非业务语义配置。

实现：

- 配置存 Git 或版本化配置仓库，禁止直接覆盖当前活动版本。
- 每次变更生成 diff、验证报告和回滚版本。
- 离线评测通过后发布到影子环境，再小流量生效。
- 退化自动恢复上一配置版本。

验收：

- 自动制造错误 Prompt 后，系统能识别退化并恢复。
- 配置回滚不依赖 Agent 在线。
- 候选配置不能修改自己的评测阈值。

### Phase 3：A2 规则闭环

目标：允许变更受 Schema 约束的 DSL 和策略。

范围：Mission DSL、提示策略、模型路由、插件配置和已有教学策略的选择。

实现：

- 为 DSL 建 JSON Schema、语义校验器和兼容性规则。
- 使用历史流量 Replay，比较新旧规则决策。
- 影子执行只计算结果，不产生生产副作用。
- Policy Engine 根据影响面决定自动或人工放行。

验收：

- 非法规则在进入影子环境前被阻断。
- 能说明每条请求的新旧决策差异。
- 规则退化时在约定时间内自动回滚。

### Phase 4：A3 源码闭环

目标：在严格治理下允许 Agent 修改源码。

实现：

- 每个 ChangePlan 创建独立 worktree 和容器沙箱。
- Coder 只能写任务声明的文件范围。
- Verifier 使用独立身份，只读补丁，执行编译、测试、静态分析、依赖和安全扫描。
- 构建镜像使用不可变 Digest，并生成 SBOM 和签名。
- 数据库变更执行 expand/contract，不允许不可逆脚本直接上线。
- 人工审批的是完整证据包，而不是一段模型总结。
- 按 1%/5%/25%/100% 或业务实际流量分阶段发布。

验收：

- Patch Agent、Review Agent 和审批策略使用独立权限。
- 失败注入覆盖编译失败、测试失败、模型超时、MQ 重复、灰度退化和数据库不可用。
- 自动回滚经过真实演练，达到定义的 RTO。
- 审计能回答“谁因为什么证据，使用哪个模型和 Prompt，修改了什么，谁批准，最终结果如何”。

### Phase 5：能力拆分与规模化

目标：不修改业务协议，将三个 Bundle 按负载和权限拆成 Worker Pool。

实现：

- Agent Registry 保存能力、版本、健康、租约和并发能力。
- 控制面根据 `CapabilityDescriptor` 分配任务。
- Observer、Coder、Verifier、ReleaseManager 独立扩缩容。
- 引入租户隔离、配额、优先级、公平调度和成本路由。
- 长任务量达到阈值后评估迁移至 Temporal。

验收：

- 同一闭环可在三 Bundle 和拆分 Worker 两种拓扑运行。
- 替换某个 Worker 实现不改变上游协议。
- Worker 宕机后任务租约到期，可由另一个实例续跑。

## 5. 模型网关构建要求

### 5.1 接口

- `POST /v1/generate`：非流式结构化生成。
- `POST /v1/stream`：SSE 流式输出。
- `POST /v1/embed`：Embedding，可路由专用模型。
- `POST /v1/rerank`：Rerank，可独立部署。
- `GET /v1/models/capabilities`：返回能力矩阵，不暴露密钥。

### 5.2 路由维度

- 任务：代码、诊断、规划、审查、Judge、Embedding。
- 能力：结构化输出、Tool Calling、长上下文、视觉输入。
- 约束：质量、延迟、费用、隐私、数据地域和模型白名单。
- 稳定性：超时、并发、熔断、重试和 Fallback 链。

### 5.3 安全

- Provider Key 仅存在于网关 Secret Store。
- Prompt 和 Tool 输出做敏感信息检测。
- 生产数据默认不发往未批准 Provider。
- Tool Call 在 Agent 工具执行器中完成，模型网关不直接执行生产副作用。
- 保存审计元数据；原始 Prompt/Response 是否落盘按数据等级决定。

## 6. 通信与可靠性落地

### 6.1 MVP

建议先减少基础设施：

```text
PostgreSQL  = 状态 + Outbox + Inbox + 审批 + 经验元数据
Redis       = 可选的短期缓存和锁，不是事实源
Git         = 代码、配置、Prompt 版本
MinIO       = 报告、日志切片、Replay 数据、证据包
Prometheus  = 指标
```

RocketMQ、Milvus、Elasticsearch 可在闭环需要真实吞吐与检索质量时再接入。第一阶段不应为了“架构完整”而让所有组件同时成为前置条件。

### 6.2 事件可靠性

一次事务内：

1. 更新工作流状态。
2. 写入 Outbox 事件。
3. Dispatcher 发布到 MQ。
4. Consumer 先以 `event_id` 写 Inbox 去重，再执行处理。
5. 副作用工具使用 `idempotency_key`。

不追求传输层绝对 exactly-once；采用 at-least-once + 幂等实现业务一致性。

## 7. 评估体系

### 7.1 硬门禁

任一失败即阻断：

- 编译、单元测试、集成测试。
- 学科正确性、评测不变性、学习状态机和制品版本不变量。
- 安全、依赖、License 和 Schema 兼容性检查。
- 评测标准、审批策略或审计逻辑被候选变更修改。

### 7.2 软指标

- 可用性、p95/p99、吞吐和资源成本。
- 掌握、保持、迁移、提示依赖、放弃率和教师反馈。
- 模型质量、耗时、Token 和费用。
- Agent 成功率、重试次数、人工接管率和回滚率。

软指标使用多目标约束，不建议压成唯一综合分后直接决定上线。

### 7.3 对照方式

- 离线固定数据集。
- 历史事件 Replay。
- Shadow 双跑。
- Canary 对照组。
- 上线后持续观察窗口。

## 8. 第一个可演示闭环

首个场景固定为“火星基地太阳能 Mission”：

> 学习者通过太阳能模拟器学习功率、能量和面积；系统发现旧插件没有表现昼夜光照变化，导致 `constant_solar_output` 错误概念，并通过受控插件升级改善掌握、保持与迁移。

演示步骤：

1. Learning Director 根据固定课程约束生成能源 MissionGraph。
2. 学习者完成预测、面积计算和 `solar-energy@1.2.0` 模拟实验。
3. Learning Scientist 聚合 Attempt、Hint、Assessment 和延迟测试证据，创建 LearningFinding。
4. Improvement Planner 形成插件与教学说明两个候选方案。
5. 管理员批准插件变更，Experience Engineer 在独立 worktree 修改日照曲线。
6. 门禁运行物理不变量、评测不变性、可访问性和历史学习轨迹 Replay。
7. 新版本只对合成学习者或内部测试账号 Canary，Scientist 比较掌握、保持、迁移和无伤害指标。
8. 达标后激活新 Plugin Digest 并记录 LearningOutcome；故障注入时回滚到 1.2.0。

这个纵切能同时证明业务 Agent 的长期学习运营、侦察 Agent 的效果诊断、代码 Agent 的插件变更，以及模型调用、记忆、工具发现、长工作流、教育评测、Canary、回滚和经验沉淀。

## 9. 完成定义

项目达到“受控自闭环”而非“骨架”的判定标准：

- 至少一个真实业务场景能从观察自动走到学习。
- 所有阶段均有版本化结构化产物，不依赖聊天历史恢复状态。
- 服务重启、消息重复和模型故障不会破坏状态一致性。
- 每次生产副作用可追溯、可取消或有补偿路径。
- A1 可无人值守运行；A2/A3 按策略进入人工审批。
- 回滚不是 Mock，且已通过故障注入演练。
- Agent 可在三 Bundle 与拆分 Worker 两种形态运行同一协议。
- 替换模型 Provider 不修改 Agent 业务代码。

## 10. 当前最先做的三件事

1. 冻结 LearningWorld、Mission、Attempt、Evidence、Mastery 和 EvolutionRun 的状态机与 JSON Schema。
2. 用 PostgreSQL Outbox/Inbox 跑通太阳能 Mission 的人工纵向闭环。
3. 建 Model Gateway 和 Plugin SDK；pi-ai 先服务 Mission/诊断/方案生成，插件修改只生成 PR。

这三步完成后，再决定保留 RocketMQ/Nacos/Milvus/ES 的具体组合，会比先围绕现有中间件补 TODO 更稳妥。

## 11. RAG 与记忆系统建设轨道

详细设计见 [FireFly-RAG与记忆系统设计.md](./FireFly-RAG与记忆系统设计.md)。该轨道与 Phase 0-5 并行推进，但必须先完成权限和数据模型，再开放长期记忆写入。

### R0：文本证据与确定性聚合

- 已建立 `MemoryRecord`、`QueryPlan`、`EvidenceCitation`、`StructuredResult` 和 `EvidencePack` v1 Schema。
- PostgreSQL 已保存 ACL、Fact/Event、Chunk 和索引版本；MinIO/S3 对象删除路径已接入，完整对象写入与 Lineage 管理仍待实现。
- 已实现 PostgreSQL FTS 基线 + pgvector 精确检索、RRF、双重 ACL 和引用；Markdown 已采用只召回 Child、按预算扩展 Parent 的结构化分块，生产 BM25/ANN 与其他内容类型 Chunker 待实现。
- 已完成一个 `COUNT DISTINCT` 聚合用例，禁止由 LLM 自行计数。
- 已实现 `building -> ready -> active -> retired/failed` 索引生命周期，正式查询只读单一 active 版本。
- 已实现租约式索引构建 Worker、基础 Ready Gate、确定性 Chunk/Embedding 写入、崩溃恢复与可选原子激活。
- 已实现版本化 `IndexQualityReport` 与高级 Ready Gate：结构、来源水位、ACL、Recall、Citation 检查必须齐全，分数/阈值/样本量/证据可审计，并与构建身份和配置 Digest 绑定。生产 ACL/Recall/Citation Probe 与固定评测集待接入。
- 已实现删除目标扇出和逐目标 Ack；对象存储消费者已用 AWS S3 SDK 对真实 MinIO 验证，支持定向领取、退避、attempt 耗尽终态和 failed 目标 reconciliation。本地回执仍不等于全局删除完成。
- 已实现 Markdown Parent/Child：Parent 保存章节上下文且无 Embedding，Child 保存召回粒度并引用同 Memory、同索引版本 Parent；扩展位于 Child 选证据之后，必须复检 active/tenant/ACL，共享 Parent 去重，超预算保留 Child。

### R1：用户与 Agent 长期记忆

- 增加 public、tenant、agent-private、user-private 和 session Scope。
- 实现显式记忆同意、Purpose、保留期、导出和删除传播。
- 跑通 raw -> episodic -> structured，并保留全部来源回链。

### R2：查询规划与多路检索

- 增加 Query Planner、SQL Event、Temporal 和 Relation Edge 检索。
- 实现 Fusion、Evidence Expansion、Rerank 和 Sufficiency Gate。
- 证据不足时重规划或澄清，不强制生成答案。

### R3：多层记忆压缩

- 实现访问频率、时间衰减、情感/业务强度、独特性、效用和可信度信号。
- 按记忆 Kind 配置半衰期和压缩规则。
- 压缩生成新摘要并回链原始证据，不覆盖原记录。

### R4：多模态与高安全

- 增加 PDF Layout/OCR、ASR、图片区域、视频场景和跨模态向量。
- 权限过滤覆盖原始 Asset、派生文本、Embedding、摘要和缓存。
- 增加 Prompt Injection、数据投毒、PII/DLP、Provider 地域和删除传播测试。

### RAG 放行标准

- 跨租户、用户和 Agent 私有空间的检索隔离测试全部通过。
- 聚合问题返回确定性结果和参与计算的事件 ID。
- 所有答案引用能定位到原始文档页、代码行、图片区域或音视频时间码。
- 删除一条记忆后，原文、事实、Chunk、向量、摘要和缓存均不可检索。
- 压缩后的 Fact Preservation、Provenance Coverage 和下游任务质量达到基线。

### 当前施工顺序

1. 为高级 Ready Gate 接入真实 ACL 抽样器、固定 Recall/Citation 评测集和证据 Artifact；失败版本不可激活。
2. 为 `reconcileFailedDeletionTargets` 增加可观测的周期调度器，并逐个实现 lexical/vector/cache/summary/evaluation 删除 Provider 与证据核验。
3. 为 retired 版本建立带保留期的垃圾回收任务，删除必须避开 active 和仍被审计引用的版本。
4. 以 Markdown Parent/Child 合同为基线，增加 PDF Layout、代码 AST 和表格结构化 Chunker；禁止把纯字符切片包装成结构化实现。
5. 接入生产 BM25 Provider；pgvector 按模型/维度分区后再评估 HNSW，不把当前精确检索称为 ANN。

## 12. 工具系统建设轨道

详细契约见 [FireFly-工具系统设计.md](./FireFly-工具系统设计.md)。

### T0：静态目录

- 定义 ToolDescriptor、五类目录、Search/Describe 和 Schema Hash。
- 三 Agent 只保留 `tool.search/describe/invoke/status/cancel` 等 Bootstrap 工具。

### T1：Broker 与权限

- 所有调用经过 Tool Broker、Policy 和 Tool Lease。
- 实现 Agent/用户/Purpose/风险过滤、幂等和审计。

### T2：持久异步

- 实现 `operation_id`、Run 状态机、Worker Lease、进度、取消和 Artifact Result。
- Replay、构建、测试、多模态和 Canary 不允许使用进程内线程承载。

### T3：动态插件

- 实现签名 Provider、Manifest、Sandbox、版本 Snapshot 和 Draining。
- 一次 Mission/Agent Task 固定工具与插件版本。

### T4：KV Cache 与规模化

- 稳定 Bootstrap Schema，只按任务加载 3-8 个完整工具。
- 规范化 Schema 和顺序；健康、价格和负载留在 Broker。
- Schema/权限变化主动失效缓存，并监控工具选择准确率和 Cache 命中率。
