# FireFly Model Gateway 构建设计

> 状态：M4 已实现（2026-08-06）。本文是后续编码事实源；架构决策见 ADR 0006 与 ADR 0007。

## 1. 目标与边界

Model Gateway 是三个 Agent 与模型 Provider 之间唯一的模型调用边界，但不是新的 Agent，也不是新的工作流事实源。

它负责：

- `generate` / `stream` 的 Provider 中立端口；
- 按 workload 选择主模型和后备模型；
- Token、成本、持续时间预算；
- 重试、超时、取消和失败切换；
- Model、Routing、Prompt、Tool、Knowledge 快照；
- 将 Token、成本、时延和 route 写入 AgentResult；
- 拒绝模型发起的工具调用。

它不负责：

- 执行工具、写文件、提交 Git 或发布插件；
- 批准 ImprovementPlan 或 PluginRelease；
- 绕过 AgentResult Schema、Control Plane、Loop Sentinel 或状态机；
- 把 embedding/rerank 假装成 pi-ai 原生能力。

## 2. 当前实现结构

```text
Agent Task（含预算、deadline、artifact_refs）
  -> Agent 绑定可信上下文并构造 Prompt
  -> RoutedModelGateway
       -> workload 路由
       -> 预算预检
       -> pi-ai transport
       -> retry / fallback / timeout / cancel
       -> 预算后检 + immutable snapshots
  -> Agent 严格解析 JSON
  -> 可信字段覆盖 + Contract 校验
  -> AgentResult
  -> PostgreSQL workflow_task.result
```

代码位置：

| 模块 | 职责 |
|---|---|
| `packages/model-gateway/src/types.ts` | Provider 中立端口与数据类型 |
| `packages/model-gateway/src/gateway.ts` | 路由、预算、重试、流式失败语义 |
| `packages/model-gateway/src/pi-ai-adapter.ts` | `@earendil-works/pi-ai@0.83.0` 适配 |
| `packages/model-gateway/src/configuration.ts` | 显式 workload 路由和稳定策略快照 |
| `agents/learning-scientist/src/model-agent.ts` | 证据解释与可信 Finding 绑定 |
| `agents/learning-director/src/model-agent.ts` | Mission 阶段指导与可信计划绑定 |
| `packages/plugin-platform/src/plugin-engineering-tool.ts` | 授权 Git 读取、真实 worktree、Sandbox 与清理 |
| `agents/experience-engineer/src/model-agent.ts` | 严格 PatchProposal 与受控工程工具调用 |
| `packages/control-plane/src/model-workers.ts` | Stub、模型辅助和三个真实 Agent 组合入口 |

## 3. 配置和凭据

路由是 JSON workload map：

```powershell
$env:FIREFLY_MODEL_ROUTES = '{"learning-scientist.analyze":[{"provider":"<provider>","model":"<model>"}],"learning-director.mission-plan":[{"provider":"<provider>","model":"<model>"}],"experience-engineer.patch":[{"provider":"<provider>","model":"<model>"}]}'
```

主模型写在数组前面，后备模型依次排列。模型名称必须来自 pi-ai 当前 catalog。Provider 凭据使用 pi-ai 支持的环境变量或凭据存储，不写入 `FIREFLY_MODEL_ROUTES`，也不写进代码、Task、快照、日志或 Git。

工作流默认 `deterministic-stub` 且 Task 模型预算为零。真实调用必须显式组合：

```ts
const gateway = createPiAiModelGateway(loadModelGatewayConfiguration());
const workers = createModelAssistedWorkers(gateway);
const execution = {
  mode: "model-assisted",
  worker_id_prefix: "model-worker",
  task_budget: { max_tokens: 4_000, max_cost_usd: 0.10, max_duration_sec: 60 },
} as const;
```

## 4. 路由与失败语义

1. 根据 `workload + capability` 读取有序候选。
2. 用 Prompt 字符数估算输入 Token，并结合模型价格做预检。
3. 单候选按 Gateway retry policy 重试；pi-ai 内部重试设为 0。
4. 仅 retryable provider/timeout 错误进入下一候选。
5. 生成完成后按 Provider 实际 Usage 做 Token 与成本后检。
6. 流式调用只允许在首个 text delta 前切换 Provider；部分输出后失败返回 `PARTIAL_STREAM_FAILURE`。
7. 用户取消是终态，不重试、不切换 Provider。

字符估算不是精确 tokenizer，所以后检仍是必需门禁。生产阶段可按 Provider 接入精确 tokenizer，但不能删除后检。

## 5. 模型输出信任规则

| Agent | 模型可以建议 | 可信代码必须绑定 |
|---|---|---|
| Director | 五阶段的教学指导 | world/mission/goal、插件曝光、阶段顺序、Canary 百分比 |
| Scientist | problem、概念、置信度、严重性、成功指标建议 | finding ID、scope、evidence refs、no-harm constraints |
| Engineer（M4.2） | 批准路径内的 patch proposal | source digest、路径 ACL、Git commit、ArtifactRef、Sandbox 与发布状态 |

模型返回必须是严格 JSON。Markdown fenced JSON、截断输出、未知枚举、非法数值或缺失必填字段均在进入工作流状态机前失败。

## 6. Engineer 工程生命周期

Engineer 不直接获得任意文件系统或 Git 工具。当前实现按一个完整用例运行：

```text
Approved BuildPluginChangeTask
  -> Artifact ACL 校验
  -> 只读加载 source snapshot 中 approved paths
  -> 模型生成 PatchProposal（无副作用）
  -> 路径/大小/文件类型/重复路径校验
  -> GitWorktreeBuilder 生成真实 Commit + audit ref
  -> Docker Sandbox 四门禁
  -> ChangeSet + VerificationReport
  -> 独立 PluginRelease approval
```

worktree 的创建、模型提议、Commit、Sandbox 和 cleanup 必须由同一 Control Plane 用例管理。不能让 Agent 返回伪造 `patch_commit`，也不能先清理 worktree 再要求发布流程运行 Sandbox。

## 7. M4 验收与后续

M4 已验收：

- 维护中的 pi-ai 包已固定版本；
- 主备路由、重试、超时、取消、预算和流式失败语义有测试；
- 模型工具调用被拒绝；
- Director 与 Scientist 的模型输出不能覆盖可信字段；
- Engineer 的模型输出只能包含批准路径，不能提供 Commit、Digest、命令或门禁结论；
- Git source digest 在模型调用前校验，符号链接、路径逃逸、超限源码和补丁均被拒绝；
- worktree、真实 Commit、固定镜像 Sandbox 与 cleanup 位于同一工具调用；
- Control Plane 消费真实门禁报告，失败终止 EvolutionRun，通过后才允许进入发布审批；
- Stub 仍是默认与离线后备；
- embedding/rerank 未配置时显式失败。

后续进入 M5：

- 把实际模型 invocation 做成可聚合查询的 PostgreSQL 投影；
- 实现公共、Agent 私有、用户私有记忆的授权检索与删除传播；
- 实现聚合索引、混合检索、结构化记忆与多层压缩；
- 增加使用真实 Provider 凭据的 opt-in 集成测试，不在 CI 默认消耗额度。
