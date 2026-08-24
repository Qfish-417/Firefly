# FireFly 最小降级本地档（min profile）

本档是 `questlab-lite.yml` 的进一步降级版本，不替代它。目标是在资源最紧的机器上、甚至离线状态下，仍然跑通基本功能闭环：持久化事实层、三 Agent 人工审批闭环、受治理检索边界与只读审计视图。

与 lite 档的区别只有一条：**容器里只留 PostgreSQL**。迁移、三 Agent 闭环、Retrieval API、Admin API 都作为宿主 Node 进程运行。

| 项目 | lite 档 | min 档 |
|---|---|---|
| 常驻容器 | PostgreSQL + Retrieval API | 只有 PostgreSQL |
| 镜像构建 | 需要构建 runtime 镜像并在容器内 `npm ci` | 不构建，`pgvector/pgvector:pg17` 即可 |
| 离线启动 | 首次需要联网 | 镜像已缓存时可完全离线 |
| PostgreSQL 端口 | 55432 | 55433 |
| Retrieval API | 容器，53200 | 宿主进程，53201 |
| Admin API | 手动启动，3100 | 宿主进程，3101 |
| 端口绑定 | `0.0.0.0` | 仅 `127.0.0.1` |
| Compose project | `firefly-questlab-lite` | `firefly-questlab-min` |
| 数据卷 | `questlab-lite-postgres` | `questlab-min-postgres` |

端口、project 名和卷都独立，所以 min 档可以和 lite / dev 档并存，本地数据也不互相污染。

## 文件

- `infra/compose/questlab-min.yml`：只含一个受资源限制的 PostgreSQL 服务。
- `infra/compose/questlab-min.env.example`：入库的模板。其中的 Token 与 HMAC Secret 是公开的开发占位值。
- `infra/compose/questlab-min.env`：实际使用的宿主进程配置，供 `node --env-file` 读取。`.gitignore` 里的 `*.env` 覆盖它，不会入库。

首次使用先从模板复制：

```powershell
Copy-Item infra\compose\questlab-min.env.example infra\compose\questlab-min.env
```

Admin API 默认要求 `ADMIN_API_TOKEN`。只在本机回环场景下，可以用 `ADMIN_ALLOW_UNAUTHENTICATED=true` 显式放开，此时启动日志会记录 `authenticated: false`。

进程环境变量优先级高于 env 文件，需要覆盖时直接设置即可：

```powershell
$env:RETRIEVAL_API_TOKEN = "..."
```

## 启动

```powershell
cd D:\桌面\整理\学习\FireFly

npm run min:config      # 干跑校验，不启动任何东西
npm run min:up          # 启动 PostgreSQL
npm run min:ps          # 等到 STATUS 出现 (healthy)
npm run min:migrate     # 应用 16 个迁移，包含 vector 扩展
```

## 三 Agent 闭环

```powershell
npm run min:demo:start -- --run-id run.min.001
```

命令会创建任务、产生 Learning Scientist 发现与改进计划，然后停在人工审批边界，输出 `approval_id` 和 `plan_id`。确认后用明确身份和理由恢复：

```powershell
npm run min:demo:approve -- --run-id run.min.001 --approver local.user --reason "reviewed locally"
```

期望结果：`state: learned`、`task_count: 5`、`transition_count: 9`、`verification_status: passed`。使用确定性 Stub Agent，不调用真实模型，不自动批准，不伪造 Sandbox 证据。

## 检索 API 与审计视图

各用一个终端：

```powershell
npm run min:retrieval
Invoke-RestMethod http://127.0.0.1:53201/health      # status=ok, service=retrieval
```

```powershell
npm run min:admin
Invoke-RestMethod http://127.0.0.1:3101/admin/evolution-runs/run.min.001
```

Retrieval 的 `POST /retrieval` 需要 Bearer Token 加 HMAC 身份头，缺任一项返回 401。`/health` 不需要认证。

## 停止

```powershell
npm run min:down
```

宿主进程用 Ctrl-C 停止。`min:down` 保留命名卷，记忆和结构化事实跨重启保留。确认要清空本地数据时再显式执行：

```powershell
docker compose -p firefly-questlab-min -f infra/compose/questlab-min.yml down --volumes
```

## 本档的显式降级

默认关闭：MinIO 与对象存储、索引/删除 Worker、删除 reconciliation 与 retired 索引 GC、Docker Sandbox、OCR/ASR、Embedding 与向量检索、Reranker、真实模型调用。

检索只宣告 PostgreSQL FTS 词法能力，不宣告 vector 与 rerank 阶段。需要开启 Embedding 或 Reranker 时按 ADR 0036 / ADR 0041 补齐完整变量组，缺项会 fail closed。未启动的能力必须报告为 unavailable / skipped / degraded，不得产生成功证据。

## 本档同样不降级的边界

沿用 ADR 0042 的约束，不因设备性能放宽：

- PostgreSQL 仍是任务、事件、记忆、结构化事实和治理状态的唯一事实源。
- Memory ACL 必须在检索、聚合、重排前和证据扩展后执行。
- count、comparison、temporal、multi-hop 仍必须来自结构化事实，不能改由 TopK 文本猜测。
- Loop Sentinel 的 hop、epoch、去重、风暴和预算限制不能关闭。
- Citation Digest、冲突暴露、预算以及人工审批不能跳过。

## 何时升级到 lite 或 dev 档

需要验证容器化 Retrieval API 部署形态时用 lite 档；需要验证对象删除、索引构建、S3 集成或 Engineer Sandbox 发布时用 `questlab-dev.yml`。
