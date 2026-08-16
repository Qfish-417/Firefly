# FireFly 本地轻量运行说明

本地完成标准不是模拟生产集群，而是在普通开发电脑上保留核心业务闭环、确定性事实和安全边界。`questlab-lite.yml` 常驻只运行 PostgreSQL 与 Retrieval API；迁移容器完成后退出。默认不启动 MinIO、索引/删除 Worker、Docker Sandbox、OCR/ASR、Embedding 或 Reranker。

## 启动与停止

```powershell
npm run lite:up
Invoke-RestMethod http://127.0.0.1:53200/health
npm run lite:down
```

`lite:down` 不删除数据库卷，用户记忆和结构化事实可以跨重启保留。确实需要清空本地数据时，应先确认目标项目，再显式执行：

```powershell
docker compose -p firefly-questlab-lite -f infra/compose/questlab-lite.yml down --volumes
```

默认端口为 PostgreSQL `55432`、Retrieval API `53200`。轻量栈与完整开发栈使用相同端口，不能同时启动。

## 可接受的显式降级

| 能力 | 本地默认 | 可选增强 | 影响 |
|---|---|---|---|
| 词法检索 | PostgreSQL FTS | 外部 BM25 Retriever | 排序质量可能较低，接口和 ACL 不变 |
| 向量检索 | 关闭 | 配置 `EMBEDDING_*` 后使用 pgvector 精确检索 | 关闭时不宣告 vector stage，避免伪装能力 |
| ANN/HNSW | 不要求 | 未来按模型/维度分区 | 小数据集精确检索更省运维，延迟随数据量增长 |
| 重排 | 关闭 | 配置 `RERANK_*` | 关闭或可重试故障时保留确定性 RRF 顺序 |
| 多模态 | 文本优先 | 外部 OCR/ASR | 只有显式 degraded 标记才允许纯文本替代，不伪造坐标/说话人 |
| 三 Agent 模型 | Stub 或文本模型 | pi-ai 多模型 generate/stream | Stub 仍走相同 Task/Event/Artifact 与治理状态机 |
| 对象存储与 Worker | 不常驻 | 完整开发栈 MinIO/Worker | 本地轻量栈不宣称验证外部删除完成语义 |
| Docker Sandbox | 按需测试 | 完整 Engineer 发布验证 | 未运行时不得产生“Sandbox 已通过”的证据 |

## 不允许降级的边界

- PostgreSQL 仍是任务、事件、记忆、结构化事实和治理状态的唯一事实源。
- Memory ACL 必须在检索、聚合、重排前和证据扩展后执行。
- count、comparison、temporal、multi-hop 仍必须来自结构化事实，不能改由 TopK 文本猜测。
- Loop Sentinel 的 hop、epoch、去重、风暴和预算限制不能关闭。
- Citation Digest、冲突暴露、预算以及人工审批不能因设备性能而跳过。
- 未启动的外部服务必须显示为 unavailable、skipped 或 degraded，不能记录为成功。

## 何时切换完整开发栈

只有在验证对象删除、索引构建、真实 PostgreSQL/S3 集成或 Engineer Sandbox 发布时，才按需运行 `infra/compose/questlab-dev.yml`。BM25、ANN 和外部多模态服务属于部署增强，不是本地功能闭环的完成条件。
