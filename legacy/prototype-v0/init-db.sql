-- FireFly 数据库初始化
-- 包含三 Agent 共用的核心表：interface_requirement / code_manifest / release /
-- seckill_activity / order / improvement / upgrade_plan / experience / announcement

-- ========== 主力域 ==========
CREATE TABLE IF NOT EXISTS interface_requirement (
    id              VARCHAR(64) PRIMARY KEY,
    business_domain VARCHAR(32) NOT NULL,   -- course/seckill/order/pay/user
    requirement_text TEXT,
    field_table     JSONB,
    sla             JSONB,                   -- {qps, latency_p99, consistency}
    status          VARCHAR(32) NOT NULL DEFAULT 'parsed',  -- parsed/generating/testing/deploying/online/failed
    openapi_spec    JSONB,
    nfr             JSONB,
    clarification_questions JSONB,
    created_by      VARCHAR(64),
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS code_manifest (
    id              VARCHAR(64) PRIMARY KEY,
    requirement_id  VARCHAR(64) REFERENCES interface_requirement(id),
    version         VARCHAR(32) NOT NULL,
    files           JSONB NOT NULL,          -- [{path, layer, content_hash}]
    coverage        FLOAT,
    build_status    VARCHAR(32),
    git_tag         VARCHAR(64),
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS release (
    id              VARCHAR(64) PRIMARY KEY,
    service         VARCHAR(64) NOT NULL,
    version         VARCHAR(32) NOT NULL,
    manifest_id     VARCHAR(64) REFERENCES code_manifest(id),
    strategy        VARCHAR(32) DEFAULT 'canary',
    canary_pct      INT DEFAULT 0,           -- 0/5/50/100
    status          VARCHAR(32) DEFAULT '0', -- 0/5/50/100/rolled_back
    health_score    FLOAT,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS seckill_activity (
    id              VARCHAR(64) PRIMARY KEY,
    course_id       VARCHAR(64) NOT NULL,
    origin_price    DECIMAL(10,2),
    seckill_price   DECIMAL(10,2),
    stock           INT NOT NULL,
    per_user_limit  INT DEFAULT 1,
    start_time      TIMESTAMP,
    end_time        TIMESTAMP,
    status          VARCHAR(32) DEFAULT 'not_started'  -- not_started/running/ended/sold_out
);

CREATE TABLE IF NOT EXISTS "order" (
    id              VARCHAR(64) PRIMARY KEY,
    user_id         VARCHAR(64) NOT NULL,
    course_id       VARCHAR(64),
    seckill_id      VARCHAR(64),
    amount          DECIMAL(10,2),
    status          VARCHAR(32) NOT NULL DEFAULT 'pending',  -- pending/paid/done/canceled/refunding/refunded
    out_trade_no    VARCHAR(64) UNIQUE,        -- 支付幂等用
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    paid_at         TIMESTAMP,
    timeout_at      TIMESTAMP                  -- 超时取消时间点
);

-- ========== 侦察域 ==========
CREATE TABLE IF NOT EXISTS improvement (
    id              VARCHAR(64) PRIMARY KEY,
    target_service  VARCHAR(64) NOT NULL,
    target_file     VARCHAR(256),
    problem_desc    TEXT,
    evidence        JSONB,                     -- {metric, log_snippet, score_drop}
    suggestion      TEXT,
    priority        VARCHAR(8) NOT NULL,       -- P0/P1/P2
    level           VARCHAR(8) NOT NULL,       -- L1/L2/L3
    status          VARCHAR(32) NOT NULL DEFAULT 'pending',  -- pending/running/done/rolled_back/needs_human
    fail_count      INT DEFAULT 0,
    plan_id         VARCHAR(64),               -- 所属升级清单
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    consumed_by     VARCHAR(64)
);
CREATE INDEX IF NOT EXISTS idx_improvement_status ON improvement(status);
CREATE INDEX IF NOT EXISTS idx_improvement_priority ON improvement(priority);

CREATE TABLE IF NOT EXISTS evaluation_baseline (
    id              SERIAL PRIMARY KEY,
    service         VARCHAR(64) NOT NULL,
    overall_score   FLOAT,
    dimensions      JSONB,
    recorded_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ========== 升级域 ==========
CREATE TABLE IF NOT EXISTS upgrade_plan (
    plan_id         VARCHAR(64) PRIMARY KEY,
    name            VARCHAR(128) NOT NULL,
    improvement_ids JSONB NOT NULL,            -- ["imp-001", ...]
    scheduled_at    TIMESTAMP,
    mode            VARCHAR(16) DEFAULT 'normal',  -- normal/emergency
    priority        VARCHAR(8) DEFAULT 'P2',
    status          VARCHAR(32) DEFAULT 'draft',   -- draft/scheduled/running/done/partial_rolled_back/rolled_back
    created_by      VARCHAR(64),               -- admin/auto
    max_batch_size  INT DEFAULT 5,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_plan_status ON upgrade_plan(status);
CREATE INDEX IF NOT EXISTS idx_plan_scheduled ON upgrade_plan(scheduled_at);

-- ========== 经验库（Postgres 侧，向量在 Milvus）==========
CREATE TABLE IF NOT EXISTS experience (
    id              VARCHAR(64) PRIMARY KEY,
    type            VARCHAR(32) NOT NULL,      -- implementation/spec/defect_case/fix_case/failure_case/review_rule
    content         TEXT NOT NULL,
    domain          VARCHAR(32),
    tags            JSONB,
    outcome         VARCHAR(16),               -- success/failure
    milvus_id       VARCHAR(64),               -- 对应 Milvus 向量 id
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_experience_type ON experience(type);

-- ========== 业务公告 ==========
CREATE TABLE IF NOT EXISTS announcement (
    id              VARCHAR(64) PRIMARY KEY,
    plan_id         VARCHAR(64),
    level           VARCHAR(16) NOT NULL,      -- info/warning/critical
    title           VARCHAR(256),
    content         TEXT,
    affected_apis   JSONB,
    status          VARCHAR(16) DEFAULT 'active',  -- active/resolved
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ========== 任务看板（三 agent 协作）==========
CREATE TABLE IF NOT EXISTS task_board (
    id              VARCHAR(64) PRIMARY KEY,
    type            VARCHAR(32) NOT NULL,      -- evaluate/upgrade/cleanup
    payload         JSONB,
    status          VARCHAR(16) DEFAULT 'open', -- open/claimed/done/failed
    owner           VARCHAR(32),               -- main/scout/upgrade
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    claimed_at      TIMESTAMP
);
