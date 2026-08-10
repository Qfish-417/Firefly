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
2. [v3 目标架构图](./FireFly-QuestLab-目标架构-v3.drawio)：9 页精简主图，包含独立的联邦治理、循环防护与 M4 Model Gateway 视图。
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
- 旧 Java/Python 原型仍在原目录，只作追溯参考，不被新 TypeScript packages 依赖。

开发检查：

```bash
npm install
npm run check
```

PostgreSQL 集成检查（PowerShell）：

```powershell
docker compose -p firefly-questlab-dev -f infra/compose/questlab-dev.yml up -d
$env:DATABASE_URL = "postgresql://questlab:questlab@127.0.0.1:55432/questlab"
npm run db:migrate
$env:TEST_DATABASE_URL = $env:DATABASE_URL
$env:TEST_SANDBOX_IMAGE = "node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43"
npm run test:integration
npm run admin:start
docker compose -p firefly-questlab-dev -f infra/compose/questlab-dev.yml down
```

Admin API 默认只监听 `http://127.0.0.1:3100`，运行轨迹入口为 `GET /admin/evolution-runs/{run_id}`，响应同时包含因果边、预算、哨兵、PluginRelease、Sandbox、Canary 与当前活动 PluginVersion。该 Compose 环境使用 `tmpfs`，仅用于本地集成测试；执行 `down` 后测试数据不会保留。

M5 的运行时决策依次记录在 [ADR 0008](./docs/adr/0008-model-invocation-projection.md)、[ADR 0009](./docs/adr/0009-memory-acl-and-structured-aggregation.md)、[ADR 0010](./docs/adr/0010-governed-retrieval-gateway.md) 和 [ADR 0011](./docs/adr/0011-versioned-retrieval-contracts.md)。
