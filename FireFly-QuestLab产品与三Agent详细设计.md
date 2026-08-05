# FireFly QuestLab 产品与三 Agent 详细设计

> 版本：v2 目标设计。本文替代“教育买课 + 秒杀”作为 FireFly 的主体业务定义。旧代码和旧设计可作为原型参考，不构成实现约束。

编码入口见 [开工架构与实施顺序](./FireFly-QuestLab-开工架构与实施顺序.md)；配套专项设计：[RAG 与记忆系统](./FireFly-RAG与记忆系统设计.md)、[工具系统](./FireFly-工具系统设计.md)；主图见 `FireFly-QuestLab-目标架构-v3.drawio`。旧的 `FireFly-开放式目标架构.drawio` 只作历史参考。

## 1. 产品定位

FireFly QuestLab 是一个能够为每个学习者生成长期项目任务世界，并根据真实学习效果持续改进教学策略和互动软件的自进化教育平台。

它不以售卖固定视频课程为核心，而以“学习世界即持续演进的软件体验”为核心：

```text
学习目标与兴趣
→ 能力诊断
→ 生成项目制学习世界
→ 完成任务、实验和作品
→ 形成性评估
→ 调整难度、解释和工具
→ 延迟复习与迁移应用
→ 持续更新学习者模型
```

示例学习世界：

- 火星基地：通过能源、水循环、通信和资源调度学习物理、数学和编程。
- 未来城市：通过交通、预算和碳排放学习统计、经济和系统思维。
- 自动化工厂：通过传感器、控制逻辑和故障排查学习编程与工程。
- 虚拟创业：通过产品、定价、现金流和用户研究学习商业与数据分析。

## 2. 商业与用户价值

### 2.1 用户角色

| 角色 | 核心价值 |
|---|---|
| 学习者 | 获得长期、个性化、可交互的项目学习体验 |
| 教师 | 设置课程约束、观察证据、干预并复用任务模板 |
| 家长/导师 | 在授权范围内查看阶段报告和需要帮助的节点 |
| 内容创作者 | 发布主题包、任务模板、评测器和互动插件 |
| 学校/机构 | 管理班级、课程标准、数据治理和效果评估 |

### 2.2 可商业化对象

- 个人学习世界订阅。
- 学校或培训机构班级空间。
- 学科任务包和主题世界模板。
- 互动模拟器、评测器和插件市场。
- 教师工作台、学习效果报告和合规部署。

### 2.3 产品边界

QuestLab 负责学习任务编排、互动、评估和持续改进，不替代正式学历认证、医疗诊断或心理诊断。未成年人数据、情绪推断和高风险教育决策必须遵守独立治理策略。

## 3. 三 Agent 总览

| 顶层 Agent | 中文角色 | 业务职责 | 禁止事项 |
|---|---|---|---|
| Learning Director | 业务 Agent / 学习导演 | 运营学习旅程、任务、反馈和协作 | 不修改代码，不批准自身策略变更 |
| Learning Scientist | 侦察 Agent / 学习科学家 | 观察效果、诊断认知问题、产生证据 | 不直接改变学习者状态和生产策略 |
| Experience Engineer | 代码处理 Agent / 体验工程师 | 修改插件、流程、RAG、工具和代码 | 不自行批准上线，不修改评测基线 |

控制面、Policy Engine、确定性评测、审批、插件沙箱和发布门禁是平台能力，不算第四个 Agent。

## 4. 学习者与能力对象

### 4.1 学习者与能力

```text
Learner
LearnerProfile
LearningGoal
KnowledgeConcept
MasteryState
Misconception
InterestProfile
AccessibilityPreference
ConsentPolicy
```

`MasteryState` 不能只保存一个分数，至少包含：

```json
{
  "learner_id": "learner_01",
  "concept_id": "physics.energy.power",
  "estimate": 0.68,
  "confidence": 0.74,
  "evidence_count": 8,
  "last_assessed_at": "2026-08-04T10:00:00Z",
  "retention_due_at": "2026-08-11T10:00:00Z",
  "model_version": "bkt@1.0",
  "source_evidence_ids": ["ev_attempt_01", "ev_project_02"]
}
```

## 5. 代码处理 Agent：Experience Engineer

### 5.1 职责

- 消费经过控制面排期或批准的 `ImprovementPlan`。
- 修改互动插件、任务 DSL、评测器、RAG、解析器和工具连接器。
- 在独立 worktree 与沙箱中生成 ChangeSet。
- 生成或补充单元、属性、学科不变量和历史 Replay 测试。
- 输出 Patch、Plugin Artifact、SBOM 和变更说明。
- 响应独立验证反馈并修订，但不能修改验证基线。

### 5.2 可变更对象

| 风险 | 对象 | 放行方式 |
|---|---|---|
| A1 | Prompt、模型路由、RAG 参数 | 离线评测 + 自动回滚 |
| A2 | Mission DSL、提示策略、插件配置 | Schema + Replay + Shadow |
| A3 | 插件源码、评测器、连接器、平台代码 | 沙箱 + 完整 CI + 人工审批 + Canary |

涉及身份、支付、同意、数据保留、课程硬标准和安全门禁的代码，默认不允许 Agent 自主修改。

### 5.3 输入与输出

输入：

```text
ApprovedImprovementPlan
LearningFinding + EvidencePack
TargetArtifactSnapshot
PluginSDK + CodingPolicy
VerificationContract
```

输出：

```text
ChangeSet
PatchCommit
PluginArtifactDigest
GeneratedTests
MigrationPlan
RiskDeclaration
```

### 5.4 独立门禁

Experience Engineer 不拥有生产发布工具。它只能提交结果，由控制面调用确定性 CI、独立 Reviewer Worker 和 Approval Policy。这样保持三个顶层 Agent 的同时，避免代码 Agent 自审自批。

## 6. 学习插件架构

### 6.1 插件类型

- `simulation`：物理、化学、经济和系统模拟器。
- `visualization`：图表、时间线、关系图和过程可视化。
- `challenge`：互动任务、小型游戏和项目步骤。
- `evaluator`：代码、计算、解释和作品评测。
- `parser`：手写、语音、图片、实验视频和文档解析。
- `connector`：代码沙箱、数据集、硬件和第三方学习工具。

### 6.2 PluginManifest

```json
{
  "plugin_id": "sim.solar-energy",
  "version": "1.3.0",
  "type": "simulation",
  "subjects": ["physics", "math"],
  "concepts": ["physics.energy.power", "math.area"],
  "runtime": "web-sandbox",
  "entrypoint": "dist/index.js",
  "input_schema": "SolarSimulationInput.v2",
  "output_schema": "SolarSimulationEvidence.v2",
  "permissions": ["artifact:read:lesson_assets"],
  "network_policy": "deny",
  "resource_limits": {"cpu_ms": 1000, "memory_mb": 128},
  "learning_contract": {
    "target_concepts": ["physics.energy.power"],
    "misconception_risks": ["constant_solar_output"],
    "required_evidence": ["prediction", "simulation_run", "explanation"]
  },
  "artifact_digest": "sha256:..."
}
```

### 6.3 动态发现与加载

Learning Director 不接收全量插件 Schema。它先调用 `tool.search`，按知识目标、学习阶段、模态、权限和可访问性筛选候选，再加载少量完整 Manifest。

插件代码不加载到 Agent 进程，在浏览器隔离环境、容器或微虚拟机中执行。一次 Mission 固定 `plugin_snapshot`，避免运行中版本变化。

## 7. 完整业务闭环

以“火星基地太阳能任务”为例：

```text
1. Learning Director 激活能源 Mission
2. 学习者使用 solar-energy@1.2.0 预测并运行实验
3. Learning Scientist 聚合错误概念和延迟测试数据
4. 发现插件没有表现昼夜光照变化
5. 生成 LearningFinding 与成功标准
6. 管理员批准 ImprovementPlan
7. Experience Engineer 修改插件并生成测试
8. CI 校验物理不变量、可访问性和历史 Replay
9. 新版本对 5% 合适学习者 Canary
10. Scientist 比较掌握、保持、迁移和无伤害指标
11. 达标后全量，否则回滚到 1.2.0
12. Outcome 写入经验记忆并更新插件可信度
```

## 8. 平台架构

```text
Web / Mobile / Teacher Console
              |
Learning Runtime + Mission State Machine
              |
FireFly Control Plane
├─ Durable Workflow
├─ Agent Registry
├─ Tool Registry / Tool Broker
├─ Policy / Consent / Approval
├─ Experiment & Evaluation
├─ Plugin Registry / Sandbox / Release
└─ Audit / Observability

Three Agent Bundles
├─ Learning Director
├─ Learning Scientist
└─ Experience Engineer

Shared Platform
├─ Model Gateway + pi-ai
├─ Knowledge & Memory Fabric
├─ PostgreSQL / pgvector
├─ Object Store
└─ Git / OCI Artifact Registry
```

Learning Runtime 是确定性业务服务。即使三个 Agent 暂停，已激活任务、作品保存、教师查看和已有插件仍能继续运行。

## 9. Agent 通信

### 9.1 关键事件

```text
LearningGoalConfirmed
MissionActivated
ChallengeAttempted
ArtifactSubmitted
AssessmentCompleted
HintConsumed
MisconceptionObserved
LearningFindingCreated
ImprovementPlanApproved
PluginChangeVerified
PluginCanaryStarted
PluginOutcomeEvaluated
PluginRolledBack
```

### 9.2 关键任务

```text
GenerateMissionPlanTask
SelectInterventionTask
AnalyzeLearningOutcomeTask
GenerateImprovementPlanTask
BuildPluginChangeTask
VerifyPluginTask
EvaluateCanaryTask
```

Agent 只提交结构化结果。控制面校验状态转换、权限、幂等键和制品引用后落库并发布事件。

### 9.3 异步边界

- 同步：资料查询、短评测、工具发现、状态读取。
- 异步：多模态解析、Mission 生成、历史 Replay、插件构建、测试和 Canary。
- 流式：Learning Director 对话、任务生成进度、教师报告和长时间实验反馈。

## 10. RAG 与记忆业务映射

### 10.1 知识空间

| Scope | QuestLab 内容 |
|---|---|
| public | 教材、论文、开放课程标准、公共模拟数据 |
| tenant | 学校课程、教师材料、班级规则和校本案例 |
| agent_private | 教学策略经验、工具失败模式、代码修复案例 |
| user_private | 学习目标、能力、错误概念、作品、偏好和授权反馈 |
| session | 当前 Mission、临时假设和未确认推断 |

### 10.2 结构化记忆

```text
LearnerEvent
ConceptEvidence
MasteryRevision
MisconceptionOccurrence
StrategyExposure
PluginExposure
AssessmentOutcome
DelayedRetentionOutcome
TransferOutcome
```

“某种提示使用几次后用户才能独立完成”“某插件版本影响哪些错误概念”等问题必须走事件聚合，RAG 负责返回作品、对话和实验记录。

### 10.3 记忆安全

- 用户私有学习记忆仅用于授权的学习目的。
- 情绪和困难推断先进入 Session/Candidate，不自动固化为长期事实。
- 教师和家长读取范围由 ConsentPolicy 控制。
- 不允许把单个学习者的私有证据用于其他用户的 Prompt。
- 用于群体改进的数据需去标识化并达到最小样本阈值。

## 11. 评估与反优化

### 11.1 学习硬不变量

- 候选版本不能修改自身成功标准、Rubric 或对照组定义。
- 同一作品不得因插件版本变化被静默改分。
- 未经授权的群体属性不得进入个性化决策。
- 学习任务不得绕过年龄、课程和内容安全策略。
- MasteryRevision 必须回链至少一条学习证据。
- 一个策略不能只因提高停留时长而判定有效。
- Canary 期间任何严重安全或公平性退化立即停止。

### 11.2 实验设计

- 优先使用学习者自身前后对照、历史 Replay 和合成轨迹。
- 在线实验按课程、能力和风险分层，避免不公平地剥夺有效教学。
- 成功指标至少覆盖即时掌握、延迟保持和迁移，不能只看即时测验。
- 报告置信区间、样本量和提前停止规则。
- 小样本只形成假设，不自动全量发布。

## 12. API 草案

### 12.1 Learning Runtime

```text
POST /v1/learners/{id}/goals
POST /v1/learners/{id}/diagnostics
POST /v1/worlds
GET  /v1/worlds/{id}/missions
POST /v1/missions/{id}/activate
POST /v1/challenges/{id}/attempts
POST /v1/artifacts
POST /v1/assessments/{id}/submit
GET  /v1/learners/{id}/mastery
POST /v1/teacher/interventions
```

### 12.2 Agent 与控制面

```text
POST /v1/agent-tasks
GET  /v1/agent-tasks/{id}
POST /v1/findings
POST /v1/improvement-plans
POST /v1/approvals/{id}/decision
POST /v1/plugin-changes
POST /v1/canaries
POST /v1/canaries/{id}/rollback
```

### 12.3 插件

```text
POST /v1/plugins
POST /v1/plugins/{id}/versions
GET  /v1/plugins/search
GET  /v1/plugins/{id}/manifest
POST /v1/plugin-runs
GET  /v1/plugin-runs/{operation_id}
POST /v1/plugin-runs/{operation_id}/cancel
```

## 13. 数据表建议

```text
learner
learner_profile
learning_goal
knowledge_concept
concept_prerequisite
mastery_state
misconception
learning_world
mission_graph
mission
challenge
learning_attempt
learning_event
project_artifact
assessment
assessment_result
teaching_strategy
strategy_exposure
intervention
experience_plugin
plugin_version
plugin_exposure
learning_finding
improvement_plan
verification_report
canary_experiment
evolution_outcome
consent_policy
```

通用的工作流、事件、Memory、Artifact、ACL、Outbox/Inbox 和审计表复用平台设计。

## 14. 技术实现建议

### 14.1 MVP 技术栈

```text
TypeScript
├─ Control Plane
├─ Learning Runtime
├─ Model Gateway + pi-ai
├─ Tool/Plugin Registry
└─ Web Console

Python
├─ Learning analytics
├─ Multimodal extraction
├─ Evaluation / Replay
└─ Specialized Agent Workers

Infrastructure
├─ PostgreSQL + pgvector
├─ MinIO/S3
├─ Git + OCI Registry
├─ Container/Web Sandbox
└─ OpenTelemetry + Prometheus
```

先用 PostgreSQL Outbox/Inbox 实现事件可靠性。达到长任务规模后再评估 Temporal 和独立 MQ；达到检索规模后再评估 Elasticsearch/Milvus。

### 14.2 建议代码结构

```text
firefly-questlab/
├─ apps/
│  ├─ web/
│  ├─ learning-runtime/
│  ├─ control-plane/
│  └─ model-gateway/
├─ agents/
│  ├─ learning-director/
│  ├─ learning-scientist/
│  └─ experience-engineer/
├─ services/
│  ├─ knowledge-memory/
│  ├─ evaluation/
│  ├─ tool-broker/
│  └─ plugin-registry/
├─ packages/
│  ├─ contracts/
│  ├─ learning-domain/
│  ├─ agent-kernel/
│  ├─ plugin-sdk/
│  └─ policy-sdk/
├─ workers/
│  ├─ multimodal/
│  ├─ replay/
│  └─ sandbox-runner/
├─ evaluation/
│  ├─ datasets/
│  ├─ simulated-learners/
│  └─ invariants/
└─ deploy/
```

## 15. 第一个纵向切片

首个版本只做“火星基地能源 Mission”，只覆盖三个概念：功率、能量和面积。

### 15.1 必须实现

1. 学习者设定主题、目标和时间。
2. Learning Director 读取固定课程约束，生成 MissionGraph。
3. 用户完成预测、计算和太阳能模拟实验。
4. 系统保存 Attempt、Artifact 和结构化 Evidence。
5. Learning Scientist 根据固定规则和模型辅助发现 `constant_solar_output` 错误概念。
6. Experience Engineer 在预置插件仓库修改日照曲线组件。
7. 沙箱运行物理不变量、可访问性和历史 Replay。
8. 人工批准后，用合成学习者或内部测试账号 Canary。
9. 生成 Outcome 并写入经验记忆。

### 15.2 暂不实现

- 支付和插件市场交易。
- 大规模学校和班级管理。
- 真实未成年人在线实验。
- 平台核心源码无人审批自修改。
- 全量多学科知识图谱。

## 16. 分阶段路线

### Q0：确定性学习 Runtime

- 建立核心实体、状态机、课程约束和固定 Mission。
- 插件以手工编写、签名版本运行。
- Agent 只读，不自动改变学习路径。

### Q1：Learning Director

- 接入 Model Gateway、结构化输出和工具发现。
- 个性化 MissionGraph、提示和反思。
- 所有决策可解释并有教师覆盖机制。

### Q2：Learning Scientist

- 建立事件分析、Mastery、错误概念和延迟测试。
- 跑通 Finding、EvidencePack 和历史 Replay。
- 只提出改进，不自动变更。

### Q3：Experience Engineer 插件闭环

- worktree、插件 SDK、沙箱、CI、审批和 Artifact Registry。
- 首先生成 PR，再开放 A1/A2 自动变更。
- 跑通插件 Canary 和回滚。

### Q4：长期记忆与多模态

- 用户私有学习记忆、同意、删除和压缩。
- 手写、语音、图片、代码和实验视频证据。

### Q5：创作者与学校生态

- 世界模板、插件市场、班级、教师协作和租户治理。
- 只在证据充分后开放跨租户的去标识化经验学习。

## 17. 完成定义

QuestLab 达到首个“受控自进化业务闭环”的标准：

- Learning Director 能持续运行一个完整 Mission，而非只回答问题。
- Learning Scientist 能从真实学习证据产生可复现 Finding。
- Experience Engineer 能修改隔离插件并提交可验证 ChangeSet。
- 候选版本不能修改自身 Rubric、评测集和审批策略。
- Canary 能比较掌握、保持、迁移和无伤害指标。
- 插件退化可恢复到指定 Digest，且学习记录不丢失。
- 用户记忆有 Scope、Consent、Lineage、导出和删除能力。
- 三 Agent 停止时，确定性 Learning Runtime 仍可继续既有学习任务。


## 附录 A：其他核心业务对象

### A.1 学习世界与任务

```text
LearningWorld
WorldTemplate
MissionGraph
Mission
Challenge
Resource
Hint
TeachingStrategy
Intervention
```

`MissionGraph` 是有向图，不是线性课程目录。节点声明知识目标、前置能力、任务、工具和验收证据；边声明前置关系、补救路径和可选分支。

### A.2 学习证据与评估

```text
LearningAttempt
LearningEvent
ProjectArtifact
Assessment
Rubric
AssessmentResult
Reflection
TransferTask
DelayedReview
```

学习证据可以是文本、代码、手写内容、语音解释、实验视频、图表、模拟器状态和操作轨迹。

### A.3 插件与演进

```text
ExperiencePlugin
PluginManifest
PluginVersion
VerificationReport
CanaryExperiment
LearningFinding
ImprovementPlan
EvolutionOutcome
```

## 附录 B：业务状态机

### B.1 学习旅程

```text
onboarding
→ diagnosing
→ planning
→ active
→ reflecting
→ delayed_review
→ transferring
→ completed

旁路状态：paused | waiting_teacher | waiting_consent | withdrawn
```

### B.2 Mission

```text
draft -> ready -> active -> assessing
                         ├-> mastered
                         ├-> remediation -> active
                         ├-> waiting_support
                         └-> abandoned
```

所有状态转换由业务事件触发，LLM 只能提出转换建议，Learning Runtime 校验前置条件后落库。

### B.3 插件版本

```text
proposed
→ sandboxed
→ verified
→ awaiting_approval
→ canary
→ active

失败状态：rejected | failed | rolled_back | retired
```

## 附录 C：业务 Agent - Learning Director

### C.1 职责

- 与学习者澄清目标、兴趣、时间和可访问性需求。
- 调用诊断评测，建立初始能力和错误概念假设。
- 在课程标准和教师约束下生成 MissionGraph。
- 选择任务、解释方式、难度、提示和互动插件。
- 根据实时证据调整任务，但不能直接修改最终评测标准。
- 组织形成性评估、反思、延迟复习和迁移任务。
- 在需要时请求教师、家长或同伴协作。
- 向学习者解释推荐原因并提供证据。

### C.2 输入与输出

输入：

```text
LearningGoal + LearnerProfile + MasteryState
CurriculumPolicy + TeacherConstraint
MissionState + RecentEvidence + AllowedTools
```

结构化输出：

```text
MissionPlan
NextChallengeDecision
HintDecision
InterventionRequest
AssessmentRequest
CollaborationRequest
LearnerMessage
```

### C.3 工具

| 类型 | 工具示例 |
|---|---|
| 感知 | `learner.profile.read`、`mastery.query`、`memory.retrieve`、`artifact.inspect` |
| 执行 | `mission.activate`、`hint.issue`、`assessment.start`、`review.schedule` |
| 协作 | `teacher.handoff`、`peer.session.request`、`task.delegate` |
| 用户沟通 | `clarification.ask`、`feedback.explain`、`progress.present` |
| 事件触发 | 学习提交、长时间停滞、SLA、复习到期、教师反馈 |

### C.4 硬边界

- 不执行支付、身份权限和不可逆数据操作。
- 不保存未经同意的敏感情绪或健康推断。
- 不把参与时长等同学习效果。
- 不得降低课程标准以提高完成率。
- 不得调用未经当前学习世界批准的动态插件。

## 附录 D：侦察 Agent - Learning Scientist

### D.1 职责

- 分析学习事件、作品、评测、提示使用和延迟复习结果。
- 识别错误概念、任务难度失配和插件误导。
- 比较不同策略、插件版本和学习者群体的效果。
- 运行历史轨迹 Replay、对照实验和偏差检查。
- 产生结构化 `LearningFinding`，包含证据、置信度和影响范围。
- 复评新版本是否真正改善掌握、保持和迁移。

### D.2 关键指标

| 维度 | 指标 |
|---|---|
| 掌握 | Mastery Gain、首次独立完成率 |
| 保持 | 7/30 天延迟保持率 |
| 迁移 | 新情境 Transfer Task 成功率 |
| 依赖 | Hint Dependency、答案模仿率 |
| 体验 | 放弃率、挫败恢复率、无聊信号 |
| 正确性 | 错误概念重复率、评测误判率 |
| 公平性 | 群体效果差异、可访问性完成率 |
| 系统 | 插件错误率、工具失败率、引用准确率 |

不能把这些指标简单压成唯一总分后自动决定上线。业务不变量和安全门禁先于软指标。

### D.3 LearningFinding

```json
{
  "finding_id": "finding_01",
  "scope": {"world_id": "mars_01", "plugin_version": "solar@1.2.0"},
  "problem": "学习者误认为太阳能板全天输出恒定",
  "evidence_refs": ["metric://misconception/solar_constant", "artifact://attempt/42"],
  "affected_concepts": ["physics.energy.power"],
  "affected_cohort": "grade8_beginner",
  "confidence": 0.91,
  "severity": "high",
  "recommended_change_type": "plugin_and_instruction",
  "success_criteria": {
    "delayed_retention_delta": 0.08,
    "transfer_success_delta": 0.05,
    "no_harm_constraints": ["assessment_invariance", "accessibility"]
  }
}
```
