# FireFly RAG 与记忆系统详细设计

> 状态：分析与编码设计阶段。本文定义目标边界、核心模型、接口和实现顺序，不代表当前代码已经实现。

## 1. 系统定位

FireFly 的 RAG 不应只是 `向量召回 + BM25 + RRF + Rerank`，而应建设为 **Knowledge & Memory Fabric**：

```text
原始证据
→ 记忆捕获
→ 结构化与聚合
→ 多类型索引
→ 权限感知检索
→ 确定性计算
→ EvidencePack 上下文组装
→ Agent 生成
→ 反馈、压缩与遗忘
```

三个边界必须分开：

- **RAG 检索**负责寻找相关证据。
- **记忆系统**负责所有权、生命周期、压缩、冲突和遗忘。
- **结构化查询**负责计数、去重、时间比较、关系和状态判断。

模型理解“用户想问什么”，SQL/图查询完成确定性计算，RAG 提供可引用的原始证据。

## 2. 目标与非目标

### 2.1 目标

- 支持公共、租户、Agent 私有、用户私有和会话记忆。
- 支持原始记忆到结构化事实、语义记忆和程序性经验的生命周期。
- 支持文本、代码、表格、图片、PDF、音频和视频。
- 支持稀疏、稠密、事件、图、时间和多模态检索。
- 支持确定性聚合、多跳检索、证据充分性判断和引用。
- 支持访问频率、时间衰减、情感/业务强度、独特性等多层压缩。
- 从写入、索引、检索到输出全程执行权限和安全策略。

### 2.2 非目标

- 不把向量数据库作为事实状态源。
- 不让模型从若干 Chunk 中自行完成重要计数和金额计算。
- 不把 Agent 的全部对话原样永久保存。
- 不允许检索文档中的指令改变系统或工具权限。
- 不在 MVP 同时引入图数据库和所有多模态模型。

## 3. 总体组件

### 3.1 写入面

| 组件 | 职责 |
|---|---|
| Capture API | 接收用户、Agent、文档、日志和多模态资产 |
| Capture Policy | 判断是否允许记忆、Scope、敏感级别、保留期和用户同意 |
| Raw Evidence Store | 保存不可变原始内容、Hash、版本和来源 |
| Normalizer | 解析格式、清洗、语言检测、OCR、ASR、代码/表格抽取 |
| Segmenter | 按文档结构和模态生成 Parent/Child Chunk |
| Structurer | 抽取实体、事件、事实、时间、关系和业务主键 |
| Consolidator | 去重、冲突检测、滚动摘要和记忆合并 |
| Index Builder | 写稀疏、向量、实体、事件、关系、摘要和多模态索引 |

### 3.2 查询面

| 组件 | 职责 |
|---|---|
| Retrieval Gateway | 统一检索入口和审计边界 |
| Auth/Policy Gate | 在查询前构造强制 Scope 和 ACL 过滤器 |
| Query Understanding | 意图、实体、时间范围、聚合需求和子问题 |
| Query Planner | 选择检索器、过滤、依赖和执行顺序 |
| Retrievers | BM25、Vector、SQL、Graph、Temporal、Multimodal |
| Fusion | RRF 或分数校准、去重、来源多样性 |
| Evidence Expander | Parent、Neighbor、Entity、Temporal 和 Region 扩展 |
| Aggregator | COUNT DISTINCT、GROUP BY、时间比较、状态机和业务规则 |
| Reranker | 相关性、可信度、新鲜度、独特性和来源多样性排序 |
| Sufficiency Gate | 检查覆盖度、冲突、置信度和引用完整性 |
| Context Composer | 在 Token 预算内产生结构化 `EvidencePack` |

## 4. 记忆分类模型

记忆分类使用三个正交维度，禁止把它们压成一个 `type` 字段。

### 4.1 所有权与可见范围 Scope

| Scope | 所有者 | 默认读取者 | 示例 |
|---|---|---|---|
| `public` | 平台 | 所有授权主体 | 公共规范、公开案例 |
| `tenant` | 组织/项目 | 同租户授权用户和 Agent | 团队代码规范、内部故障 |
| `agent_private` | Agent 能力身份 | 指定 Agent/能力 | Reviewer 的审查经验 |
| `user_private` | 用户 | 用户及被明确授权 Agent | 用户偏好、个人经历 |
| `session` | 会话/任务 | 当前任务参与者 | 临时推理上下文 |

`agent_private` 表示检索隔离，不表示不可审计。是否允许管理员审计、用户导出和删除，由数据治理策略决定。

### 4.2 成熟阶段 Stage

```text
raw -> episodic -> structured -> semantic -> procedural -> archived
```

- `raw`：不可变原始证据。
- `episodic`：按会话、任务或时间段整理的情景记忆。
- `structured`：实体、事件、事实、关系和标准时间。
- `semantic`：跨情景稳定事实、主题和偏好。
- `procedural`：可复用规则、成功方案和失败教训。
- `archived`：不参与常规召回的冷数据或 Tombstone。

### 4.3 内容种类 Kind

建议至少包括：

```text
document | conversation | fact | event | preference | procedure
observation | finding | change_case | failure_case | media | summary
```

## 5. 核心数据模型

### 5.1 MemoryRecord

```json
{
  "memory_id": "mem_01",
  "tenant_id": "tenant_01",
  "owner_type": "user",
  "owner_id": "user_01",
  "scope": "user_private",
  "allowed_agents": ["assistant.general"],
  "stage": "episodic",
  "kind": "event",
  "content": "2026 年 5 月用户前往美国参加会议",
  "content_hash": "sha256:...",
  "source_refs": ["artifact://conversation/session_12#turn_18"],
  "confidence": 0.92,
  "sensitivity": "private",
  "retention_policy": "user_memory_default",
  "valid_time": {"from": "2026-05-10", "to": "2026-05-14"},
  "system_time": {"created_at": "2026-08-04T00:00:00Z"},
  "status": "active",
  "version": 1
}
```

### 5.2 EvidenceRef

```json
{
  "evidence_id": "ev_01",
  "artifact_uri": "s3://firefly-private/user_01/trip.pdf",
  "artifact_hash": "sha256:...",
  "mime_type": "application/pdf",
  "locator": {"page": 3, "bbox": [120, 220, 680, 440]},
  "extractor": "pdf-layout@2.1.0",
  "trust_level": "user_provided",
  "acl_id": "acl_01"
}
```

音视频使用 `start_ms/end_ms/speaker_id/scene_id`；代码使用 `commit/path/symbol/start_line/end_line`。

### 5.3 StructuredEvent

```json
{
  "event_id": "event_trip_01",
  "tenant_id": "tenant_01",
  "subject_id": "user_01",
  "event_type": "travel",
  "object": {"country_code": "US", "purpose": "conference"},
  "occurred_from": "2026-05-10",
  "occurred_to": "2026-05-14",
  "dedupe_key": "travel:user_01:US:2026-05-10",
  "source_memory_ids": ["mem_01"],
  "confidence": 0.92,
  "conflict_status": "none"
}
```

涉及“几次”“最近一次”“按月份汇总”的问题，优先查询这个结构，而不是要求 LLM 数 Chunk。

### 5.4 Chunk

每个 Chunk 必须具有：

```text
chunk_id / document_id / document_version / parent_id
ordinal / content / content_hash / token_count
scope / acl_id / sensitivity
source_locator / entities / valid_time
embedding_model / embedding_version / indexed_at
```

### 5.5 MemorySummary

摘要不是覆盖原文，而是新的派生记录：

```text
summary_id / level / topic / period
summary_text / source_memory_ids
model / prompt_version / confidence
contradictions / created_at / expires_at
```

## 6. 状态与任务

写入状态机：

```text
captured -> normalized -> structured -> indexed -> consolidated -> active
                        \-> quarantined
active -> archived -> deleted
```

删除必须传播到原始资产、Chunk、向量、摘要、缓存和派生事实。不能只删除 PostgreSQL 主记录。

异步任务建议包括：

- `NormalizeMemoryTask`
- `ExtractStructureTask`
- `BuildIndexTask`
- `ConsolidateMemoryTask`
- `RecompressMemoryTask`
- `DeleteMemoryCascadeTask`
- `ReindexEmbeddingVersionTask`

## 7. 聚合索引与确定性计算

### 7.1 为什么需要聚合层

单纯召回多个 Chunk 后让模型归纳，存在重复计数、时间混淆、遗漏、来源冲突和上下文截断。以下问题必须优先走结构化计算：

- 次数、总量、均值、最大最小值。
- 首次、最近一次、某个时间窗口。
- 去重后的事件数。
- 状态机是否合法、两个版本是否一致。
- 实体之间的多跳关系和依赖路径。

### 7.2 写入时聚合

- 文档级摘要、章节级摘要和主题摘要。
- 用户/Agent 的滚动时间线。
- 实体画像，但每个字段保留事实来源和有效时间。
- 高频查询的日/周/月 Rollup。
- Agent 成功案例、失败案例按工具、版本和问题类型聚合。

写入时聚合用于降低查询成本，但不能代替原始事实。

### 7.3 查询时聚合

Query Planner 输出显式计划：

```json
{
  "intent": "count_events",
  "entity": {"type": "user", "id": "user_01"},
  "event_type": "travel",
  "filters": {"country_code": "US"},
  "aggregation": {"op": "count_distinct", "field": "trip_id"},
  "evidence_limit": 20
}
```

Aggregator 只执行 allowlist 中的只读 SQL/Graph 模板，模型不得生成任意生产 SQL。结果必须同时返回聚合值、参与计算的 ID、排除原因和证据引用。

### 7.4 冲突处理

- 相同 `dedupe_key` 且内容一致：合并来源，提高置信度。
- 相同主语/谓词/有效时间但对象冲突：两条都保留，标记 `conflict`。
- 新来源不能直接覆盖高可信旧事实。
- 回答时展示冲突或请求澄清，不能由 LLM 静默选择。

## 8. 多层记忆压缩

### 8.1 重要性信号

```text
F = log-scaled access frequency with cap
R = exp(-age / half_life(memory_kind))
S = emotional or business salience
U = semantic uniqueness and rare-entity score
V = verified utility in successful/failed tasks
C = source confidence and conflict penalty
```

逻辑表达式：

```text
importance = policy_override(scope, sensitivity, legal_hold)
             * calibrated(F, R, S, U, V, C)
```

不建议直接把六项固定线性相加。不同 Kind 使用不同校准模型：身份和支付事实不能因为时间久就自动删除；用户短期偏好可以较快衰减；Agent 失败经验应随代码和工具版本失效。

### 8.2 信号约束

- 访问频率使用对数缩放并设上限，防止错误记忆因重复访问被强化。
- 情感强度不能覆盖隐私、同意和保留期限。
- 独特性根据近邻距离、稀有实体和新关系计算。
- Utility 必须绑定最终 Outcome，不能用 Agent 自评代替。
- 冲突、低可信和来源不明会降低进入语义记忆的资格，但原始证据可保留。

### 8.3 压缩层级

| 层 | 内容 | 操作 |
|---|---|---|
| L0 Raw | 近期完整证据 | 热存储、严格权限、短期高可用 |
| L1 Episodic | 会话/任务/时间段 | 去重、事件化、保留关键细节 |
| L2 Thematic | 主题、时间线、状态 | 滚动摘要并回链 L1/L0 |
| L3 Semantic/Procedural | 稳定事实、偏好、规则、经验 | 高复用、小上下文 |
| L4 Archive | 低频或合规数据 | 冷存储或 Tombstone |

### 8.4 压缩任务触发

- Token 或记录数超过窗口阈值。
- 一个主题在时间窗口内不再活跃。
- 访问模式从热变冷。
- 新事实导致旧摘要过期或冲突。
- 用户主动要求整理、导出或遗忘。
- Agent/代码/模型版本变化使经验需要重新评估。

压缩结果必须记录来源集合、压缩算法/模型、Prompt 版本、前后 Token、置信度和信息损失评估。

## 9. 检索执行流程

### 9.1 Pipeline

```text
1. Authenticate and authorize
2. Preserve original query
3. Detect intent, entities, time, modality and aggregation
4. Build QueryPlan and mandatory filters
5. Route to selected retrievers in parallel
6. Fuse and calibrate scores
7. Recheck ACL, dedupe, scan poisoning/injection
8. Expand parent/neighbor/entity/time/region evidence
9. Execute deterministic aggregation
10. Rerank for relevance, trust, freshness and diversity
11. Check evidence sufficiency and conflicts
12. Re-plan, clarify, or compose EvidencePack
13. Generate with citations
14. Capture feedback under write policy
```

### 9.2 Query 改写原则

- 原始 Query 永久保留，改写作为派生字段。
- 多意图问题拆成子问题和依赖 DAG。
- 查询改写不能扩大用户权限和 Scope。
- 为专有名词、代码符号保留 exact query，同时生成 semantic query。
- 时间表达标准化时保留原表达和时区。

### 9.3 Fusion 与排序

MVP 可保留 RRF，但要按检索器独立 rank 计算，不能把两个列表拼接后用同一个全局 rank。

最终排序可以考虑：

```text
retrieval relevance
* authorization validity
* source trust
* freshness for time-sensitive facts
* memory importance
* diversity penalty
* contradiction penalty
```

`failure_case` 不应永久固定乘 `1.5`。权重应与目标软件版本、工具版本、问题类型和案例验证结果相关。

### 9.4 EvidencePack

Agent 不直接接收散乱 Chunk，而接收统一证据包：

```json
{
  "schema_version": 1,
  "query_id": "q_01",
  "original_query": "用户去过几次美国？",
  "status": "sufficient",
  "plan": {
    "schema_version": 1,
    "query_id": "q_01",
    "intent": "count_events",
    "structured_query_required": true,
    "answer_source": "structured_plus_evidence",
    "stages": ["structured", "lexical", "temporal"],
    "candidate_k": 24,
    "fusion_k": 40,
    "rerank_k": 16,
    "context_k": 8,
    "min_context_k": 3,
    "max_context_tokens": 1400,
    "score_floor": 0.35,
    "marginal_gain_floor": 0.02,
    "evidence_coverage_target": 0.95
  },
  "structured_result": {
    "value": 3,
    "operation": "count_distinct",
    "included_ids": ["trip_1", "trip_2", "trip_3"],
    "excluded_reasons": [],
    "conflicts": []
  },
  "evidence": [
    {
      "evidence_id": "evidence_trip_1",
      "untrusted_content": "用户在来源材料中描述了该次旅行。",
      "score": 0.92,
      "source_type": "memory_event",
      "entity_keys": ["trip_1"],
      "citation": {
        "artifact_id": "artifact_trip_1",
        "uri": "s3://firefly-private/user_01/trip_1.json",
        "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }
    },
    {
      "evidence_id": "evidence_trip_2",
      "untrusted_content": "第二次旅行的授权来源证据。",
      "score": 0.88,
      "source_type": "memory_event",
      "entity_keys": ["trip_2"],
      "citation": {
        "artifact_id": "artifact_trip_2",
        "uri": "s3://firefly-private/user_01/trip_2.json",
        "digest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      }
    },
    {
      "evidence_id": "evidence_trip_3",
      "untrusted_content": "第三次旅行的授权来源证据。",
      "score": 0.84,
      "source_type": "memory_event",
      "entity_keys": ["trip_3"],
      "citation": {
        "artifact_id": "artifact_trip_3",
        "uri": "s3://firefly-private/user_01/trip_3.json",
        "digest": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
      }
    }
  ],
  "conflicts": [],
  "coverage": 1,
  "citation_required": true,
  "allowed_usage": "answer_current_user_only",
  "generation_allowed": true,
  "trace": {
    "retrievers": [
      {"id": "lexical_primary", "stage": "lexical", "returned": 3, "failed": false}
    ],
    "fused": 3,
    "authorized": 3,
    "denied": 0,
    "selected": 3,
    "stop_reason": "exhausted"
  }
}
```

`QueryPlan`、`EvidenceCitation`、`StructuredResult`、`EvidenceItem` 和 `EvidencePack` 的 v1 TypeScript 类型与 JSON Schema 统一定义在 `packages/contracts`。`packages/retrieval-service` 在返回前执行 `assertContract("EvidencePack", pack)`；未来拆成独立服务后，生产者出站和消费者入站都必须校验，不能因为消息来自内部网络就跳过。

合同层的强制不变量包括：证据不足时禁止生成；有冲突时禁止放行；结构化计划必须返回确定性结果；结构化参与 ID 不可重复；每条引用必须绑定不可变 SHA-256 Digest。外层与内层 `query_id` 一致性由 Gateway 构造保证，跨系统接收独立 `QueryPlan` 时还应执行语义一致性校验。

### 9.5 动态 TopK 与证据停止规则

TopK 不采用单一固定值。检索规划器输出四个独立参数：

```text
candidate_k -> fusion_k -> rerank_k -> context_k
```

`candidate_k` 是每路 Retriever 的候选上限，`fusion_k` 是融合后的候选上限，`rerank_k` 是重排输入规模，`context_k` 是最终送入 Agent 的证据数量。四者必须分开记录，不能把最终上下文数量反推为召回数量。

规划器根据意图、Agent、实体数量、可用 Token 和证据覆盖目标动态计算 K，并设置 `min_context_k`、`score_floor`、`marginal_gain_floor` 与 `max_context_tokens`。ACL 过滤发生在候选进入上下文之前；同一来源、同一实体的重复 Chunk 会被多样性规则降权或跳过。

聚合、比较、多跳和时间问题必须设置 `structured_query_required=true`。Aggregator 负责完整计算次数、去重、时间窗口和关系路径，RAG 只返回参与计算的原始证据。普通事实查询在达到最低证据量后，如果候选分数低于阈值或边际收益不足，应提前停止；不能为了填满固定 K 引入低质量片段。

当前动态 K 计算位于 `packages/retrieval-planner`，它不直接执行 SQL、向量搜索或模型调用。`packages/retrieval-service` 为内部计划补上 `schema_version` 和 `query_id`，形成可审计、可跨进程传输的 `QueryPlan`。

## 10. 文档分块

### 10.1 按类型分块

| 内容 | 分块单位 |
|---|---|
| Markdown/Word | 标题层级、段落、列表、附录 |
| PDF | 布局块、章节、表格、图片区域和页码 |
| 代码 | 模块、类、方法、接口、AST 节点 |
| 表格 | 表头 + 行组 + 单元格坐标，另建结构化表 |
| 对话 | 话题、事件、说话人和时间窗口 |
| 日志 | Trace、请求、异常链和时间窗口 |
| 音频 | 说话人轮次、语义段和时间码 |
| 视频 | 场景、镜头、字幕和时间码 |

### 10.2 Parent-Child 多粒度

- Child Chunk 小而精，用于召回。
- Parent Section 补充完整语义与定义域。
- Document/Topic Summary 用于粗粒度路由。
- Entity/Event 索引用于确定性查询。

Overlap 根据句法和语义跨界决定，不采用固定字符比例。列表、代码块和表格不能在关键结构中间截断。

当前 M5.3 已为 Markdown 落地 `MarkdownParentChildChunker`。它按标题层级维护 `structure_path`，每个章节生成一个 Parent，再把章节正文按预算生成一个或多个 Child；Child 的检索文本包含受长度约束的标题路径，避免标题关键词只存在于 Parent 而无法召回。Child 通过 `parent_chunk_id` 引用同一 Memory、同一索引版本内的 Parent。稳定 Chunk ID 仍由文档身份、ordinal 和内容决定，Citation Locator 额外保存 `section_path`、`chunk_level`、`section_part` 与 `chunk_part`。PlainText Chunker 仅作为兼容模式保留，不能代表 PDF、代码、表格和多模态结构化分块已经完成。

M5.8 已补齐三类结构化 Chunker：`PdfLayoutChunker` 消费页码、布局块、标题层级、bbox 和 region 标识；`CodeAstChunker` 消费语言、AST 节点、符号路径和起止行；`TableStructureChunker` 消费 sheet/table、表头、行组和列坐标。三者复用 Parent/Child 合同，Parent 只保存上下文、Child 才参与召回和 Embedding，Citation Locator 保留原始结构坐标。缺少 parser output 时默认返回不可重试的 `STRUCTURED_SOURCE_MISSING`；只有显式 `fallback_mode=degraded` 才退回纯文本，并写入降级标记，禁止静默伪装成结构化结果。

M5.9 已补齐 `ConversationTurnChunker`：按稳定 sequence 排序并保留 turn、speaker、role 和时间范围；Parent 保存连续对话窗口，Child 以轮次为优先边界参与召回，超长单轮才在轮次内部拆分。严格/降级策略与其他结构化 Chunker 一致，降级结果不声明虚假的说话人或时间结构。

解析器接入通过 `ParserBackedIndexSourcePort` 完成：它按 `source_type` 选择 `IndexSourceParserPort`，校验 typed `IndexStructuredSource`，保留 Source 顺序并记录 `parser-missing`、`parser-failed` 或 `parser-invalid-output`。`parser_failure_mode=strict` 默认阻断构建；显式 `degraded` 才把原文交给 Chunker 的降级路径。Worker 不绑定 PDF/OCR、AST、表格或转录的第三方实现。

降级索引还受独立激活策略约束：`allow_degraded_build` 控制是否允许完成降级构建，`allow_degraded_activation` 控制是否允许自动激活；两者默认关闭。即使允许构建，未单独授权激活也会记录 `DEGRADED_INDEX_ACTIVATION_NOT_ALLOWED` 并阻断 active 切换。

索引与查询遵循不对称职责：Parent 不生成 Embedding，也不进入 FTS/pgvector 候选；只有 Child 用于精确召回。Ready Gate 要求每个文档至少有一个 Child、父子引用闭合、Parent 不携带 Embedding，且每个 Parent 至少拥有一个 Child。Indexer 在写入 Child 前校验其 Parent 属于同一 Memory 和同一索引版本，禁止通过父引用跨越授权或版本边界。

运行时扩展顺序固定为：

```text
Child recall -> fusion -> Child ACL -> evidence selection
-> Parent expansion -> active/tenant/Memory ACL recheck
-> token budget -> EvidencePack
```

扩展发生在候选融合、Child 授权和动态选证据之后，避免先扩展造成上下文膨胀。多个 Child 指向同一 Parent 时只加入一次；Parent 超过剩余上下文预算时保留已授权 Child，而不是截断 Parent 或突破预算。扩展器返回的 Evidence ID 必须保持不可变，Gateway 对 Parent 再次授权并拒绝任何超预算、身份冲突或越权结果。

### 10.3 受治理的证据上下文扩展

Parent/Child 只是结构关系，不应成为唯一扩展机制。已选择的 Child 或事实证据可以沿四类显式关系补充上下文：`region` 用于 PDF/表格/图像区域，`neighbor` 用于相邻 Chunk 或对话轮次，`entity` 用于同一实体或概念，`temporal` 用于前后事件与时间窗口。默认优先级为 `region -> neighbor -> entity -> temporal`。

扩展器只接收已授权锚点，不执行开放式二次检索。候选按关系优先级、score 降序、Evidence ID 升序稳定排序，然后按每个 anchor 上限截断并按 ID 去重。相同 Evidence ID 的 content、citation URI 或 digest 不一致时立即 fail closed。

```text
Child/fact recall -> fusion -> initial ACL -> dynamic evidence selection
-> deterministic relation expansion -> final ACL/active-index check
-> immutable citation validation -> max_context_tokens -> EvidencePack
```

Gateway 先保留初始证据的 token 预算，再把候选逐个放入剩余预算；放不下的候选跳过，不能截断证据或突破预算。扩展器支持 `AbortSignal`，取消时不返回可生成的半成品。扩展 TopK 因此是动态 token 预算下的候选上限，而不是固定送入模型的切片数量。

### 10.4 版本与重建

- `document_id` 稳定，`document_version` 随内容变化。
- Chunk ID 建议基于文档版本、结构路径和内容 Hash。
- Embedding 模型版本独立记录，换模型时建立新索引并双读验证。
- 删除或更新文档时，通过 lineage 找到所有派生 Chunk、摘要和事实。

当前实现把该建议收敛为显式状态机：

```text
IndexBuildTask -> building -> ready -> active -> retired
                              \-> failed
```

`retrieval_index_version` 保存租户、逻辑索引名、Provider、配置 Digest、来源水位以及 Embedding 模型/维度。Indexer 只向 `building` 或明确允许增量写入的 `active` 版本写 Chunk，并校验租户与 Embedding 快照完全一致。重建期间查询仍只读旧 active 版本；`RetrievalIndexRepository.activate` 在同一事务中退役旧版本并激活新版本，数据库唯一约束保证每个 `tenant_id + logical_name` 最多一个 active。私有内容只读取查询者租户的 active 版本；显式 `public` 内容可读取其所属租户的 active 版本。未绑定版本的历史 Chunk 不参与查询，必须重建后才能重新可见。

M5.6 把 retired 版本回收定义为“清理可重建投影，保留审计元数据”。迁移 011 增加 `purged_at` 和 `retrieval_index_retention_hold`；评测、事故、法务或审计流程必须用稳定 reference 注册 hold，可设置过期时间或显式释放。Collector 仅选择超过保留期、`status = retired`、尚未清理且没有有效 hold 的版本；事务内使用 `FOR UPDATE SKIP LOCKED`、再次复核 hold、删除该版本 `memory_chunk`、写入 `purged_at` 并产生确定性的 `RetrievalIndexPurged` Outbox 事件。版本行、原始 chunk count、构建身份、来源水位、配置 Digest 和质量报告均保留。hold 注册同样锁定版本行，已清理版本拒绝新增 hold，从而关闭“审计引用与 GC 同时发生”的竞态。

上线前的 Ready Gate 不能只看“任务成功”。`DefaultIndexReadyGate` 校验非空文档、每文档至少一个 Chunk、Chunk ID 唯一和 Embedding 形状一致。`AdvancedIndexReadyGate` 在此基础上强制配置来源水位、ACL、Recall、Citation 四类 Probe；缺失、重复、非法分数或任一低于阈值都 fail closed。双读用于验证，不直接把两版结果混入用户上下文；正式流量仍由单一 active 指针决定。

`packages/memory-workers` 已实现 `RetrievalIndexBuildWorker`：它按事件类型领取带租约的 `RetrievalIndexBuildRequested`，通过 `IndexSourcePort` 加载来源、确定性分块、仅为可召回 Child 调用独立 `EmbeddingPort`、幂等写入版本绑定 Chunk，通过 Ready Gate 后完成并可原子激活。每次门禁生成版本化 `IndexQualityReport`，记录五类检查的 score、threshold、sample size、摘要和证据引用，并与 build ID、index version、source watermark 和 configuration Digest 绑定；PostgreSQL 持久化报告，Repository 拒绝身份不匹配或结果状态矛盾的报告。Worker 重启时按持久状态恢复：`building` 继续构建，`ready` 只补激活，`active/retired` 视为完成，`failed` 不重复构建。可重试故障指数退避，超过 attempt 上限后把版本和 Outbox 事件置为可审计终态。

`SourceWatermarkQualityProbe` 已提供真实水位比较逻辑。M5.4 新增版本化 `IndexEvaluationSet`：每个用例固定 lexical 查询、查询主体、允许召回 Memory、禁止泄露 Memory、预期 Citation、TopK 和三项阈值，规范化内容必须与 `artifact_ref.digest` 一致。`FixedIndexEvaluationRunner` 只执行一次数据集，ACL、Recall、Citation Probe 共享结果并分别计分，质量报告引用同一不可变评测集 Artifact。

`PostgresBuildingIndexQualityEvaluator` 是门禁专用读取通道：它要求版本仍为 `building`，并逐项核对 task 的 index version、tenant、logical name、configuration Digest 和 source watermark；查询复用真实 Memory ACL，但不修改正常 Retriever 的 active-only 约束。Lexical 用 FTS，vector 用绑定模型/维度的 cosine，hybrid 对归一化 lexical 与 vector 分数做确定性 50/50 融合；vector/hybrid 用例必须把 query embedding 和模型快照写入固定评测集 Digest。版本激活后该通道拒绝读取。真实集成已覆盖三种阶段的 building 版本授权、私有 Memory 不泄露和结构化 Citation 精确匹配；生产 ANN、重排和延迟质量仍需单独评估。

## 11. 多模态设计

### 11.1 三层表示

1. 原始 Asset：对象存储保存图片、PDF、音频和视频。
2. 派生特征：OCR、ASR、Caption、对象、表格、场景、说话人。
3. 检索索引：文本向量、图像向量、音频/视频向量和结构化 Locator。

### 11.2 定位信息

- 图片/PDF：`page + bbox + region_id`。
- 音频：`start_ms + end_ms + speaker_id`。
- 视频：`start_ms + end_ms + scene_id + frame_refs`。
- 表格：`sheet/table + row + column + header_path`。

### 11.3 检索与生成

- 文本 Query 可以召回 Caption、OCR 和跨模态向量。
- 图片 Query 可以检索相似图片及关联文本。
- 多路结果使用 Late Fusion，避免强行统一不可比较的原始分数。
- 关键证据在回答前由多模态模型重新读取原始区域，不能只依赖 Caption。

## 12. 安全边界

### 12.1 身份与隔离

- 每次检索必须携带 `tenant_id`、主体身份、Agent 身份、Purpose 和 Trace。
- 公共、租户、用户私有和 Agent 私有至少逻辑分区；高敏租户使用独立集合和加密密钥。
- ACL/ABAC 在检索服务端生成强制过滤器，调用方不能删除或放宽。
- 返回 EvidencePack 前再次授权，防止索引错误和缓存串租户。
- 缓存键必须包含租户、主体、权限版本、Scope 和 QueryPlan Hash。

### 12.2 Prompt Injection

- 检索内容一律标记为不可信证据，不拼入 System Prompt。
- 文档中的“忽略此前指令”“调用某工具”等内容不得转化为控制指令。
- Context Composer 分离 `instructions`、`evidence` 和 `user_data` 通道。
- 高风险内容经过注入检测；命中后可降权、隔离或只允许引用。
- 模型输出的 Tool Call 仍需 Agent Policy 和 Tool Schema 二次授权。

### 12.3 数据投毒

- 记录来源、签名、导入者、提取器和变换版本。
- 新来源先进入 quarantine，经过格式、恶意内容和可信度检查后发布。
- 多来源一致不能简单等同真实，要避免同一错误内容的复制放大。
- Agent 生成的经验必须绑定 VerificationReport 和 Outcome，不能仅凭自述进入高可信知识库。

### 12.4 隐私与删除

- 对 PII、凭据、支付信息和健康信息做分类与 DLP。
- 用户私有记忆区分显式保存和推断候选；敏感推断默认不持久化。
- 支持查询、导出、纠正、禁用和删除个人记忆。
- 删除传播到对象、数据库、Chunk、向量、摘要、缓存和训练/评测派生集。
- Embedding、摘要和访问日志继承原始数据的敏感级别。

当前 PostgreSQL 切片中，`deleteMemory` 在一个事务内完成 Memory tombstone、`memory_chunk` 清理、依赖 `structured_event` 失效、本地删除回执和 Outbox 写入。对 `object_store`、`external_lexical`、`external_vector`、`multimodal_index`、`cache`、`summary`、`evaluation` 等明确目标，每个目标都有独立任务和 `pending/failed/completed` 状态。

消费者必须返回版本化 `DeletionPropagationAck`。Ack 以 `ack_id` 幂等，attempt 必须单调递增；失败可由更高 attempt 重试为完成，旧 attempt 或内容冲突拒绝。任一目标失败时全局状态为 failed，仍有待处理目标时为 pending，只有所有目标完成才写入 `propagation_completed_at` 并发出 `MemoryDeletionPropagationCompleted`。因此“本地回执 != 全局删除完成”。

当前 `DeletionPropagationWorker` 按 `payload.target` 定向领取任务，不允许不同目标的消费者互相抢占。`ObjectStoreDeletionConsumer` 使用任务中的 `ArtifactRef` 定位并去重 `s3://bucket/key`，由官方 AWS S3 SDK 删除 MinIO/S3 对象；缺少对象引用时 fail closed。Provider 删除失败才写 failed Ack 并退避重试；Ack、数据库或 `markPublished` 失败不伪装成 Provider 失败。若 completed Ack 已提交但发布标记失败，重放识别目标已完成后只补发布。超过 attempt 上限的事件进入 discarded 终态，`reconcileFailedDeletionTargets` 对超时 failed 目标加行锁复核并创建幂等的新任务。

M5.5 的 `DeletionReconciliationScheduler` 已把上述修复函数接入周期运行层。`runOnce` 合并同一实例内的并发调用；多实例同时扫描时仍由目标行锁、failed 状态复核和确定性 Outbox ID 防止重复副作用。每个周期记录 scheduler/instance/cycle 身份、stale cutoff、batch limit、重排数量、起止时间和失败摘要；Observer 故障只增加本地计数，不反写已经发生的数据库事实。`run(AbortSignal)` 在失败周期后继续等待下一次 tick，并在取消后不再开启新周期。迁移 012 增加 `maintenance_cycle` 持久化账本，reconciliation 与 retired-index GC 均按 cycle_id 幂等写入；账本故障只增加 `ledger_failures`，不改变维护事实。部署级指标后端、告警规则和 Provider 删除证据真实性核验仍待实现。

### 12.5 模型边界

- 检索 Policy 输出允许的 Provider、地域和数据脱敏方式。
- 高敏证据禁止发送到未批准的云模型。
- Model Gateway 记录证据分类，但不长期保存敏感原文。
- 任何模型不得获得超出当前 Agent Task 的额外记忆范围。

## 13. API 草案

### 13.1 写入

```text
POST /v1/memories/capture
POST /v1/artifacts
POST /v1/memories/{id}/consolidate
POST /v1/memories/{id}/archive
DELETE /v1/memories/{id}
GET /v1/memories/{id}/lineage
```

`capture` 请求必须显式提供或由服务端确定：Owner、Scope、Purpose、Sensitivity、Retention、Source 和是否获得用户同意。

### 13.2 检索

```text
POST /v1/retrieval/query
POST /v1/retrieval/plan
POST /v1/retrieval/feedback
GET  /v1/retrieval/{query_id}/trace
```

`RetrievalRequest`：

```json
{
  "query": "用户去过几次美国？",
  "principal": {
    "tenant_id": "tenant_01",
    "user_id": "user_01",
    "agent_id": "assistant.general"
  },
  "purpose": "answer_user",
  "allowed_scopes": ["public", "user_private"],
  "time_range": null,
  "modalities": ["text", "image"],
  "max_evidence": 20,
  "token_budget": 6000,
  "require_citations": true
}
```

### 13.3 管理

```text
POST /v1/indexes/rebuild
GET  /v1/indexes/versions
POST /v1/compression/run
GET  /v1/security/audit
GET  /v1/memory-policies
PUT  /v1/memory-policies/{id}
```

## 14. 存储映射

MVP 建议：

| 数据 | 存储 |
|---|---|
| Memory 元数据、ACL、Lineage、Fact、Event | PostgreSQL |
| 原始文档和多模态 Asset | MinIO/S3 |
| BM25 与精确检索 | Elasticsearch |
| Dense/Multimodal Vector | Milvus；小规模也可先用 pgvector |
| Relation Graph | MVP 用 PostgreSQL `relation_edge`，复杂后再评估图数据库 |
| 异步任务和索引事件 | Outbox/Inbox + MQ |
| 热查询缓存 | Redis，必须权限感知且非事实源 |

当前可运行基线使用同一 PostgreSQL 实例中的 `memory_chunk`：生成列 `tsvector` 提供全文检索，可选 `vector` 列提供按 Embedding 模型与维度路由的精确余弦检索。`ts_rank_cd` 是 PostgreSQL FTS 排序，不等于 BM25；只有接入 Elasticsearch、OpenSearch 或 ParadeDB 对应 Retriever 后才能宣称 BM25 已落地。变量维度向量暂不建立共享 HNSW，生产阶段应按模型与维度分区后再创建 ANN 索引。

建议增加的核心表：

```text
memory_record
memory_acl
memory_lineage
memory_access_stat
memory_summary
structured_fact
structured_event
memory_chunk
retrieval_index_version
memory_deletion_receipt
memory_deletion_target
relation_edge
artifact
artifact_region
index_version
retrieval_trace
retrieval_feedback
deletion_job
```

## 15. 代码模块建议

```text
rag-memory/
├─ contracts/
│  ├─ memory-record.schema.json
│  ├─ retrieval-request.schema.json
│  ├─ query-plan.schema.json
│  └─ evidence-pack.schema.json
├─ capture-service/
│  ├─ policy/
│  ├─ normalizers/
│  ├─ segmenters/
│  └─ multimodal/
├─ consolidation-service/
│  ├─ entity-event-extractor/
│  ├─ deduplicator/
│  ├─ conflict-resolver/
│  ├─ summarizer/
│  └─ importance-scorer/
├─ indexing-service/
│  ├─ sparse/
│  ├─ dense/
│  ├─ entity-event/
│  └─ graph/
├─ retrieval-service/
│  ├─ auth/
│  ├─ query-planner/
│  ├─ retrievers/
│  ├─ fusion/
│  ├─ aggregator/
│  ├─ reranker/
│  ├─ sufficiency/
│  └─ context-composer/
└─ memory-governance/
   ├─ retention/
   ├─ compression/
   ├─ deletion/
   └─ audit/
```

这些模块初期可在一个服务内实现，但包边界和契约必须独立，以便后续拆分。

当前代码映射：`packages/retrieval-postgres` 是 PostgreSQL 适配器，负责版本绑定的幂等 Chunk 索引、只读 active 版本的 FTS/pgvector Retriever 和最终 ACL Authorization Port；`packages/retrieval-service` 仍保持 Provider 中立；索引构建/激活、删除事实、逐目标 Ack 与 Outbox 由 `packages/persistence` 所有；`packages/memory-workers` 负责可恢复索引构建、Ready Gate、目标定向删除消费和 S3/MinIO 适配器。

## 16. 测试策略

### 16.1 正确性

- 重复事件不会被重复计数。
- 跨时区时间范围正确。
- Parent/Child 扩展不引入无权限内容。
- 文档更新和删除能清理所有派生索引。
- 冲突事实不会被静默覆盖。
- RRF 输入顺序、去重和来源多样性符合预期。

### 16.2 安全

- 跨租户、跨用户、跨 Agent 私有空间检索全部失败。
- 缓存不能返回旧权限下的结果。
- 恶意文档中的 Prompt Injection 不触发工具。
- 删除后原始资产、向量、摘要和缓存均不可检索。
- 敏感内容不会被路由到不允许的 Provider。

### 16.3 检索质量

- 建立带标准答案和标准 Evidence ID 的评测集。
- 分别评估 Recall@K、MRR/nDCG、Evidence Coverage、Citation Precision。
- 聚合题额外评估 Exact Match 和参与计算的事件集合。
- 记录每个检索阶段的增益，防止 Rerank 掩盖召回缺陷。

### 16.4 压缩质量

- Fact Preservation：关键事实保留率。
- Contradiction Preservation：冲突是否仍可见。
- Provenance Coverage：摘要句是否能回链来源。
- Compression Ratio：Token 或存储压缩率。
- Downstream Utility：压缩前后任务质量变化。

## 17. 分阶段实现

### R0：契约与单租户文本闭环

当前已落地的 R0/M5 基础切片：

- `packages/retrieval-planner` 输出动态 `candidate_k`、`fusion_k`、`rerank_k` 和 `context_k`，并区分结构化聚合问题与普通 RAG 问题。
- `questlab.memory_record`、`questlab.memory_acl` 和 `questlab.structured_event` 已进入 PostgreSQL 事实层。
- `MemoryRepository.listReadable` 执行 Scope/Owner/ACL 过滤；`recordEvent` 拒绝来源记忆到事件 Scope 的权限扩大；`aggregateReadableEvents` 返回确定性去重计数和参与计算的事件 ID。
- `packages/retrieval-service` 已实现并行 Retriever 端口、独立列表 RRF、融合后 ACL 复检、不可变 Evidence ID 校验、动态证据选择和 `EvidencePack` 充分性门禁；结构化意图缺少 Aggregator 时 fail closed。
- `packages/contracts` 已提供版本化 `QueryPlan`、`EvidenceCitation`、`StructuredResult`、`EvidenceItem` 与 `EvidencePack` v1 Schema；Gateway 在出站前强制运行时校验。
- `questlab.memory_chunk`、`packages/retrieval-postgres` 和 Model Gateway `EmbeddingPort` 已形成真实 PostgreSQL FTS + pgvector 混合检索；召回前和融合后分别执行 ACL。
- `MemoryRepository.deleteMemory` 已实现 owner/delete-ACL 授权、本地 Chunk 清理、来源事件失效、幂等删除回执与 Outbox 传播事件。
- `IndexBuildTask/Result`、`RetrievalIndexRepository` 与 `retrieval_index_version` 已实现索引构建快照、Ready Gate 输入、Chunk 版本绑定和单 active 原子切换。
- `DeletionPropagationTask/Ack` 与 `memory_deletion_target` 已实现 allowlist 目标扇出、逐目标失败重试和全局完成判定。
- `packages/memory-workers` 已实现租约式索引构建 Worker、基础 Ready Gate、Embedding 维度校验和崩溃恢复。
- `IndexQualityReport`、迁移 009 和 `AdvancedIndexReadyGate` 已实现五类质量检查的强制装配、阈值判定、不可变身份绑定和 PostgreSQL 审计持久化。
- 对象存储删除消费者已通过官方 AWS S3 SDK 接入真实 MinIO；目标定向领取、指数退避、attempt 耗尽终态及 failed 目标 reconciliation 已通过 PostgreSQL/MinIO 集成测试。
- 迁移 010、`MarkdownParentChildChunker` 与 `PostgresParentChildExpander` 已实现 Markdown Parent/Child 分块：只召回 Child、Parent 无 Embedding、父引用受 Memory/索引版本约束、扩展后重新授权、共享 Parent 去重，并在 Parent 超预算时回退 Child。
- `IndexEvaluationSet`、固定评测 Runner、ACL/Recall/Citation Probe 与 `PostgresBuildingIndexQualityEvaluator` 已实现 digest-bound lexical/vector/hybrid 质量评测；真实集成在 building 版本上验证三种阶段的授权、召回和 Citation，激活后评测旁路关闭。
- `DeletionReconciliationScheduler` 与独立进程入口已实现周期扫描、同实例 tick 合并、失败继续、结构化周期观测和 AbortSignal 停止；真实 PostgreSQL 集成已验证 failed 目标经 scheduler 重排后被恢复 Worker 完成。
- 迁移 011、显式 retention hold 与 `RetiredIndexGarbageCollector` 已实现带保留期的 retired 投影回收；真实 PostgreSQL 集成已验证 active、未到期和审计 hold 均阻断清理，释放 hold 后仅删除到期 Chunk，并保留版本证据与幂等 Outbox 事实。

尚未完成：生产 BM25 Provider、按模型/维度分区的 pgvector ANN、持久化调度账本与部署告警、外部索引 Provider 的 retired 数据清理、其他删除目标 Provider、Provider 证据核验和多模态派生索引。Neighbor/Entity/Temporal/Region 的确定性策略与 PostgreSQL 候选源边界已完成，生产 Graph/时间线/布局 Provider 仍待接入。

- 下一批优先接入真实 PDF/OCR、代码解析器、表格解析器和转录 Provider，再接生产 BM25/ANN Provider 与外部索引回收。
- PostgreSQL 保存元数据、ACL、Fact/Event 和 Lineage。
- MinIO 保存原文，ES + 当前向量库完成文本检索。
- 已以 Markdown 验证 Parent/Child、RRF、确定性 Count 聚合和引用闭环；其他内容类型按相同合同逐个接入。

### R1：用户与 Agent 长期记忆

- 加入 Purpose、同意、保留期，并把其他跨存储删除目标接到真实消费者和统一 reconciliation 调度。
- 实现 raw -> episodic -> structured 生命周期。
- 增加访问统计、滚动摘要和冲突检测。

### R2：高级检索

- Query Planner、多查询、多跳 DAG、Temporal/Graph 检索。
- Evidence Sufficiency Gate 和自动重规划。
- 版本相关的 failure/success case 权重。

### R3：多层压缩

- 实现 Frequency、Recency、Salience、Uniqueness、Utility、Confidence 信号。
- 按 Kind 配置半衰期和压缩策略。
- 增加 Archive、Tombstone 和重建任务。

### R4：多模态

- PDF Layout/OCR、ASR、图片区域和视频场景抽取。
- 多模态向量、Late Fusion 和原始区域复核。

### R5：高安全与规模化

- 高敏租户物理隔离、独立密钥、审计与 DLP。
- 在已有版本原子激活、在线构建 Worker 和本地旧版回收基础上补齐自动回滚、外部 Provider 回收和容量治理。

## 18. 首个验收用例

使用“用户去过几次美国”作为最小聚合记忆用例：

1. 三次旅行分别来自对话、PDF 和照片，多模态证据具有不同时间。
2. 同一次旅行在对话和照片中重复出现，Structurer 生成相同 `trip_id/dedupe_key`。
3. Query Planner 识别 `count_distinct(trip_id)`。
4. SQL 返回 3，RAG 返回三次旅行的授权证据。
5. 用户无权访问的团队旅行记录不得进入聚合值或引用。
6. 删除其中一段用户记忆后，事实、向量、摘要、缓存和计数结果同步更新。
7. 回答展示确定性结果和每次旅行的来源，不让模型自行计数。

该用例能同时验证聚合索引、用户记忆、去重、权限、多模态、引用和删除传播。

## 19. QuestLab 业务映射

QuestLab 产品定义见 [FireFly-QuestLab产品与三Agent详细设计.md](./FireFly-QuestLab产品与三Agent详细设计.md)。Knowledge & Memory Fabric 在该业务中承担四类责任：

### 19.1 知识与记忆

| 空间 | 内容 |
|---|---|
| public | 教材、论文、开放课程标准、公共数据集 |
| tenant | 学校课程、教师材料、班级规则、校本案例 |
| agent_private | 教学策略经验、插件失败模式、代码修复案例 |
| user_private | 目标、能力证据、错误概念、作品、偏好、授权反馈 |
| session | 当前 Mission、临时假设、未确认情绪或困难推断 |

### 19.2 结构化事件

```text
LearningAttempt
ConceptEvidence
HintConsumed
AssessmentOutcome
MasteryRevision
MisconceptionOccurrence
StrategyExposure
PluginExposure
DelayedRetentionOutcome
TransferOutcome
```

涉及次数、效果差异和版本比较的问题必须走 Aggregator。例如：

```text
某学习者在没有提示的情况下独立证明能量关系几次？
solar-energy@1.2.0 与 1.3.0 的错误概念发生率差异是多少？
某教学策略是否只提高即时测验，而没有改善 7 天保持率？
```

### 19.3 业务检索路径

```text
学习问题或 Agent Task
→ Consent/Scope 过滤
→ 识别 Concept、Learner、Mission、PluginVersion 和时间范围
→ 并行检索教材、教师材料、用户证据、事件和插件经验
→ 结构化聚合 Mastery/Misconception/Exposure/Outcome
→ Parent/Temporal/Artifact 扩展
→ Evidence Sufficiency
→ Learning Director / Scientist / Engineer 专用 EvidencePack
```

三个 Agent 使用不同的 Context Policy：Learning Director 只读取当前学习决策需要的用户记忆；Learning Scientist 优先读取去标识化事件和评测证据；Experience Engineer 默认看 Finding、插件、测试和匿名失败案例，不能读取不必要的用户私有原文。

### 19.4 QuestLab 验收用例

“太阳能模拟器导致恒定输出错误概念”作为业务验收：

1. 文本解释、手写计算、模拟器轨迹和语音反思形成多模态 Evidence。
2. Structurer 将证据映射到 `physics.energy.power` 和 `constant_solar_output`。
3. Aggregator 按 `learner_id + misconception + plugin_version` 去重计数。
4. Learning Scientist 获得群体级去标识化 EvidencePack，不读取无关用户原文。
5. Experience Engineer 只获得插件版本、Finding、失败轨迹摘要和测试制品。
6. 插件升级后比较即时掌握、7 天保持和迁移任务。
7. 用户删除某作品后，其原始资产、派生文本、事实、向量、摘要和后续聚合全部更新。

该用例与通用“旅行次数”用例互补：前者验证 QuestLab 业务闭环，后者验证用户长期记忆的通用确定性聚合。
