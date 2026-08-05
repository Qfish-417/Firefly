# FireFly QuestLab 工具系统详细设计

> 状态：v2 编码设计。本文定义五类工具、发现、异步执行、动态加载、权限和 KV Cache 策略。

## 1. 设计目标

工具系统采用：

```text
Capability Registry
+ Discovery
+ Policy Engine
+ Tool Broker
+ Durable Tool Run
+ Adapter / Sandbox
```

五类目录帮助 Agent 理解和发现工具，但不能单靠分类完成安全调度。每个工具还必须声明输入输出、执行模式、副作用、风险、权限、幂等、取消、资源锁和兼容版本。

## 2. 五类工具

### 2.1 感知 Perception

只读环境并返回证据：

```text
learner.profile.read
mastery.query
learning.events.query
memory.retrieve
knowledge.search
artifact.inspect
plugin.manifest.read
plugin.diff.read
metric.query
trace.query
multimodal.inspect
```

### 2.2 执行 Action

产生状态或制品变更：

```text
mission.activate
hint.issue
assessment.start
review.schedule
memory.write/delete
plugin.patch
test.run
replay.run
artifact.build
plugin.canary
plugin.rollback
```

执行工具必须有幂等键和补偿策略。高风险工具不直接授权给模型。

### 2.3 协作 Collaboration

```text
task.create/claim/cancel/handoff
capability.delegate
teacher.handoff
peer.session.request
review.request
artifact.publish
workflow.checkpoint
result.submit
event.publish
```

协作工具传递结构化 Task 与 Artifact Ref，不传递完整聊天历史。

### 2.4 用户沟通 User Communication

```text
clarification.ask
feedback.explain
progress.present
approval.request
notification.publish
report.render
```

审批和普通通知必须分离。未响应的审批停留在 `awaiting_approval`，不能默认通过。

### 2.5 事件触发 Event Trigger

事件触发主要是控制面能力，而不是普通模型工具：

```text
ArtifactSubmitted
AssessmentCompleted
LearnerStuckDetected
DelayedReviewDue
TeacherFeedbackReceived
LearningFindingCreated
PluginCanaryDegraded
Cron / Webhook / MQ / Git Event
```

可以暴露 `trigger.register`、`schedule.create` 等管理工具，但监听、去重、重试和任务创建由控制面执行。

## 3. ToolDescriptor

```json
{
  "tool_id": "test.run",
  "version": "2.1.0",
  "provider_id": "sandbox-runner",
  "primary_category": "action",
  "capabilities": ["typescript.test", "coverage.report"],
  "subjects": ["physics", "general"],
  "modalities": ["code", "text"],
  "input_schema_ref": "schema://TestRunRequest.v2",
  "output_schema_ref": "schema://TestRunResult.v2",
  "schema_hash": "sha256:...",
  "execution_mode": "async",
  "side_effect": "sandbox_only",
  "idempotent": true,
  "cancelable": true,
  "checkpointable": false,
  "timeout_sec": 900,
  "risk_level": "A2",
  "permissions": ["sandbox:execute", "artifact:write"],
  "resource_locks": ["worktree:${change_id}"],
  "cost_class": "medium",
  "compatibility": {"plugin_sdk": ">=1.0 <2.0"},
  "status": "active",
  "publisher": "firefly.platform",
  "signature": "sig:..."
}
```

分类、标签和语义描述用于发现；Schema、权限和兼容性用于确定性过滤。

## 4. 架构组件

| 组件 | 职责 |
|---|---|
| Tool Registry | Descriptor、版本、Provider、健康和生命周期 |
| Capability Search | 分类、标签、BM25/向量查找候选能力 |
| Policy Engine | Agent、用户、Purpose、风险、同意和预算授权 |
| Tool Broker | 路由、版本固定、幂等、锁、重试、取消和审计 |
| Durable Run Store | 长任务状态、进度、checkpoint 和结果引用 |
| Adapter | HTTP/gRPC/MCP/本地沙箱协议适配 |
| Credential Broker | 签发任务级短期凭据，不向模型暴露 Secret |
| Artifact Store | 大输入输出、日志、报告和制品 |

Agent 不直接连接生产工具 Provider，所有调用经过 Tool Broker。

## 5. 工具发现

### 5.1 Bootstrap 工具

每个 Agent 只常驻少量稳定工具：

```text
tool.search
tool.describe
tool.invoke
tool.status
tool.cancel
artifact.read
```

### 5.2 发现流程

```text
Task 目标与约束
→ 提取 Required Capability
→ Registry 按租户、状态、风险、权限预过滤
→ 类别/标签/BM25/向量检索
→ Schema、模态、学科、版本兼容性过滤
→ Broker 按健康、成本、时延排序
→ 返回 3-8 个候选摘要
→ Agent 选择或工作流指定
→ tool.describe 加载完整 Schema
→ Policy 签发 Tool Lease
→ tool.invoke
```

关键流程由工作流指定 Capability，模型只能从合规实现中选择，不能自行决定跳过验证或改用低安全工具。

### 5.3 ToolSearchRequest

```json
{
  "query": "验证太阳能模拟器并生成覆盖率报告",
  "required_capabilities": ["typescript.test", "physics.invariant", "coverage.report"],
  "execution_modes": ["async"],
  "max_risk": "A2",
  "environment": "sandbox",
  "subject": "physics",
  "principal": {
    "tenant_id": "school_01",
    "agent_id": "experience-engineer"
  },
  "limit": 5
}
```

## 6. 同步、异步与流式

| 模式 | 场景 | 返回 |
|---|---|---|
| Sync | 状态读取、短查询、Schema 校验、工具发现 | 直接结果 |
| Async | 多模态、Replay、构建、测试、Canary、压缩 | `operation_id` |
| Stream | Agent 对话、日志、进度、长报告 | Cursor 事件流 |

### 6.1 异步协议

```text
tool.invoke
→ accepted(operation_id, tool_snapshot, estimated_deadline)
→ ToolRunQueued
→ ToolRunStarted
→ ToolRunProgress
→ ToolRunSucceeded / ToolRunFailed / ToolRunCanceled
```

接口：

```text
POST /v1/tool-runs
GET  /v1/tool-runs/{operation_id}
POST /v1/tool-runs/{operation_id}/cancel
GET  /v1/tool-runs/{operation_id}/events?after_cursor=...
```

状态机：

```text
accepted -> queued -> running -> succeeded
                           ├-> failed
                           ├-> cancel_requested -> canceled
                           └-> timed_out
```

长任务必须由 Durable Run Store 和 Worker Lease 承载，不能依赖进程内线程。

## 7. 幂等、重试与资源锁

- 调用方提供 `idempotency_key`，Broker 保存请求 Hash 与最终结果。
- 相同 Key、相同请求返回已有 Run；相同 Key、不同请求直接拒绝。
- 只对声明可重试的错误执行指数退避。
- 具有副作用的工具必须声明补偿动作或明确 `non_compensatable`。
- worktree、Plugin Version、Mission、Learner State 等资源使用显式锁键。
- 传输采用 at-least-once，业务幂等实现可观察的 exactly-once 效果。

## 8. 动态加载

动态加载的对象是 Descriptor、Schema 和远程代理，不是未知代码进入 Agent 进程。

### 8.1 Provider 生命周期

```text
registered -> verified -> active -> draining -> retired
                         \-> unhealthy / quarantined
```

工具发布要求：

- 可信发布者与签名。
- 权限 Manifest 和网络策略。
- 版本化 Schema 与兼容性声明。
- 健康检查、并发上限和租约。
- 测试、SBOM、漏洞与 License 检查。
- 回滚版本和下线 draining。

### 8.2 Snapshot

一次 Agent Task 创建 `tool_snapshot`：

```json
{
  "snapshot_id": "toolsnap_01",
  "tools": [
    {"tool_id": "test.run", "version": "2.1.0", "schema_hash": "sha256:..."},
    {"tool_id": "artifact.build", "version": "1.4.2", "schema_hash": "sha256:..."}
  ],
  "policy_version": "policy@8",
  "expires_at": "2026-08-04T12:00:00Z"
}
```

任务恢复和审计必须使用同一 Snapshot。安全撤销可以提前使 Lease 失效，但不能静默换成不兼容版本。

## 9. KV Cache 与上下文

模型请求中的工具列表、顺序、描述或 Schema 变化会改变前缀，降低 KV/Prompt Cache 命中率，并增加选错工具的概率。

建议上下文布局：

```text
稳定前缀
├─ System Policy
├─ Agent Identity
├─ Task/Event Contract
└─ Bootstrap Tool Schema

动态后缀
├─ 当前 Task
├─ 检索出的 3-8 个完整 Tool Schema
├─ EvidencePack
└─ Tool Result / Artifact Ref
```

策略：

1. Bootstrap 工具及顺序保持稳定。
2. 不向模型注入全量工具目录。
3. Descriptor 和 Schema 使用规范化 JSON 与固定字段顺序。
4. 一次任务内固定 Tool Snapshot。
5. 健康、价格、动态负载保留在 Broker，不写入模型 Schema。
6. 规划阶段只加载搜索/描述工具，执行阶段只加载当前步骤需要的工具。
7. 大结果写 Artifact Store，上下文只放摘要、Hash 和引用。
8. Schema 或权限版本变化时主动失效缓存，不能为了命中继续使用旧权限。
9. 尽量保持同类 Agent 的稳定工具集合和模型亲和性。

## 10. QuestLab 三 Agent 工具边界

### 10.1 Learning Director

可读：学习者授权档案、Mastery、Mission、当前证据、课程和允许插件。

可写：Mission 建议、Hint、Assessment Request、Review Schedule、Teacher Handoff。

禁止：Plugin Patch、生产发布、修改 Rubric、修改 Consent、读取其他学习者私有记忆。

### 10.2 Learning Scientist

可读：去标识化学习事件、评测、插件暴露、群体统计和授权个体证据。

可写：LearningFinding、EvaluationReport、Experiment Recommendation。

禁止：直接修改 Mastery 事实、Mission 状态、Plugin 和评测基线。

### 10.3 Experience Engineer

可读：Approved ImprovementPlan、插件源码、SDK、测试、匿名失败轨迹和 Finding EvidencePack。

可写：worktree、ChangeSet、测试、Artifact、Review Response。

禁止：用户私有原文、生产发布、Rubric/Policy/Consent 修改和自批准。

## 11. 数据表

```text
tool_descriptor
tool_provider
tool_capability
tool_schema
tool_health
tool_policy_binding
tool_lease
tool_snapshot
tool_run
tool_run_event
tool_idempotency
tool_resource_lock
tool_audit
```

## 12. API 与事件

```text
POST /v1/tools/search
GET  /v1/tools/{tool_id}/versions/{version}
POST /v1/tool-leases
POST /v1/tool-runs
GET  /v1/tool-runs/{operation_id}
POST /v1/tool-runs/{operation_id}/cancel
GET  /v1/tool-runs/{operation_id}/events
POST /v1/providers/register
POST /v1/providers/{id}/drain
```

事件：

```text
ToolRegistered
ToolVersionActivated
ToolLeaseIssued
ToolRunQueued
ToolRunStarted
ToolRunProgressed
ToolRunSucceeded
ToolRunFailed
ToolRunCanceled
ToolProviderUnhealthy
ToolVersionRetired
```

## 13. 代码模块

```text
tool-system/
├─ contracts/
├─ registry/
├─ discovery/
├─ policy/
├─ broker/
├─ durable-runs/
├─ credential-broker/
├─ adapters/
│  ├─ http/
│  ├─ grpc/
│  ├─ mcp/
│  └─ sandbox/
├─ providers/
└─ audit/
```

MVP 可在 Control Plane 中以模块化单体实现，但 Registry、Broker、Run Store 和 Adapter 必须保持接口边界。

## 14. 测试与安全

- 未授权 Agent 搜索不到高风险工具。
- `tool.describe` 不能绕过 Search/Policy 获取隐藏 Schema。
- 重复 invoke 不产生重复副作用。
- Worker 失联后 Lease 到期，任务可安全续跑或进入人工处理。
- 取消和超时释放资源锁与短期凭据。
- Provider 下线时已有 Snapshot 可完成或明确失败，不能静默换版本。
- 恶意工具描述不能注入 System Prompt。
- Tool Result 视为不可信数据，进入模型前执行 DLP 和注入检测。
- Sandbox 无默认生产网络和文件权限。
- 审计能关联 Task、Agent、Tool Lease、Run、Artifact 和 Outcome。

## 15. 实现顺序

### T0：静态 Registry

- 实现 Descriptor Schema、五类目录、Search/Describe。
- 迁移少量只读感知工具和固定学习 Runtime 工具。

### T1：Tool Broker

- 加入 Policy、Tool Lease、幂等、权限和审计。
- 所有 Agent 禁止直接调用 Provider。

### T2：Durable Async

- 实现 Run 状态机、Worker Lease、进度、取消和 Artifact Result。
- 迁移多模态、Replay、Test、Build 和 Canary。

### T3：动态 Provider 与插件

- 签名注册、健康、版本、Snapshot、Draining 和 Sandbox。
- Agent 使用 search -> describe -> lease -> invoke 流程。

### T4：缓存与规模化

- 规范化 Schema、Prompt Cache 指标、Provider 路由、配额和成本治理。
- 用实际数据验证工具精简是否提高选择准确率和缓存命中率。
