# FireFly QuestLab

FireFly QuestLab 是一个以项目制学习世界为业务主体、以真实学习效果驱动受控改进的三 Agent 系统。

当前阶段是 **v3 架构收敛与编码准备**。现有 Java/Python 教育买课与秒杀实现属于 `prototype-v0`，仅用于追溯早期实验，不代表目标架构，也不应继续在其上补业务功能。

## 三 Agent

| Agent | 角色 | 核心产物 |
|---|---|---|
| Learning Director | 业务 Agent / 学习导演 | MissionPlan、NextAction、Intervention、LearnerMessage |
| Learning Scientist | 侦察 Agent / 学习科学家 | LearningFinding、EvidencePack、OutcomeEvaluation |
| Experience Engineer | 代码处理 Agent / 体验工程师 | ChangeSet、PatchCommit、PluginDigest、GeneratedTests |

三个 Agent 不通过自由文本直接接力，也不直接修改彼此状态。Control Plane 通过版本化 `Task` 调度能力，Agent 通过 `Event` 报告事实，通过 `ArtifactRef` 交付大对象；PostgreSQL 工作流状态是唯一事实源。

## 文档入口

按以下顺序阅读：

1. [开工架构与实施顺序](./FireFly-QuestLab-开工架构与实施顺序.md)：编码阶段的事实源，包含通信协议、模块边界、仓库结构、里程碑和 GitHub 权限。
2. [v3 目标架构图](./FireFly-QuestLab-目标架构-v3.drawio)：7 页精简主图。
3. [产品与三 Agent 详细设计](./FireFly-QuestLab产品与三Agent详细设计.md)：产品、领域对象、状态机和太阳能纵向切片。
4. [RAG 与记忆系统设计](./FireFly-RAG与记忆系统设计.md)：聚合检索、记忆分层、压缩、多模态与安全。
5. [工具系统设计](./FireFly-工具系统设计.md)：五类工具、发现、异步、动态加载和 KV Cache。
6. [开放式架构分析](./FireFly-开放式架构分析.md)：早期问题分析与决策背景。
7. [目标架构构建文档](./FireFly-目标架构构建文档.md)：更详细的阶段性建设要求。

`FireFly-开放式目标架构.drawio` 是旧的 11 页分析图，内容较密且存在重复；保留作历史参考，不再作为主图。`FireFly-Agent设计.drawio` 和 `FireFly-Agent设计说明.md` 均属于 Legacy Prototype v0。

## 推荐起步形态

```text
TypeScript 模块化单体
├─ Learning Runtime
├─ Control Plane
├─ Model Gateway（pi-ai）
├─ Learning Director
├─ Learning Scientist
├─ Experience Engineer
└─ Tool / Memory / Plugin Ports

独立隔离 Worker
├─ Sandbox Runner
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

编码顺序不是先接模型，而是：契约与状态机 → PostgreSQL 事实层 → 无 LLM 人工闭环 → 插件门禁与真实回滚 → pi-ai Model Gateway → RAG、记忆和动态工具。

## 当前仓库状态

- 当前目录尚未初始化为 Git 仓库。
- 当前环境没有可用的 GitHub CLI `gh`。
- 本地编码不需要 GitHub 权限；worktree、Commit 和回滚需要先建立本地 Git 仓库。
- 创建远端、推送分支、开 PR 和配置 Actions 时，再按最小权限单独授权。

在正式写代码前，需要先确定：在当前目录初始化新仓库，还是另建 `firefly-questlab` 仓库并将现有原型归档到 `legacy/prototype-v0`。
