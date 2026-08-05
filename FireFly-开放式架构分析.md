# FireFly 开放式架构分析

> 本文描述建议的目标架构，不以当前代码结构为边界。精简主图见 `FireFly-QuestLab-目标架构-v3.drawio`，旧的 `FireFly-开放式目标架构.drawio` 只作历史推演参考。编码入口见 [开工架构与实施顺序](./FireFly-QuestLab-开工架构与实施顺序.md)。

## 1. 核心结论

FireFly 可以完善成真正的闭环系统，但目标不应是“Agent 无限制地修改自己”，而应该是：

> 持续观察业务、提出有证据的改进、在隔离环境验证、按风险自动或人工放行、上线后持续复评并能回滚的受控自进化系统。

建议采用五项架构决策：

1. **pi-ai 放在独立 Model Gateway 中**，作为多模型适配层；Java/Python Agent 不直接绑定 pi-ai 或某一家模型。
2. **学习运行面与自进化控制面分离**。所有 Agent 停止时，已激活 Mission、作品保存、教师查看和已验证插件仍应正常运行。
3. **Agent 逻辑拆分、物理可合并**。先定义稳定能力契约，小规模部署为三个 Bundle，之后可无损拆成 Worker Pool。
4. **Agent 不靠自由文本聊天驱动主流程**，而用结构化任务、版本化事件、不可变制品和持久状态机协作。
5. **自治逐级开放**。先只观察，再允许配置自动变更，最后才开放源码变更。

## 2. pi-ai 多模型接口

### 2.1 当前与目标

当前代码没有实际接入 pi-ai，也没有真正统一的多模型层。LLM 调用主要是 TODO。

目标架构建议使用 pi-ai，但只把它定位为 Model Gateway 的 Provider Adapter：

```text
Java / Python Agent
        |
        | 统一 HTTP/SSE 或 gRPC ModelRequest
        v
Model Gateway (TypeScript)
        |
        +-- pi-ai Provider Adapter
        +-- 模型路由 / Fallback / Retry / Budget
        +-- Prompt 和模型策略版本化
        +-- Usage、成本与质量观测
        |
        +-- 云端模型
        +-- 本地或私有模型
        +-- Embedding / Rerank / Judge 专用模型
```

原因是 pi-ai 可以统一 Provider 调用差异，但不负责长任务状态、Agent 记忆、审批、DAG、发布和回滚。独立网关也能避免 Java、Python 各自实现一套模型调用和密钥管理。

统一请求至少包含：

```json
{
  "request_id": "model_req_01",
  "task_type": "diagnosis",
  "messages": [],
  "tools": [],
  "response_schema": "Finding.v1",
  "routing": {
    "quality_tier": "high",
    "max_latency_ms": 30000,
    "max_cost_usd": 0.2,
    "allow_cloud": true,
    "required_capabilities": ["tool_call", "structured_output"]
  },
  "context": {
    "trace_id": "trace_01",
    "agent_id": "scout-01",
    "prompt_version": "diagnosis@7"
  }
}
```

网关必须记录实际模型、Provider、Prompt 版本、Token、延迟、费用、重试、Fallback 链和 Schema 校验结果。

pi-ai 不应该保存闭环事实状态，不决定源码变更能否上线，不替代工作流和事件总线，也不直接持有生产数据库写权限。

## 3. 能否完善成自闭环项目

这里将“自闭换”理解为“自闭环”。答案是可以，完整流程应是：

```text
Observe -> Diagnose -> Plan -> Change -> Verify -> Release -> Learn
   ^                                                        |
   +---------------------- 新基线与反馈 --------------------+
```

每一步都有结构化产物：

| 阶段 | 输出 | 责任能力 |
|---|---|---|
| Observe | `Observation` | Observer |
| Diagnose | `Finding + Evidence` | Diagnostician |
| Plan | `ChangePlan` | Planner |
| Change | `ChangeSet` | Coder |
| Verify | `VerificationReport` | Verifier |
| Release | `Release + RollbackPoint` | Release Manager |
| Learn | `Experience + BaselineRevision` | Evaluator |

闭环成立需要补齐六项系统能力：

1. **持久工作流**：长任务、审批等待、定时器和重试必须有 checkpoint。MVP 可用 PostgreSQL 状态机 + Outbox；L3 成熟后可引入 Temporal 一类工作流引擎。
2. **客观评估**：离线回归集、在线 SLO、业务不变量、对照组和统计显著性。Judge 模型只能辅助，不能替代确定性测试。
3. **风险分级**：自治等级与教学/插件版本分开命名，避免两套 L1/L2/L3 混淆。
4. **隔离执行**：worktree 之外还要有容器沙箱、短期凭据、网络与工具 allowlist、SBOM 和制品签名。
5. **可验证回滚**：每次发布前验证稳定镜像、配置快照、Schema 兼容性、数据迁移策略和恢复时间。
6. **学习数据治理**：保存 `Observation -> Finding -> Change -> Outcome` 的完整谱系，而不是只把日志文本向量化。

建议自治等级：

| 等级 | 允许行为 | 放行要求 |
|---|---|---|
| A0 | 观察、诊断、生成方案 | 自动 |
| A1 | Prompt、检索参数、可回滚配置 | 自动验证后可自动发布 |
| A2 | DSL、路由、限流和业务规则 | 静态检查 + Replay + Shadow，可按策略审批 |
| A3 | 源码、依赖、数据库 Schema | 沙箱 + 完整 CI + 人工审批 + 灰度 |

学习者身份与同意、课程硬标准、最终评测、未成年人敏感数据、破坏性迁移，以及评测基线、审批规则和 Agent 自身权限，不建议无人审批闭环。

## 4. Agent 能否本质可拆、在项目中合体

可以，而且这是最适合 FireFly 的设计。

建议拆成八个逻辑能力：

1. `JourneyOrchestrator`：目标澄清、MissionGraph 与长期学习旅程。
2. `LearningRuntime`：Mission、Attempt、Artifact 和 Assessment 状态机。
3. `LearningObserver`：学习事件、作品、提示、评测和用户反馈。
4. `LearningDiagnostician`：掌握、错误概念、保持、迁移和证据归因。
5. `ImprovementPlanner`：教学或软件候选方案、影响面和风险。
6. `ExperienceCoder`：插件、流程、RAG、解析器和连接器变更。
7. `LearningVerifier`：学科不变量、Replay、可访问性和安全验证。
8. `PluginReleaseManager`：审批、Canary、观察和回滚。

QuestLab MVP 阶段仍部署三个 Agent Bundle：

```text
Learning Director    = 学习旅程编排 + Mission 决策 + 用户沟通
Learning Scientist   = Observer + Diagnostician + Learning Evaluator
Experience Engineer  = Planner + Coder
```

Learning Runtime、确定性评测、审批和发布门禁属于平台，不是第四个 Agent。Experience Engineer 只提交 ChangeSet，由独立门禁验证和发布，不能自审自批。合体只是把能力模块打进同一部署单元，模块之间仍通过接口协作，不能绕过契约直接修改彼此内部状态。

当某类任务需要独立扩缩容、权限隔离、不同模型/硬件，或需要多个独立实现竞争时，再拆成 Worker Pool。拆合过程中保持四类契约不变：

- `Capability`：输入、输出、权限、成本、超时和幂等语义。
- `Task`：目标、约束、预算和验收标准。
- `Artifact`：代码、报告和镜像使用不可变引用。
- `Event`：版本化消息、因果链和幂等键。

示例能力描述：

```json
{
  "name": "plugin.patch.simulation",
  "version": "1.2.0",
  "input_schema": "ImprovementPlan.v2",
  "output_schema": "PluginChangeSet.v2",
  "permissions": ["git:worktree:write", "network:model-gateway"],
  "timeout_sec": 900,
  "cost_class": "high",
  "idempotent": true
}
```

控制面按能力选择 Worker，不按固定服务名写死调用关系，才能做到“今天合体、明天拆分”。

## 5. Agent 之间如何交流

### 5.1 当前逻辑评价

现有设计同时考虑了同步 gRPC/HTTP、异步 RocketMQ 和持久 Inbox，方向正确，但边界还不够清楚：

- gRPC Proto 已定义，当前主要实现仍是 HTTP。
- MQ 生产和消费尚未打通。
- JSONL Inbox 有并发、截断、单机绑定问题。
- 数据库、MQ 和 Inbox 中谁是唯一事实源尚不明确。
- 缺少统一 Schema 版本、幂等键、因果链和事件重放规则。

### 5.2 推荐通信模型

**同步 API**只用于健康检查、状态查询、短时无副作用校验和模型流式调用，不承载构建、压测、审批等待与灰度观察。

**事件总线**发布已经发生的事实，例如 `ObservationCreated`、`FindingCreated`、`ChangeVerified`、`ReleaseDegraded` 和 `RollbackCompleted`。

**工作流任务**表示期望某能力执行的动作，例如 `DiagnoseTask`、`GeneratePatchTask`、`VerifyChangeTask`。任务具有租约、截止时间、取消令牌、重试策略和 checkpoint。

**制品通道**保存源码、日志、数据集、报告和镜像。消息只发送 Git Commit、OCI Digest、对象 URI、SHA-256 和报告 ID。

统一事件信封建议为：

```json
{
  "event_id": "evt_01",
  "event_type": "FindingCreated",
  "schema_version": 1,
  "correlation_id": "evolution_01",
  "causation_id": "evt_00",
  "trace_id": "trace_01",
  "producer": "scout.diagnostician@1.3.0",
  "target": "control-plane",
  "occurred_at": "2026-08-03T12:00:00Z",
  "deadline": "2026-08-03T12:10:00Z",
  "idempotency_key": "finding:release-42:baseline-7",
  "artifact_refs": ["s3://firefly/evidence/ev_01.json#sha256=..."],
  "payload": {}
}
```

一致性原则：

- PostgreSQL 工作流状态是唯一事实源。
- 状态更新与事件写入使用 Transactional Outbox。
- Consumer 用 Inbox 表对 `event_id` 去重。
- 失败指数退避，超过阈值进入 DLQ 和 `needs_human`。
- 事件可重放，副作用工具必须接受幂等键。
- Agent 只提交结果，控制面负责校验并执行合法状态转换。

## 6. 进一步建议

### 6.1 Learning Runtime 必须独立于三个 Agent

Mission 状态机、Attempt、Artifact、Assessment 和 Mastery 的事实写入应由确定性 Learning Runtime 完成。Learning Director 可以提出下一任务、提示或干预建议，但不能直接篡改状态。即使三个 Agent 停止，学习者仍能继续已激活任务，教师仍能查看证据，已验证插件仍能运行。

### 6.2 建立 Replay / 数字孪生环境

对脱敏后的学习事件、作品和插件操作轨迹进行候选版本重放，比较状态机终态、学科不变量、评测一致性、幂等性、延迟及资源消耗。候选环境禁止向真实学习者发送消息或改变正式掌握度。

### 6.3 把业务不变量变成机器规则

- 功率、能量和面积等学科计算必须满足版本化不变量。
- 同一学习证据不能因重复投递被累计两次。
- 掌握度修订必须回链到明确证据和模型版本。
- 候选插件不能修改 Rubric、固定评测集或同意策略。
- 学习和发布状态转换只能由明确事件触发。
- 同一次变更不能既改实现又降低验收阈值。

### 6.4 区分三种记忆

| 类型 | 内容 | 推荐存储 |
|---|---|---|
| 工作记忆 | 当前任务上下文、checkpoint | 工作流状态库 |
| 事实记忆 | 版本、配置、发布、审批、指标 | PostgreSQL / Git / Registry |
| 经验记忆 | 缺陷、方案、结果、适用条件 | Postgres + 向量/BM25 |

RAG 是经验检索手段，不是事实状态源。

### 6.5 防止指标投机

- 硬业务不变量先于软综合分。
- 评测集和阈值由独立权限域管理。
- 候选版本不能修改自身验收标准。
- 保留对照组，避免把流量自然变化误判为升级收益。
- 经验带有效期，定期清理过期或低可信案例。

## 7. QuestLab 主体定位

FireFly 的主体业务确定为 QuestLab，详细设计见 [FireFly-QuestLab产品与三Agent详细设计.md](./FireFly-QuestLab产品与三Agent详细设计.md)。它不是课程电商，而是：

> 为每个学习者生成长期项目任务世界，并根据真实学习效果持续改进教学策略与互动软件的自进化教育平台。

Learning Director 运营学习旅程，Learning Scientist 诊断掌握、保持、迁移和错误概念，Experience Engineer 修改受限插件、RAG、流程和工具。控制面、Agent 契约、模型网关、事件协议、验证和发布能力仍保持领域无关；教育差异通过课程策略、学习证据、业务不变量、评测集和插件 SDK 注入。

工具分类、异步执行、发现、动态加载和 KV Cache 的编码设计见 [FireFly-工具系统设计.md](./FireFly-工具系统设计.md)。

## 8. RAG 与长期记忆架构补充

RAG 已进一步定义为 `Knowledge & Memory Fabric`，详细编码设计见 [FireFly-RAG与记忆系统设计.md](./FireFly-RAG与记忆系统设计.md)。v3 主图第 06 页把权限、聚合检索、记忆成熟阶段、多层压缩和多模态证据收敛到一张主路径图中。

关键决策：

- RAG、长期记忆和结构化查询是三个协作系统，不由单一向量库承担。
- 公共、租户、Agent 私有、用户私有、Session 是可见范围；raw、episodic、structured、semantic、procedural 是成熟阶段，两者正交。
- 原始证据不可变，摘要和结构化事实作为派生记录，通过 Lineage 回链来源。
- 计数、去重、时间比较和状态判断使用 SQL/Graph Aggregator，Agent 只解释结果。
- 检索采用授权、意图识别、QueryPlan、多路召回、融合、扩展、聚合、Rerank、证据充分性判断和引用生成。
- 记忆压缩综合访问频率、时间衰减、情感/业务强度、信息独特性、任务效用和来源可信度，但隐私、同意和合规策略拥有最高优先级。
- 多模态保留原始 Asset 与精确 Locator，关键证据由多模态模型复核原始区域。
- 检索数据一律视为不可信证据，权限检查、Prompt Injection 防护、DLP 和删除传播贯穿全链路。
