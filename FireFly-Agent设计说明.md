# FireFly 教育买课平台 — 自进化 Agent 详细设计（v4 · 三 Agent 分章细化）

> **状态：Legacy Prototype v0。** 本文保留用于追溯早期“买课/秒杀”方案，不再作为后续编码依据。QuestLab v2 的业务源文档为 [FireFly-QuestLab产品与三Agent详细设计.md](./FireFly-QuestLab产品与三Agent详细设计.md)，总体架构、构建路线、RAG/记忆设计分别见 `FireFly-开放式架构分析.md`、`FireFly-目标架构构建文档.md`、`FireFly-RAG与记忆系统设计.md`。

> 业务：**教育买课平台（含秒杀）**。
> 三 Agent 微服务：**主力 Java / 侦察 Python / 升级 Python** + 各自子 Agent，单机 Docker Compose 起步。
> 本文档为编码级设计，后续写代码以此为准。drawio 架构图（10 page）保持不变，本文是对每个 agent 内部的编码级展开。

---

## 〇、系统定位：长程智能体

### 0.1 这是什么类型的系统

FireFly 本质是一个**多智能体协作的长程自进化系统**。

长程智能体（Long-running Agent）的核心特征是：**持续常驻运行、跨长时间跨度多步规划、记忆与状态持久化、环境感知与反馈驱动、人在回路兜底、自我改进闭环**。FireFly 不是"跑完一个任务就结束"的一次性 agent，而是"持续运营、越跑越聪明"的系统级长程智能体。

### 0.2 长程智能体特征 vs FireFly 落地

| 长程智能体特征 | FireFly 落地 |
|---|---|
| 持续常驻运行 | 三 Agent 微服务常驻：主力扛流量、侦察盯指标、升级按清单/事件触发 |
| 跨长时间跨度多步规划 | 侦察发现退化→入队 pending→管理员排期→DAG 并行执行→灰度观察→固化/回滚，闭环跨小时到天 |
| 记忆与状态持久化 | 中心经验库（Milvus+ES 双路 RAG）存 failure_case/success_case；upgrade_plan 表、improvement 表、业务状态机 |
| 环境感知与反馈驱动 | 侦察每分钟拉日志、跑 p99/超卖率/下单成功率，指标退化才推改进点，非定时盲改 |
| 人在回路兜底 | 阶段性升级清单需管理员排期；L3 代码升级强制完整 CI+灰度+观察窗口；仅重大生产事故走紧急直通 |
| 自我改进闭环 | 主力产出→侦察评估→升级改码→新版本回主力，经典 act→observe→reflect→improve 循环 |

### 0.3 两种"长程"的区分

长程性体现在两个层面，需区分（面试易被追问）：

- **任务级长程**：单个 agent 跑一个跨度几小时的复杂任务。FireFly 中**单次升级流水线**属于此类（CI+灰度+观察窗口，小时级）。
- **系统级长程**：整个自进化闭环**无限循环**，跨多个升级周期持续积累经验。FireFly 主体是这一类——不是"跑完一个任务就结束"，而是"持续运营、越跑越聪明"。

精确表述：**FireFly 是系统级长程的自进化智能体系统，其内部每个升级周期又是一个任务级长程流程**。三层结构（图引擎调度层 > Loop 节点执行层 > 工具层）正好对应"系统级编排 > 任务级执行 > 原子操作"。

### 0.4 长程性对设计的三个关键约束

既然是长程，有三个咽喉必须在设计中抓住：

1. **记忆是咽喉** → RAG 八环 + 混合检索（向量+BM25+RRF）+ 数据闭环，failure_case 权重×1.5。长程系统没有记忆就是"金鱼"，每次从零开始。
2. **评估基线是锚** → 7 维度评分体系（详见侦察 Agent）。长程系统容易"漂移"，没有客观评分就无法判断"升级是真改进还是自嗨"。
3. **不能无人值守狂奔** → 升级清单驱动而非实时触发，L3 强制人在回路，紧急直通仅限重大生产事故。长程智能体最大的风险是"自主性失控"。

> 一句话总结：**FireFly 是多智能体协作的长程自进化系统，长程性体现在系统级无限循环 + 任务级升级流水线两个层面，靠 RAG 记忆、评分基线、清单驱动三件套来约束长程带来的漂移和失控风险。**

---

## 一、业务定义

### 1.1 业务是什么
FireFly 是一个在线课程交易平台，支持课程展示、秒杀抢购、下单支付、订单管理、学习进度。**平台自身的接口代码由三个 Agent 协作生成、监控、自升级**。

- 最终用户：学员（买课、学习）
- 平台运营方：业务方，向 Agent 系统提接口需求（如"加一个拼团接口"）
- Agent 系统：自动生成 / 上线 / 运维平台接口

### 1.2 五大业务域与三 Agent 落点

| 域 | 核心功能 | 技术挑战 | 主力落点 | 侦察落点 | 升级落点 |
|---|---|---|---|---|---|
| 课程域 | 课程 CRUD、分类、详情、ES 搜索 | ES 同步一致性 | 生成课程接口 | 盯搜索准确率 | 优化 ES 同步 |
| 营销域 | **秒杀**、优惠券、拼团 | 高并发、超卖、限流、缓存、MQ 削峰 | 生成秒杀接口+Sentinel 限流 | 盯秒杀 p99/超卖率 | 优化库存扣减策略 |
| 交易域 | 下单、支付、订单状态机、退款 | 分布式事务、幂等、超时关单 | 生成订单/支付接口 | 盯下单成功率/回调延迟 | 优化事务一致性 |
| 用户域 | 注册登录(JWT)、鉴权、RBAC | Token 安全 | 生成用户接口 | 盯异常登录 | 优化鉴权 |
| 内容域 | 评价、学习进度 | 进度一致性 | 生成评价接口 | 盯评价合规 | 优化进度同步 |

### 1.3 为什么是这个业务
秒杀库存从"DB 直扣(超卖)"→"Redis 预扣+MQ 异步落库(防超卖)"→"+内存标记"是典型自升级路径，能走完整 CI+灰度+回滚——升级 Agent 有真实活干。且 Spring Boot 做电商是 Java 主场，技术栈天然对齐。

---

## 二、业务向 Agent 设计思路（为什么主力不能照搬侦察/升级）

### 2.1 两种 Agent 形态的根本区别

Agent 系统里有两类完全不同的角色，**主力是业务向 Agent，侦察/升级是工具向 Agent**，设计哲学相反，绝不能套同一套模板：

| 维度 | 业务向 Agent（主力） | 工具向 Agent（侦察/升级） |
|---|---|---|
| **存在理由** | 直接产生业务价值，对外提供服务 | 辅助主链路，不对外 |
| **生命周期** | 长驻、有状态、随业务流量起伏 | 任务驱动、可空闲、可批量 |
| **对外契约** | 有——API 合约、SLA、可用性承诺 | 无——只对内被调 |
| **失败后果** | 直接影响学员买课、支付，P0 | 只影响自进化速度，可容忍 |
| **限流定位** | 自己是限流对象（保护自己不被打爆） | 自己是限流发起方（保护 LLM 成本） |
| **核心矛盾** | 稳定性 vs 迭代速度 | 智能 vs 可控性 |

### 2.2 业务向 Agent（主力）的五条设计原则

1. **对外契约优先**：主力生成的每个接口都有 OpenAPI 契约 + SLA，契约变更必须走版本号（v1/v2），不能静默改。这是业务 agent 的命根子——学员和前端依赖稳定契约。
2. **状态机驱动**：主力内部跑的是订单/秒杀/支付状态机，不是简单的请求-响应。每个状态转换都是幂等点（支付回调幂等、超时关单幂等）。工具向 agent 没有这种业务状态机。
3. **自己是限流对象**：主力生成的秒杀接口必须被 Sentinel 限流，保护下游 DB/Redis。而侦察/升级的限流是保护 LLM 调用成本，方向相反。
4. **迭代走旁路**：主力自己不改自己的源码（自己改自己=没护栏）。迭代交给升级 Agent 在 worktree 里改。主力只负责"跑当前版本 + 暴露指标"。
5. **健康度自报**：主力必须暴露 `/health`、`/metrics`、`/actuator` 端点给侦察拉数据。业务 agent 不暴露指标就是黑盒，自进化无从谈起。

### 2.3 工具向 Agent（侦察/升级）的设计原则

1. **只读优先**：侦察对业务代码只读不写，写只写到经验库。升级能写，但只在 worktree 隔离区写，不碰主力运行时。
2. **任务驱动**：没有常驻业务流量，靠任务看板认领任务（IDLE→WORK→IDLE）。不像主力 7×24 扛流量。
3. **产出结构化**：侦察产出 `improvement` 结构化记录，升级产出 `release` 记录。产出必须是机器可消费的 JSON，不是自由文本。
4. **护栏比功能重要**：升级的回滚/灰度/审批机制，比它"能改码"更重要。工具向 agent 越强大越危险。

---

## 三、三 Agent 角色差异化（为什么三个不可能一样）

这是理解后续详细设计的前提。三个 agent 的**设计基因不同**：

| | 主力（Java） | 侦察（Python） | 升级（Python） |
|---|---|---|---|
| **本质** | 业务编排者 | 观测分析者 | 执行变更者 |
| **对业务数据** | 读写（生成+服务） | **只读**（拉指标/日志） | 改源码（不碰业务数据） |
| **对外** | 是（学员/前端调 API） | 否 | 否 |
| **语言选择理由** | Spring Cloud+Sentinel+Nacos 工程化最强 | LLM/AST/向量生态最顺 | 同侦察，且与侦察共享 RAG/LLM 栈 |
| **核心产物** | 线上接口服务 + 发布单 | 评估分 + 改进点 | 补丁 + 新版本/回滚 |
| **失败模式** | 降级限流、熔断、保活 | 降级采集、延迟评估 | **回滚**（这是它独有的） |
| **子 Agent 用途** | 并行生成分层代码 | 并行分析日志/跑压测 | 审查/观察/回滚（护栏） |
| **while True 循环驱动** | 业务请求 + 定时任务 | 任务看板轮询 | MQ 消费 |
| **限流角色** | 被限流（保护自己） | 发起限流（保护 LLM） | 发起限流（保护 worktree 并发） |

**记住这张表**，下面每个 agent 的详细设计都是从这个差异出发的，不是套同一个模板填空。

---

## 四、主力 Agent（Java）详细设计

### 4.0 角色定位
主力是**业务编排者**：把"接口需求"变成"线上运行的 API 服务"，并 7×24 承接真实学员流量。它是唯一产生业务价值、唯一对外的 agent。它的设计核心是**稳定性 + 契约 + 状态机**，不是"智能"。

### 4.1 功能清单（8 个功能，按业务主线顺序）

#### 功能 1：需求接收与解析
- **做什么**：把业务方提交的自然语言接口需求，变成机器可执行的标准契约。
- **怎么做**：
  1. 业务方通过 Web 控制台提交 `{requirement_text, field_table, sla}`，写入 `interface_requirement` 表，状态=`parsed`
  2. 调 LLM（Prompt 在 Nacos `firefly-main-prompt.yml` 热更）解析需求 → OpenAPI 3.0 规范
  3. SLA 解析成 NFR（非功能需求）：`{qps, latency_p99, consistency_level}`
  4. 解析结果回写 `interface_requirement.openapi_spec` + `nfr`
- **产出结果**：
  - 数据库：`interface_requirement` 记录，含完整 `openapi_spec`（JSON）+ `nfr`
  - 状态机：`status: parsed → generating`
  - 失败产出：3 次解析失败 → 状态 `failed`，生成 `clarification_questions` 回问业务方

#### 功能 2：上下文检索增强（RAG）
- **做什么**：检索相似接口实现、编码规范、历史缺陷案例，作为代码生成的 few-shot 上下文。
- **怎么做**：
  1. `rag_search` 工具，query = 需求文本 + 域标签
  2. 向量库（Milvus）+ BM25 混合召回 Top50 → 连坐召回（命中切片拉父文档）→ Rerank（bge-reranker-v2-m3）Top20
  3. filters 按域过滤：`{domain: seckill, type: [implementation, spec, defect_case]}`
- **产出结果**：
  - `rag_context`：JSON 数组，每项 `{content, score, source, type}`
  - 失败产出：向量库超时 → 降级仅 BM25，写 `degradation_log`

#### 功能 3：代码生成
- **做什么**：生成全套 Spring Boot 代码（Controller/Service/Mapper/DTO/SQL/配置）。
- **怎么做**：
  1. 派发 `codegen_subagent`（task 一次性子 Agent），**按层并行**：4 个子 Agent 分别生成 Controller、Service、Mapper+SQL、DTO+Config
  2. 每个子 Agent 收到 `{openapi_spec 片段, layer_type, rag_context, nfr}`
  3. 主力聚合 4 份产出 → 校验编译（`mvn compile`）→ 算 content_hash → 写 `code_manifest`
- **产出结果**：
  - 文件系统：`/workspaces/{requirement_id}/` 下的全套 `.java` + `mapper.xml` + `schema.sql` + `application.yml`
  - 数据库：`code_manifest` 记录，含 `files[{path, layer, content_hash}]` + `version`
  - 状态机：`status: generating → testing`
  - 失败产出：子 Agent 失败重试 2 次；编译失败 → 回功能 2 补 RAG 上下文重新生成

#### 功能 4：测试生成与门禁
- **做什么**：生成 JUnit5+Mockito 单测，卡覆盖率 ≥ 80% 才放行上线。
- **怎么做**：
  1. 派发 `testgen_subagent`（task），输入 `{files, coverage_target: 0.8}`
  2. 子 Agent 生成测试文件 + 跑 `mvn test` + 收 JaCoCo 覆盖率报告
  3. 主力判断覆盖率：`< 80%` → 退回子 Agent 补测（最多 3 轮）
- **产出结果**：
  - 文件系统：`/workspaces/{requirement_id}/src/test/` 下测试文件
  - `coverage_report`：JSON，`{overall: 0.85, by_class: {...}}`
  - 状态机：达标 → `status: testing → deploying`；3 轮不达标 → `status: failed`，标记技术债，降级目标到 70% 放行但告警

#### 功能 5：服务注册与配置推送
- **做什么**：把新生成的接口服务注册到 Nacos，推送 Sentinel 限流规则。
- **怎么做**：
  1. `nacos_register`：调 Nacos OpenAPI 注册实例 `{service_name, ip, port, metadata:{domain, version}}`
  2. `sentinel_rule_push`：按 API 重要级推流控规则：
     - 秒杀接口：QPS 限流 10000（按 NFR 配）
     - 普通 CRUD：线程数限流 200
     - 支付回调：QPS 限流 500
- **产出结果**：
  - Nacos：新实例注册成功，`instance_id` 返回
  - Sentinel：`rule_id` 返回，规则持久化到 `firefly-sentinel-rules.json`（Nacos 热更）
  - 失败产出：注册失败重试 3 次（指数退避）→ 告警；Sentinel 推送失败 → 本地降级限流 + 告警

#### 功能 6：灰度部署
- **做什么**：把新版本接口灰度上线，从 5% → 50% → 100%。
- **怎么做**：
  1. 派发 `deploy_subagent`（**teammate 持久子 Agent**），因为要跨多轮观察
  2. deploy_subagent 通过收件箱回报每阶段状态：`{pct: 5, healthy: true}`
  3. 每阶段观察 N 分钟（Nacos `firefly-canary-strategy.yml` 配），健康度达标才进下一档
- **产出结果**：
  - 数据库：`release` 记录，`status: 0 → 5 → 50 → 100`，`canary_pct` 实时更新
  - 失败产出：任一阶段健康度不达标 → 自动回滚上一 tag，`status: rolled_back`，通知升级 Agent

#### 功能 7：对外 API 服务（常驻）
- **做什么**：7×24 承接学员真实请求（买课、秒杀、支付、查订单）。
- **怎么做**：
  - Spring Boot 跑生成的 Controller，接 Nacos 注册的流量
  - 订单接口跑状态机（见 4.2），秒杀接口跑库存扣减（见 4.3）
  - 暴露 `/health`、`/metrics`、`/actuator/prometheus` 给侦察拉数据
- **产出结果**：
  - 处理日志（写 ELK / 本地日志文件）
  - Prometheus 指标（成功率、p99、QPS）
  - 这是主力**唯一持续运行**的功能，其他功能都是迭代时触发

#### 功能 8：质量自评触发
- **做什么**：上线后主动调侦察评估自己，不等侦察定时跑。
- **怎么做**：
  1. `evaluate_call` 同步 gRPC 调侦察 `EvaluateService.Evaluate`
  2. 传 `{service, version, metrics_window_sec: 300}`
- **产出结果**：
  - 收到 `{score, dimension_scores, trend}`
  - 超时(5s) → 降级用本地缓存基线，异步补调
  - 这是主力→侦察的同步握手，触发侦察的完整评估流程

### 4.2 订单状态机（功能 7 的核心，编码必须实现）

```
待支付(pending) --支付成功--> 已支付(paid) --发货/开通--> 已完成(done)
    |                              |
    |超时30min未支付                |申请退款
    ↓                              ↓
已取消(canceled)              退款中(refunding) --退款成功--> 已退款(refunded)
```

**关键约束（编码点）**：
- 待支付 → 30 分钟超时自动取消（RocketMQ 延迟消息 / 定时任务扫表）
- 支付回调**必须幂等**：基于 `out_trade_no` 去重，已处理直接返回成功
- 退款需校验订单状态 ∈ {paid, done}
- 状态转换全部走 `OrderStateMachine` 类，禁止 Service 直接 update 状态字段

### 4.3 秒杀库存扣减策略（三档，升级 Agent 决定升哪档）

| 档 | 实现 | 风险 | 性能 | 由谁生成 |
|---|---|---|---|---|
| **L1** | DB 直接 `UPDATE stock = stock - 1 WHERE stock > 0` | 超卖（高并发竞争） | 低 | 主力初始生成 |
| **L2** | Redis `DECR` 原子预扣 + MQ 异步落库 | 防超卖 + 削峰 | 高 | 升级优化 |
| **L3** | L2 + 内存标记（预扣完直接拒绝，减少 Redis 访问） | 防超卖 + 极致性能 | 极高 | 升级终极优化 |

主力生成时默认 L1，升级 Agent 据侦察的"超卖率/p99"指标决定是否升 L2/L3。

### 4.4 主力内部循环（while True）

```
while True:
  if 有待处理需求 (interface_requirement.status == parsed):
      → 跑功能 1→6（解析→RAG→生成→测试→注册→灰度）
  elif 收到学员请求 (HTTP):
      → 跑功能 7（对外服务，走状态机）
  elif 上线后满 5min:
      → 跑功能 8（自评触发）
  elif 收件箱有消息 (deploy_subagent 回报):
      → 处理灰度状态推进
  else:
      → sleep(1s)
```

**关键**：主力的循环是**事件驱动混合**——业务请求优先，迭代任务次之。这是业务向 agent 特有的，侦察/升级是纯任务驱动。

### 4.5 主力核心数据模型

```sql
-- 接口需求单
interface_requirement {
  id, business_domain(course/seckill/order/pay/user),
  requirement_text, field_table(json),
  sla{qps, latency_p99, consistency},
  status(parsed/generating/testing/deploying/online/failed),
  openapi_spec(json), nfr(json),
  created_by, created_at
}

-- 代码产出清单
code_manifest {
  id, requirement_id, version,
  files[{path, layer, content_hash}],
  coverage, build_status, git_tag
}

-- 发布单
release {
  id, service, version, manifest_id,
  strategy(canary/blue_green), canary_pct,
  status(0/5/50/100/rolled_back), health_score, created_at
}

-- 秒杀活动（业务实体）
seckill_activity {
  id, course_id, origin_price, seckill_price,
  stock, per_user_limit, start_time, end_time,
  status(not_started/running/ended/sold_out)
}
```

---

## 五、侦察 Agent（Python）详细设计

### 5.0 角色定位
侦察是**观测分析者**：盯主力产出的线上质量，跑测试评估，产出"哪里有问题、怎么改"的结构化判断。**对业务代码只读不写，不对外服务，没有业务状态机**。它的设计核心是**评估体系 + 结构化产出**，不是稳定性。

### 5.1 功能清单（7 个功能）

#### 功能 1：指标采集
- **做什么**：从监控系统拉主力的运行指标。
- **怎么做**：
  1. `metric_scraper` 调 Prometheus API，查 `{service, metric_name, time_window}`
  2. 聚合算 p99 / avg / error_rate
  3. 覆盖指标：接口成功率、秒杀 p99、下单 p99、QPS
- **产出结果**：
  - `metric_series`：`[{t, v}, ...]` + 聚合值
  - 失败产出：Prometheus 不可用 → 从日志反推指标（降级），写 `degradation_log`

#### 功能 2：日志分析
- **做什么**：从主力日志找错误模式，定位异常根因。
- **怎么做**：
  1. `log_collector` 从 ELK / 本地日志文件拉指定时间窗 + level 的日志
  2. 派发 `log_analyzer_subagent`（task），用正则 + LLM 提错误模式
  3. 聚合 Top N 错误模式 + 频次
- **产出结果**：
  - `error_patterns`：`[{pattern, count, sample_log, root_cause_guess}, ...]`
  - 失败产出：ELK 不可用 → 读本地日志文件降级

#### 功能 3：回归测试执行
- **做什么**：跑主力的全量单测 + 集成测试，确认没退化。
- **怎么做**：
  1. `test_runner` 派发 pytest/JUnit 执行
  2. 收 JUnit XML 报告解析
  3. 超时 10min 杀进程标 failed
- **产出结果**：
  - `test_report`：`{passed: 120, failed: 3, coverage: 0.85, failed_cases: [...]}`
  - 失败产出：超时 → 标 failed + 告警

#### 功能 4：质量打分
- **做什么**：多维度打分，对比基线，算趋势。**这是闭环的咽喉**。
- **怎么做**：
  1. 派发 `scorer_subagent`（**teammate 持久子 Agent**），因为要跨轮对比基线趋势
  2. 输入：功能 1/2/3 的指标 + 日志 + 测试报告
  3. 多维打分（见 5.2 评估指标体系）
  4. 对比基线算 trend（up/down/flat）
- **产出结果**：
  - `score_report`：`{overall: 0.92, dimensions: {availability: 0.99, performance: 0.85, ...}, trend: "down"}`
  - 失败产出：基线缺失 → 用首版作基线

#### 功能 5：改进点挖掘
- **做什么**：据打分 + 日志 + 指标，用 LLM 产出结构化改进点。**侦察的核心产出**。
- **怎么做**：
  1. `improvement_finder`，输入 `{score, metrics, logs, rag_context}`
  2. RAG 检索历史相似缺陷的修复案例（few-shot）
  3. LLM 结构化产出，每个改进点含：`{target, problem, evidence, suggestion, priority, level}`
  4. `level` 标 L1/L2/L3，决定升级 Agent 走哪条流水线
- **产出结果**：
  - `improvements[]`：结构化数组（见 5.3 数据模型）
  - 按 priority 排序：P0（超卖/支付失败）> P1（p99 超标）> P2（优化项）
  - 失败产出：LLM 失败重试 2 次 → 降级用规则引擎（硬编码的 if-then 规则）

#### 功能 6：经验记录
- **做什么**：把评估结果、失败案例写进经验库，供三方共享。
- **怎么做**：
  1. `experience_writer`，写 Milvus 向量库 + Postgres 案例表
  2. 失败案例反哺基线（下次评估对照）
- **产出结果**：
  - `experience` 记录：`{id, type, content, tags, embedding, outcome}`
  - 失败产出：向量库失败 → 先写 Postgres，异步补向量

#### 功能 7：改进点推送
- **做什么**：把改进点发 MQ 通知升级 Agent。
- **怎么做**：
  1. `mq_publish`，topic = `improvement_topic`
  2. 发送失败 → 本地重试队列 + 指数退避，超 3 次进死信人工处理
- **产出结果**：
  - RocketMQ 消息 `{msg_id, sent: true}`
  - 升级 Agent 消费后回 ACK

### 5.2 评估指标体系（功能 4 的打分维度，闭环咽喉，先建）

| 维度 | 指标 | 采集方式 | 基线 | 权重 |
|---|---|---|---|---|
| 可用性 | 接口成功率 | metric_scraper | ≥ 99.9% | 0.3 |
| 性能 | 秒杀 p99 | metric_scraper | ≤ 200ms | 0.2 |
| 性能 | 下单 p99 | metric_scraper | ≤ 500ms | 0.1 |
| 正确性 | 超卖率 | 定时对账 | = 0 | 0.2 |
| 正确性 | 支付幂等率 | 日志分析 | 100% | 0.1 |
| 质量 | 测试覆盖率 | test_runner | ≥ 80% | 0.05 |
| 质量 | 测试通过率 | test_runner | 100% | 0.05 |

综合分 = Σ(维度分 × 权重)。**低于基线 5% 触发 P1 改进点，低于 10% 触发 P0**。

### 5.3 改进点数据模型（侦察产、升级消费）

```json
{
  "id": "imp_001",
  "target_service": "seckill-service",
  "target_file": "SeckillServiceImpl.java",
  "problem_desc": "秒杀库存扣减存在超卖风险",
  "evidence": {
    "metric": "oversell_rate = 0.003",
    "log_snippet": "UPDATE stock WHERE stock>0 race condition",
    "score_drop": 0.15
  },
  "suggestion": "改 Redis 预扣 + MQ 异步落库",
  "priority": "P0",
  "level": "L3",
  "status": "pending",
  "created_at": "2026-07-21T09:00:00Z",
  "consumed_by": null
}
```

### 5.4 侦察内部循环（while True，纯任务驱动）

```
while True:
  if 任务看板有评估任务 (status=open):
      → CLAIM（CAS 防竞争）
      → 并行跑功能 1(指标) + 功能 2(日志) + 功能 3(测试)
      → 功能 4(打分)
      → if 分数 < 基线 or 发现异常:
            → 功能 5(改进点挖掘)
            → 功能 6(经验记录)
            → 功能 7(MQ 推升级)
      → DONE → 回 IDLE
  elif 收到主力 evaluate_call (同步 gRPC):
      → 跑功能 1+4 返回打分（同步握手）
  else:
      → sleep(30s) 轮询
```

**关键差异**：侦察是纯任务驱动 + 同步响应主力的 evaluate_call。没有业务流量，没有状态机，没有对外 API。这是它和主力的本质区别。

---

## 六、升级 Agent（Python）详细设计

### 6.0 角色定位
升级是**执行变更者**：消费改进点，安全地改主力代码并上线。**最危险的一环**，因为它能动主力的源码。它的设计核心不是"能改码"，而是**护栏 + 分档 + 回滚**。和侦察一样不对外服务，但比侦察多了"变更能力 + 变更风险"。

### 6.0.1 升级触发模型（阶段性升级清单驱动，管理员排期 + 紧急直通）

升级不是"改进点堆在一起到点一把梭"，而是**阶段性升级清单（Upgrade Plan）**驱动。改进点先入"待规划池"，管理员把它们组织成一个个清单，给每个清单单独排期；重大生产事故走紧急直通，直接交给 agent 立即执行。

- **入队**：侦察产改进点 → MQ `improvement_topic` → `improvement_consumer` 消费 → 只写 `improvement` 表 `status=pending`，进入"待规划池"。**不触发升级。**
- **规划**：管理员在 Admin 控制台把待规划池里的改进点勾选 → 组成升级清单 → 给清单排期 `scheduled_at`。
- **触发**：清单到点 / 管理员手动提前 / 紧急直通，三种动作才会真正启动升级。

**核心数据模型 `upgrade_plan`（升级清单表）**：

| 字段 | 含义 | 示例 |
|---|---|---|
| `plan_id` | 清单唯一 id | `plan-20260722-001` |
| `name` | 清单名 | `秒杀库存优化批次` |
| `improvement_ids` | 本清单包含的改进点 | `[imp-001, imp-003, imp-007]` |
| `scheduled_at` | 管理员排期的执行时间 | `2026-07-22T03:00:00+08:00` |
| `mode` | `normal` / `emergency` | emergency = 重大生产事故，直通 |
| `priority` | 清单优先级 | P0/P1/P2 |
| `status` | `draft` / `scheduled` / `running` / `done` / `partial_rolled_back` / `rolled_back` | |
| `created_by` | `admin` / `auto`（紧急自动建） | |
| `max_batch_size` | 单批上限（覆盖全局默认） | 5 |

**三种触发动作**：

| 触发动作 | 机制 | 场景 | 编码点 |
|---|---|---|---|
| **① 清单到点触发** | 管理员给清单排 `scheduled_at`，到点该清单整体进 `upgrade_batch` | 日常自进化主路径，管理员主动排期 | `plan_scheduler` 每分钟扫 `status=scheduled and scheduled_at<=now` 的清单 |
| **② 紧急直通触发** | 重大生产事故，清单 `mode=emergency`，**不经管理员二次确认，直接交给 agent 立即执行** | 线上 P0：超卖、支付失败、服务宕机 | 侦察标 P0 → 自动建 emergency 清单 → 直接入 `upgrade_batch` |
| **③ 管理员手动触发** | Admin 控制台点"立即执行此清单"，提前触发某 `scheduled` 清单 | 验证某改进点、紧急但非事故 | gRPC `TriggerPlan(plan_id)`，置 `status=running` 入批 |

> ⚠️ **与"阈值自动组批"的根本区别**：组批权在管理员手里，不在自动阈值手里。管理员不排期的改进点永远不执行（不会自动凑批）。只有重大生产事故（emergency）才打破排期直接给 agent。

**紧急直通的边界（重要护栏）**：

`mode=emergency` 的清单可直通，且只能由两种方式产生：
- 侦察识别为 P0 级（超卖、支付故障、服务宕机）→ 自动建 emergency 清单
- 管理员手动建 emergency 清单

emergency 清单**不经管理员二次确认**——事故等不起人确认。但有三条硬约束：

1. 仍必须走 L3 完整 CI（测试/审查不可跳过）
2. 执行即发**最高级公告** + 站内信通知管理员（事后知情）
3. emergency 清单的灰度观察窗口自动加倍（默认 ×2 = 20min），防事故修复引入新事故

非 emergency 清单一律按 `scheduled_at` 排期执行。

**管理员排期界面（Admin 控制台）**：

- 待规划池：`improvement.status=pending` 且未进任何清单的改进点
- 创建清单：勾选改进点 → 设 `name` / `scheduled_at` / `priority` / `mode`
- 清单看板：所有清单及状态（draft/scheduled/running/done）
- 紧急建清单：一键建 emergency 清单，选改进点，立即执行

**`plan_scheduler` 每分钟跑一次**：

```
def plan_scheduler():
    # 1. 紧急直通（最高优先级，不等排期）
    for plan in plans where mode=emergency and status in (draft, scheduled):
        → status=running → 整清单入 upgrade_batch（立即）
    # 2. 清单到点
    for plan in plans where status=scheduled and scheduled_at <= now:
        → status=running → 整清单入 upgrade_batch
    # 3. 管理员手动触发的清单由 gRPC TriggerPlan 直接置 running + 入批
```

**关键编码点**：清单整体进 `upgrade_batch` 后，内部仍按 6.5.1 做依赖分析 + L1/L2/L3 分档 + 并发。失败改进点回 pending（退出本清单），连续 3 次失败标 `needs_human`。清单全部处理完 → `status=done`；若发生整体回滚 → `status=rolled_back`。

### 6.1 自进化三档（功能分流的根本，编码必须分档）

| 档 | 改什么 | 流程 | 风险 | 人工 | 收益占比 |
|---|---|---|---|---|---|
| **L1 软升级** | Prompt / 检索参数 / 路由策略（存 Nacos） | 改配置→Nacos 热更→侦察复评 | 低，一键回滚 | 不需要 | ~90% |
| **L2 策略升级** | DSL 表达的规则（审查规则/测试策略/限流阈值） | 改规则→影子流量验证→复评达标放量 | 中 | 初期需 approve | ~8% |
| **L3 代码升级** | 服务源码 | 补丁→审查→测试→build→灰度→复评→全量/回滚 | 高 | **必须人工 approve** | ~2% |

**设计哲学**：90% 的"变聪明"靠 L1（改 Prompt），不要一上来就改代码。L3 是最后手段，且护栏最重。

### 6.2 功能清单（6 个功能）

#### 功能 1：改进点消费与分流
- **做什么**：从 MQ 拉改进点，按 level 分流到 L1/L2/L3 处理流程。
- **怎么做**：
  1. `improvement_consumer` 消费 `improvement_topic`
  2. 读 `improvement.level`，分流：
     - L1 → 功能 2
     - L2 → 功能 3
     - L3 → 功能 4
- **产出结果**：
  - 改进点状态 `status: pending → consumed`
  - 失败产出：消费失败重试，超 3 次进死信人工处理

#### 功能 2：L1 软升级（改配置）
- **做什么**：改 Prompt / 检索参数 / 路由策略，推 Nacos 热更。
- **怎么做**：
  1. `rag_search` 检索最佳实践（如"秒杀场景 Prompt 优化案例"）
  2. LLM 生成新 Prompt / 新参数
  3. `nacos_config_push` 推到对应 dataId（`firefly-main-prompt.yml` 等）
  4. 通知侦察复评
- **产出结果**：
  - Nacos 配置更新，主力热加载
  - `release` 记录，`strategy: L1_config`
  - 复评达标 → 完成；退化 → Nacos 回滚上一版本配置（Nacos 自带历史版本）

#### 功能 3：L2 策略升级（改 DSL 规则）
- **做什么**：改审查规则 / 测试策略 / 限流阈值（DSL 表达，不改源码）。
- **怎么做**：
  1. 改 DSL 规则文件（存 Git，`rules/{domain}.dsl`）
  2. **影子流量验证**：新规则只跑不生效，对比结果
  3. 复评达标 → 放量生效
- **产出结果**：
  - 规则文件 Git commit
  - `release` 记录，`strategy: L2_rule`
  - 初期需人工 approve 放量

#### 功能 4：L3 代码升级流水线（核心，死锁式）
- **做什么**：改主力源码，走完整 CI + 灰度 + 回滚。**这是升级 Agent 存在的理由**。
- **怎么做**（见 6.3 详细流水线）
- **产出结果**：
  - 成功：新版本全量上线，`release.status: 100`
  - 失败：回滚上一 tag，`release.status: rolled_back`，写失败案例

#### 功能 5：回滚执行
- **做什么**：L3 灰度期间健康度退化，回滚到上一稳定版本。
- **怎么做**：
  1. `rollback_executor`：`git revert` + 重建上一 tag 镜像 + 流量切回
  2. 派发 `rollback_subagent`（teammate）持续观察确认回滚成功
  3. 回滚失败 → 告警人工介入（这是最后防线）
- **产出结果**：
  - `release.status: rolled_back`
  - `experience` 失败案例（反哺基线）
  - **升级独有的功能**——侦察和主力都没有回滚能力

#### 功能 6：经验沉淀
- **做什么**：无论成功失败，都写经验库。
- **怎么做**：
  1. `experience_writer`，`type: success_case / failure_case`
  2. 成功案例：记录"什么改进点 + 什么补丁 + 效果提升多少"
  3. 失败案例：记录"什么补丁 + 为什么失败 + 回滚了"——**失败案例比成功案例更值钱**
- **产出结果**：
  - `experience` 记录入库
  - 下次 `improvement_finder` 检索到相似问题时，优先参考失败案例避免重蹈覆辙

### 6.3 L3 代码升级流水线（功能 4 详细，分阶段处理，不是有红就滚）

> **重要修正**：原设计"任一失败立即回滚"有问题——代码在 Git 上，流水线阶段失败（测试不过/审查拒绝）时**还没上线，不该回滚线上**，而是回 patch 修订。只有灰度阶段线上退化且观察窗口内未恢复，才回滚。失败的改进点重新入队，下次再试。

**分两条阶段，失败处理完全不同：**

#### 阶段 A：流水线阶段（worktree 内，未上线，失败不动线上）
```
改进点(level=L3) →
  ┌─ worktree_manager 开独立 worktree
  │   git worktree add ../firefly-work-{imp_id} -b fix/{imp_id}
  │
  ├─ patch_generator 生成补丁
  │   派发 patch_subagent(task)
  │   LLM + AST 改写 → patch_diff
  │   失败: 重试2次 → 标 needs_human，改进点 status 回 pending，下次再试（不动线上）
  │
  ├─ code_reviewer 代码审查
  │   派发 reviewer_subagent(task)
  │   reject → 回 patch_generator 修订（最多3轮）
  │   3轮仍 reject → 改进点 status 回 pending + 写失败案例，下次再试（不动线上）
  │
  ├─ test_runner 全量测试
  │   在 worktree 跑 mvn test
  │   fail → 回 patch_generator 修（3轮失败 → 同上，不动线上）
  │
  ├─ build_trigger 打镜像
  │   docker build -t firefly-{service}:{imp_id}
  │   fail → 分析日志 → 回 patch_generator（不动线上）
  │
  └─ 人工 approve（初期必须，L3 红线）
      ↓ 通过才进阶段 B
```

#### 阶段 B：灰度阶段（已上线，退化才回滚，观察窗口内未恢复）
```
  ┌─ canary_controller 灰度 5%
  │
  ├─ 派发 rollback_subagent(teammate) 观察窗口（默认 10min，Nacos 可配）
  │   ├ 健康度达标 → 灰度 50% → 再观察 → 全量 100%
  │   │   产出: release.status=100, experience(success_case), 发成功公告
  │   │
  │   ├ 健康度退化但观察窗口内自恢复 → 继续观察，不回滚
  │   │   （瞬时抖动容忍，避免误回滚）
  │   │
  │   └ 健康度退化且观察窗口内未恢复 → rollback_executor 回滚
  │       产出: release.status=rolled_back, experience(failure_case)
  │       改进点 status 回 pending，下次定时窗口再试
  │       发回滚公告
  │
  └─ 通知侦察复评 → 清理 worktree → 结束
```

**关键区分（编码必须实现）**：
- 阶段 A 失败 = **改进点级失败**：改进点回 `pending`，下次再试，**线上零影响**
- 阶段 B 失败 = **版本级失败**：回滚到上一 tag，改进点也回 `pending`，下次再试
- 观察窗口 = 容忍瞬时抖动，只有持续退化才回滚（避免 MQ 抖动/GC 停顿导致的误回滚）

### 6.4 worktree 隔离规则（源自乐享 s18，自进化安全关键）

- **每个改进任务一个独立 worktree**：`git worktree add ../firefly-work-{improvement_id} -b fix/{improvement_id}`
- 多个改进任务可**并行改码**，互不覆盖（这是 worktree 的核心价值）
- worktree 用完即删：`git worktree remove`
- worktree 超过 24h 未合并 → 自动清理 + 告警（防僵尸目录堆积）

### 6.5 并发升级与回滚策略（不一刀切，编码关键）

升级**不是一口气全部升级**，而是：分析依赖 → 尽可能并发 → 有问题只回滚有问题的 → 有影响才整体回滚。

#### 6.5.1 并发分析（升级前必做）
收到一批改进点后，先做**依赖分析**，决定并发度：
```
upgrade_batch = [imp_001, imp_002, imp_003, ...]

依赖分析:
  imp_001 改 SeckillServiceImpl.java
  imp_002 改 OrderServiceImpl.java
  imp_003 也改 SeckillServiceImpl.java  ← 与 imp_001 冲突

分组结果:
  组1(可并发): [imp_001, imp_002]  ← 改不同文件，并行开 worktree
  组2(串行):   [imp_003]            ← 与 imp_001 同文件，等组1完成再做
```
- **同文件/同服务的改进点串行**（避免 worktree 合并冲突）
- **不同文件/不同服务的改进点并行**（开多个 worktree 同时改）
- 并发度上限 = Nacos `firefly-upgrade-concurrency` 配置（默认 3，防资源打爆）

#### 6.5.2 DAG 编排引擎（图引擎调度层，形式化 6.5.1 的并发分组）

6.5.1 的"规则判断分组"是雏形，本节将其**形式化为 DAG 调度引擎**。核心思想：**图引擎不替代 loop，是 loop 的并行调度层**——把任务建成有向无环图，无依赖节点并行，有依赖节点串行，每个节点内部仍跑完整 loop。

**三层调度架构**：
```
图引擎调度层（DAG Engine）
  ├─ 依赖分析 → 建图 → 拓扑排序 → 并发执行无依赖节点 → 故障隔离
  ↓ 调度节点
Loop 节点执行层
  ├─ 每节点 = 一个完整 loop 任务（如 L3 流水线 patch→review→test→build→灰度）
  ↓ 调用工具
工具层
  └─ worktree / patch_generator / test_runner / build_trigger / canary / rollback
```

**DAG 节点定义**：
```python
DAGNode = {
    "id": "imp_001",
    "task": callable,          # 内部跑完整 loop（L1/L2/L3 流水线）
    "depends_on": ["imp_000"], # 依赖的节点 id 列表（空=可立即并行）
    "level": "L3",
    "target_files": ["SeckillServiceImpl.java"]  # 建图依据
}
```

**建图规则**（把 6.5.1 的规则形式化）：
- **同文件/同服务的改进点** → 加串行边（后者在 depends_on 里写前者）
- **不同文件/不同服务的改进点** → 无边（并行）
- **共享依赖改动**（DTO/公共 Utils）→ 汇聚节点，等所有依赖它的节点完成后再跑验证

**DAG 示例**（升级 Agent 收到 4 个改进点）：
```
imp_001(改SeckillService) ──┐
imp_002(改OrderService) ─────┤── 无依赖 → 并行跑各自 L3 流水线
imp_003(改UserService) ──────┤
imp_004(改SeckillService) ───┘ 与 imp_001 同文件 → 串行，等 imp_001 完成
         │
         ↓
   全量回归验证（汇聚节点，依赖全部完成）
```

**并发度控制**：`concurrent.futures.ThreadPoolExecutor(max_workers=Nacos firefly-upgrade-concurrency, 默认3)`，超过上限的 ready 节点排队等待。

**故障隔离**（与 6.5.3 回滚策略联动）：
- 单节点失败 → 局部回滚该节点（只 revert 该 worktree）
- 共享依赖节点导致多节点退化 → 整体回滚整批
- 节点失败不影响无依赖的其他节点继续跑（隔离）

**适用边界**：
| 场景 | 用图引擎？ | 理由 |
|---|---|---|
| 升级 Agent 批量改进点 | ✓ | 同文件串行/异文件并行，DAG 天然表达 |
| 侦察 Agent 多评估任务 | ✓ | 拉日志/跑指标/回归/RAG 互不依赖 |
| 主力并行生成多接口 | ✓ | 多需求互不依赖 |
| L3 流水线内部 | ✗ | patch→review→test 严格串行，保持 loop |
| 时序约束（先公告再回滚） | ✗ | 图管并行不管时序语义，用代码写 |

**不引入重引擎**：自写轻量 DAG（拓扑排序 + 线程池），不引入 Airflow/Temporal。单机 Compose 阶段够用，迁 K8s 后可换 Argo/DAG on K8s。

#### 6.5.3 三档回滚策略（编码必须区分）
| 回滚档 | 触发条件 | 范围 | 实现 |
|---|---|---|---|
| **局部回滚** | 单个改进点的灰度退化，其他并发升级正常 | 只回滚该改进点的 worktree + 该服务版本 | `git revert {imp_id}` + 重建该服务上一 tag |
| **整体回滚** | 某升级改了共享依赖（如 DTO/公共 Utils），导致其他服务也退化 | 回滚整个批次到上一稳定 tag | `git revert` 整个 batch + 重建所有受影响服务镜像 |
| **不回滚** | 观察窗口内自恢复的瞬时抖动 | 无 | 仅记录抖动事件，继续观察 |

**判断逻辑**：
1. 灰度期间某服务退化 → 先看是不是该批次改的 → 是 → 局部回滚该服务
2. 回滚后仍退化 → 说明是共享依赖污染 → 整体回滚整个批次
3. 回滚后恢复 → 确认局部回滚成功，其他并发升级继续

#### 6.5.4 失败改进点重新入队
- 局部/整体回滚后，**失败的改进点 `status` 回 `pending`**，不是丢弃
- 下次定时窗口或管理员手动触发时，重新进 `upgrade_batch`
- 连续 3 次失败 → 升级为 `needs_human`，告警人工介入（避免死循环重试）

### 6.6 业务更新公告（每次升级必发）

每次升级（无论成功/回滚/部分回滚）都发业务公告，让运营方和用户知情。

#### 公告触发时机
- 灰度开始时：发"升级中"预告
- 全量成功：发"升级完成"公告
- 回滚：发"已回滚"公告，说明影响范围

#### 公告数据模型
```json
{
  "id": "ann_001",
  "release_id": "rel_001",
  "type": "upgrade_start / upgrade_success / rollback",
  "scope": {
    "services": ["seckill-service"],
    "affected_apis": ["/api/seckill/buy", "/api/seckill/stock"]
  },
  "summary": "秒杀库存扣减从 DB直扣 升级为 Redis预扣+MQ",
  "impact": "秒杀接口可能短暂延迟，已回滚至上一版本",
  "user_action": "无需操作，已恢复",
  "created_at": "2026-07-21T03:15:00Z"
}
```
- 公告写入 `release_announcement` 表
- 推送渠道：Admin 控制台站内信 + （可选）企业微信/钉钉 webhook
- 用户侧：在平台首页/接口文档页展示"系统更新公告"横幅

### 6.7 升级内部循环（while True，清单驱动 + 紧急直通 + 收件箱）

```
while True:
  # === 入队阶段（不触发升级，除非 P0 紧急）===
  if MQ 有改进点消息 (improvement_topic):
      → improvement_consumer 消费
      → 写 improvement 表 status=pending（进待规划池）
      → if level=P0（重大生产事故：超卖/支付故障/宕机）:
            自动建 upgrade_plan(mode=emergency, created_by=auto)
            → 整清单直通入 upgrade_batch（不等管理员排期）
      → else: 不进 upgrade_batch（等管理员规划进清单）

  # === 清单触发阶段（每分钟由 plan_scheduler 评估）===
  if plan_scheduler 命中（紧急直通清单 / 到点清单）:
      → 整清单 status=running → 入 upgrade_batch
  if 收到管理员手动触发 (gRPC TriggerPlan):
      → 指定清单 status=running → 入 upgrade_batch

  # === 执行阶段 ===
  if upgrade_batch 非空:
      → 功能 1(依赖分析 + 分流)  # 6.5.1 并发分组
      → 并发处理（同文件串行，异文件并行，受 max_worktree 限制）:
          L1: 功能 2 → 通知复评
          L2: 功能 3 → 影子验证 → 放量/局部回滚
          L3: 功能 4(流水线 A→B) → 可能功能 5(局部/整体回滚) → 功能 6(经验)
      → 6.6 发业务公告（开始/成功/回滚；emergency 清单发最高级公告 + 站内信通知管理员）
      → emergency 清单灰度观察窗口 ×2（默认 20min）
      → 失败改进点回 pending（退出本清单），下次再试（6.5.3）
      → 清单全部处理完 → plan.status=done / rolled_back

  elif 收件箱有消息 (rollback_subagent 回报退化):
      → 功能 5(回滚执行) → 判断局部/整体 → 发回滚公告
  elif 任务看板有清理任务:
      → 清理超期 worktree + 连续3次失败的改进点标 needs_human
  else:
      → sleep(10s)
```

**关键差异**：升级是**阶段性清单驱动 + 管理员排期 + 紧急直通 + 并发 + 分档回滚**。改进点入待规划池，管理员组成清单排期，到点/手动/紧急直通三种触发；重大生产事故（emergency）不经确认直接给 agent，但仍走完整 CI + 观察窗口加倍 + 事后通知。它有**回滚能力**这是独占的，且循环里嵌着完整 CI 流水线 + 公告机制。比侦察复杂得多，比主力危险得多。

---

## 七、子 Agent 机制（三 Agent 共用）

### 7.1 两种委派模式（源自乐享 s04/s09/s20）

| 模式 | 机制 | 生命周期 | 上下文 | 通信 | 适用 |
|---|---|---|---|---|---|
| **task 一次性** | 父派发，子用独立 messages[] 跑完返回**摘要文本**→消亡 | 生成→干活→返回→死 | 完全隔离 | 无（单向返回） | 专项、独立、可并行 |
| **spawn_teammate 持久** | 父派生持久线程，有身份 | 跨多轮存活 | 隔离，各自 messages[] | **MessageBus 收件箱**双向 | 跨轮观察/协作 |

### 7.2 关键规则（编码必须遵守）

1. **上下文隔离**：子 Agent 一律 fresh `messages[]`，不继承父历史
2. **`task` 工具仅父端注册**：子不能再派子（防递归爆炸）
3. **身份重注入**（s11）：子进 WORK 前检查并重注入身份 Prompt
4. **慢操作不阻塞**（s13）：压测/构建走 Background Task
5. **失败隔离**：子异常不影响父，父收错误摘要后决定重试或换策略

### 7.3 三 Agent 的子 Agent 清单（9 个）

**主力**：
| 子 Agent | 模式 | 职责 | 产出 |
|---|---|---|---|
| `codegen_subagent` | task | 分层生成代码 | 文件列表 + 逻辑摘要 |
| `testgen_subagent` | task | 生成单测 | 测试文件 + 覆盖率 |
| `deploy_subagent` | teammate | 灰度部署跨轮观察 | 各阶段状态消息 |

**侦察**：
| 子 Agent | 模式 | 职责 | 产出 |
|---|---|---|---|
| `log_analyzer_subagent` | task | 分析日志找错误模式 | Top N 错误模式 + 频次 |
| `pressure_tester_subagent` | task | 对接口跑压测 | p99/吞吐/错误率 |
| `scorer_subagent` | teammate | 持续评估跨轮对比基线 | 评分趋势消息 |

**升级**：
| 子 Agent | 模式 | 职责 | 产出 |
|---|---|---|---|
| `patch_subagent` | task | 生成补丁 | 补丁 diff 摘要 |
| `reviewer_subagent` | task | 代码审查 | 审查意见(pass/reject) |
| `rollback_subagent` | teammate | 灰度观察触发回滚 | 健康度/回滚触发消息 |

---

## 八、通信协议（编码级定义）

### 8.1 同步 gRPC（主力↔侦察/升级）

```protobuf
service EvaluateService {  // 侦察提供，主力调用
  rpc Evaluate(EvaluateRequest) returns (EvaluateResponse);
}
message EvaluateRequest {
  string service = 1;
  string version = 2;
  int64 metrics_window_sec = 3;
}
message EvaluateResponse {
  double score = 1;
  map<string, double> dimension_scores = 2;
  string trend = 3;  // up/down/flat
}

service UpgradeService {  // 升级提供，主力调用
  rpc TriggerUpgrade(UpgradeRequest) returns (UpgradeResponse);
}
```

### 8.2 异步 RocketMQ Topic

| Topic | 生产者 | 消费者 | 用途 |
|---|---|---|---|
| `improvement_topic` | 侦察 | 升级 | 推改进点 |
| `release_topic` | 升级 | 主力 | 新版本就绪/回滚通知 |
| `experience_topic` | 三方 | 三方 | 经验库变更广播 |

### 8.3 持久收件箱（teammate 通信，.jsonl）

```
# /data/inbox/{agent_name}.jsonl
{"id":"msg_001","from":"main","to":"deploy_subagent","type":"canary_status","content":{"pct":5,"healthy":true},"ts":1721530000}
```

### 8.4 Nacos 配置（L1 软升级热更对象）

| dataId | 内容 | 热更 |
|---|---|---|
| `firefly-main-prompt.yml` | 主力 code_generator 的 Prompt | ✓ |
| `firefly-rag-params.yml` | 检索 top_k / rerank 阈值 / BM25 权重 | ✓ |
| `firefly-sentinel-rules.json` | Sentinel 限流规则 | ✓ |
| `firefly-canary-strategy.yml` | 灰度策略(比例/观察窗口时长) | ✓ |
| `firefly-upgrade-policy.yml` | **升级清单策略**：`emergency.auto_create_on_p0`（侦察标P0自动建紧急清单,默认true）/ `emergency.observe_window_multiplier`（紧急观察窗口倍数,默认2）/ `plan.max_batch_size`(5) / `plan.retry_max`(3) / `concurrency.max_worktree`(3) / `observe.window_min`(10) | ✓ |

### 8.5 RAG 检索策略（三 Agent 共用，混合检索含 BM25）

**是的，RAG 必须用混合检索，包含 BM25。** 单纯向量检索不够，因为代码场景有大量精确关键词（接口名、字段名、错误码、类名），BM25 在精确匹配上远强于向量。

#### 8.5.1 混合检索架构
```
query
  ├─ 向量检索(Milvus) → 语义相似 Top50    # 抓"意思接近"的，如"库存扣减" 匹配 "stock decrement"
  ├─ BM25 检索(ES)    → 关键词匹配 Top50   # 抓"字面一致"的，如 "SeckillServiceImpl" "OUT_OF_STOCK"
  └─ RRF 融合         → 合并去重 Top50      # Reciprocal Rank Fusion: score = Σ 1/(k+rank)
       ↓
  连坐召回(命中切片拉父文档全部切片)         # 防摘要块霸榜，保证上下文完整
       ↓
  Rerank(bge-reranker-v2-m3) → Top20       # 精排，Top50→20，Recall@5 从 94%→99.3%
       ↓
  rag_context 返回给 Agent
```

#### 8.5.2 为什么必须双路（向量 + BM25）
| 检索路 | 强项 | 弱项 | 适合命中 |
|---|---|---|---|
| **向量检索** | 语义相似、同义词、跨语言 | 精确关键词不如 BM25 | "秒杀库存超卖" → 匹配 "flash sale oversell" |
| **BM25** | 精确关键词、类名/错误码/字段名 | 不懂同义、语义 | "SeckillServiceImpl" "OutOfStockException" "stock=0" |
| **RRF 融合** | 两路优势互补 | — | 综合召回率最高 |

**编码点**：`rag_search` 工具内部必须并行调 Milvus(向量) + ES(BM25)，用 RRF 公式 `score = Σ 1/(60+rank)` 融合，再去重。

#### 8.5.3 三 Agent 用 RAG 的差异
| Agent | RAG 用途 | 检索 filters |
|---|---|---|
| 主力 | 检索相似实现 + 编码规范 + 历史缺陷，作代码生成 few-shot | `type: [implementation, spec, defect_case]` |
| 侦察 | 检索历史错误模式 + 修复案例，作改进点挖掘对照 | `type: [defect_case, fix_case]` |
| 升级 | 检索修复案例 + review 规则 + 失败案例，生成补丁时防重蹈覆辙 | `type: [fix_case, review_rule, failure_case]` |

**失败案例优先**：升级 Agent 检索时，`failure_case` 类型权重 ×1.5，避免重复踩坑。

---

## 九、单机 Docker Compose 服务清单（11 个）

```
nacos          # 注册发现 + 配置中心
sentinel-dash  # 限流规则可视化
postgres       # 业务/任务/日志/改进点元数据
redis          # 秒杀库存预扣 + 缓存
rocketmq       # 异步消息
milvus         # 经验库向量检索
elasticsearch  # 课程搜索 + 日志
gitea          # 轻量 Git（升级提补丁/回滚）
main-agent     # Java 主力（Spring Boot）
scout-agent    # Python 侦察
upgrade-agent  # Python 升级
```

---

## 十、乐享知识库依据溯源

| 设计点 | 乐享来源 |
|---|---|
| Agent 内核 while True 循环 | s01 Agent Loop / s20 |
| 子 Agent 上下文隔离 + task 仅父端 | s04 Subagents |
| 持久队友 spawn_teammate + MessageBus | s09 / s20 |
| 身份重注入 | s11 |
| worktree 隔离（升级改码防互覆盖） | s18 |
| 慢操作走 Background Task | s08 / s13 |
| 工具 = handler + JSON schema | s02 / s19 MCP |
| RAG 八环（清洗→元数据→分块→embedding→混合召回→连坐→rerank→数据闭环） | 《RAG 知识库建设实战》 |
| 自治生命周期 WORK→IDLE→SHUTDOWN | s17 |

---

## 十一、三 Agent 差异化速查（编码时反复对照）

| | 主力(Java) | 侦察(Python) | 升级(Python) |
|---|---|---|---|
| **角色** | 业务编排者 | 观测分析者 | 执行变更者 |
| **功能数** | 8 | 7 | 6 + 并发/回滚/公告策略 |
| **循环驱动** | 业务请求+定时 | 任务看板+同步握手 | MQ+定时+手动+收件箱 |
| **触发源** | 业务请求/自评 | 评估任务/主力握手 | 清单到点/紧急直通/管理员手动（MQ只入待规划池） |
| **对业务数据** | 读写 | 只读 | 改源码 |
| **对外** | 是 | 否 | 否 |
| **状态机** | 订单/秒杀/支付 | 无 | 发布状态(0/5/50/100) |
| **独有能力** | 对外API服务 | 评估打分 | 局部/整体回滚 + 业务公告 |
| **子Agent用途** | 并行生成 | 并行分析 | 护栏(审查/观察/回滚) |
| **限流角色** | 被限流 | 发起(LLM成本) | 发起(worktree并发) |
| **失败模式** | 降级保活 | 延迟评估 | 改进点回pending下次再试/局部回滚/整体回滚 |
| **L1/L2/L3** | 不参与 | 产level | 执行分档 |
| **RAG检索** | 相似实现few-shot | 历史错误模式 | 修复案例+失败案例(优先) |

---

## 十二、下一步

设计已到编码级。下一步可产出：
1. `docker-compose.yml`（11 个服务）
2. 三服务最小骨架（Java Spring Boot + 两个 Python FastAPI，注册 Nacos 互发现）
3. RAG 索引构建脚本（教育买课平台规范/历史接口/缺陷案例入库）
4. 升级 Agent worktree 流水线可跑 demo
