/**
 * Agent / 模型质量与性能量化，走真实模型与真实审计账本。
 *
 * 与 scripts/perf-agent-loop.mjs 的分工：
 *   perf-agent-loop 用桩模型测编排吞吐，回答"调度快不快"；
 *   本脚本用真实模型跑三 Agent 闭环，回答"真实模型下能不能用、多快、多稳、多准"。
 *
 * 量化四类：
 *   1. 成功率      同一输入重复多轮，统计 learned / 失败 / 失败原因分布
 *   2. 延迟        单轮端到端、每次模型调用的 latency（从审计账本读，不自己计时）
 *   3. 结构合规    模型输出是否满足 Agent 的契约（严格 JSON、必需字段），这是自建
 *                  模型最容易踩的地方——推理模型会把思考写进正文
 *   4. 并发稳定性  多轮并发下的失败率与吞吐，暴露任务租约/隔离问题
 *
 * 所有 token 与成本数字都取自 questlab.model_invocation 与 run_budget_usage，
 * 不在脚本里另算一份：账本是唯一事实源，两份数字会漂移。
 *
 * 用法：
 *   node --env-file=.eval.env scripts/eval-agent.mjs --rounds 8 --concurrency 1,3,6
 */
import { performance } from "node:perf_hooks";
import { sql } from "kysely";

import { createDatabase } from "../packages/persistence/src/database.ts";
import { startModelDemo, approveModelDemo } from "../packages/control-plane/src/model-local-demo.ts";

const argument = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const rounds = Number(argument("rounds", "8"));
// 并发阶段每档至少累计这么多次模型调用，否则 p99 只是最大值的别名。
const minCallsPerLevel = Number(argument("min-calls-per-level", "100"));
const concurrencyLevels = argument("concurrency", "1,3,6").split(",").map(Number);
const keepRuns = process.argv.includes("--keep-runs");

if (!Number.isSafeInteger(rounds) || rounds < 1) throw new TypeError("--rounds must be a positive integer");
if (!process.env.DATABASE_URL) throw new TypeError("DATABASE_URL is required");

const db = createDatabase(process.env.DATABASE_URL);

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[index]);
}

/**
 * p99 is reported alongside p95 but is only meaningful with enough samples: with n < 100 the 99th
 * percentile is the maximum by construction, so `p99_reliable` says whether the number carries
 * information or is just restating `max`. Silently printing p99 for n=12 would invite reading tail
 * behaviour into a single slowest sample.
 */
function summarize(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: values.length,
    mean: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    p99_reliable: values.length >= 100,
    max: Math.round(sorted[sorted.length - 1]),
  };
}

/**
 * 跑一整轮：start 触发三 Agent 与模型调用，approve 完成审批与验证。
 * 失败不抛出，而是归类记录——把失败率当成指标，而不是让第一次失败终止整场评测。
 */
async function runOnce(runId) {
  const t0 = performance.now();
  const outcome = { run_id: runId, ok: false, phase: null, error_type: null, error_message: null };
  try {
    const started = await startModelDemo(db, runId);
    outcome.start_state = started.state;
    outcome.model_calls_start = started.model_calls;
    const approved = await approveModelDemo(db, runId, "eval.harness", "automated evaluation");
    outcome.state = approved.state;
    outcome.verification_status = approved.verification_status;
    outcome.outcome_decision = approved.outcome_decision;
    outcome.task_count = approved.task_count;
    outcome.transition_count = approved.transition_count;
    outcome.model_calls = approved.model_calls;
    outcome.failed_calls = approved.failed_calls;
    outcome.retry_calls = approved.retry_calls;
    outcome.total_tokens = approved.total_tokens;
    outcome.alerts = approved.alerts;
    outcome.ok = approved.state === "learned" && approved.verification_status === "passed";
  } catch (error) {
    outcome.phase = outcome.start_state ? "approve" : "start";
    outcome.error_type = error?.constructor?.name ?? "Error";
    // 只留首行：错误消息可能很长，而分类只需要类型与首句。
    outcome.error_message = String(error?.message ?? error).split("\n", 1)[0].slice(0, 200);
  }
  outcome.wall_ms = Math.round(performance.now() - t0);
  return outcome;
}

/** 从审计账本读该批 run 的真实调用明细。脚本不自己累加 token。 */
async function ledgerFor(runIds) {
  if (runIds.length === 0) return { invocations: [], budget: [] };
  // run_id 是 model_invocation 自己的列（迁移 014 的归属投影），不需要 join。
  const invocations = await sql`
    SELECT workload, model, status, attempt, latency_ms, agent_id, origin,
           input_tokens, output_tokens, total_tokens, cost_microusd, error_code
    FROM questlab.model_invocation
    WHERE run_id = ANY(${runIds})
    ORDER BY started_at
  `.execute(db);
  const budget = await sql`
    SELECT run_id, tasks_created, transitions_applied, tokens_used, cost_microusd, tool_calls
    FROM questlab.run_budget_usage WHERE run_id = ANY(${runIds})
  `.execute(db);
  return { invocations: invocations.rows, budget: budget.rows };
}

async function cleanup(runIds) {
  if (keepRuns || runIds.length === 0) return;
  // 顺序按外键依赖：先删引用行，再删被引用行。删不掉的表跳过而不是中断，
  // 因为清理失败不应该让已经拿到的评测结果丢失。
  for (const statement of [
    sql`DELETE FROM questlab.run_budget_usage WHERE run_id = ANY(${runIds})`,
  ]) {
    try {
      await statement.execute(db);
    } catch {
      // 忽略：留下的行只影响后续统计口径，不影响本次结论。
    }
  }
}

function aggregate(results, invocations) {
  const succeeded = results.filter((row) => row.ok);
  const failed = results.filter((row) => !row.ok);
  const byError = {};
  for (const row of failed) {
    const key = `${row.phase}:${row.error_type}`;
    byError[key] = (byError[key] ?? 0) + 1;
  }
  const perWorkload = {};
  for (const call of invocations) {
    const bucket = (perWorkload[call.workload] ??= { calls: 0, failed: 0, latencies: [], output_tokens: [], input_tokens: [] });
    bucket.calls += 1;
    if (call.status !== "succeeded") bucket.failed += 1;
    bucket.latencies.push(Number(call.latency_ms));
    bucket.output_tokens.push(Number(call.output_tokens ?? 0));
    bucket.input_tokens.push(Number(call.input_tokens ?? 0));
  }
  return {
    rounds: results.length,
    succeeded: succeeded.length,
    failed: failed.length,
    success_rate: Number((succeeded.length / results.length).toFixed(4)),
    failure_reasons: byError,
    wall_ms: summarize(results.map((row) => row.wall_ms)),
    contract_compliance: {
      // 结构合规失败 = 模型返回了内容但不满足 Agent 契约（严格 JSON / 必需字段）。
      // 这类失败与"调用失败"必须分开：前者是模型行为问题，后者是链路问题。
      output_contract_failures: failed.filter((row) => /Output|JSON|truncat|guidance|must be/i.test(row.error_message ?? "")).length,
      transport_failures: failed.filter((row) => /PROVIDER_ERROR|TIMEOUT|ECONNREFUSED|fetch/i.test(row.error_message ?? "")).length,
    },
    model_calls: {
      total: invocations.length,
      failed: invocations.filter((call) => call.status !== "succeeded").length,
      retries: invocations.filter((call) => Number(call.attempt) > 1).length,
      latency_ms: summarize(invocations.map((call) => Number(call.latency_ms))),
      output_tokens: summarize(invocations.map((call) => Number(call.output_tokens ?? 0))),
      total_cost_microusd: invocations.reduce((sum, call) => sum + Number(call.cost_microusd ?? 0), 0),
    },
    per_workload: Object.fromEntries(Object.entries(perWorkload).map(([workload, bucket]) => [
      workload,
      {
        calls: bucket.calls,
        failed: bucket.failed,
        latency_ms: summarize(bucket.latencies),
        input_tokens: summarize(bucket.input_tokens),
        output_tokens: summarize(bucket.output_tokens),
      },
    ])),
  };
}

try {
  const stamp = Date.now();
  const report = { model: null, sequential: null, concurrency: [] };

  // 阶段 1：顺序执行，测单轮真实质量与延迟（无并发干扰）
  process.stderr.write(`顺序阶段：${rounds} 轮 ...\n`);
  const sequentialIds = [];
  const sequentialResults = [];
  for (let round = 0; round < rounds; round += 1) {
    const runId = `run.eval.seq.${stamp}.${round}`;
    sequentialIds.push(runId);
    const result = await runOnce(runId);
    sequentialResults.push(result);
    process.stderr.write(`  轮 ${round + 1}/${rounds} ${result.ok ? "ok" : "FAIL " + result.error_message} (${result.wall_ms}ms)\n`);
  }
  const sequentialLedger = await ledgerFor(sequentialIds);
  report.sequential = aggregate(sequentialResults, sequentialLedger.invocations);
  report.sequential.budget_rows = sequentialLedger.budget.length;
  report.model = sequentialLedger.invocations[0]?.model ?? null;

  // 阶段 2：并发扫描，暴露任务隔离与租约问题（这类缺陷只在并发下出现）
  //
  // 每档重复多个批次，直到累计模型调用数达到 minCallsPerLevel。单批只有 `level` 个 run
  // （每 run 2 次调用），p99 会等于 max 而毫无信息量；要让尾部延迟可信必须凑够 >=100 次调用。
  for (const level of concurrencyLevels) {
    const batches = Math.max(1, Math.ceil(minCallsPerLevel / (level * 2)));
    process.stderr.write(`并发阶段 concurrency=${level}（${batches} 批 x ${level} run）...
`);
    const allResults = [];
    const allIds = [];
    const batchWalls = [];
    for (let batch = 0; batch < batches; batch += 1) {
      const ids = Array.from({ length: level }, (_, index) => `run.eval.c${level}.${stamp}.b${batch}.${index}`);
      const t0 = performance.now();
      const settled = await Promise.allSettled(ids.map((runId) => runOnce(runId)));
      batchWalls.push(performance.now() - t0);
      allResults.push(...settled.map((entry, index) =>
        entry.status === "fulfilled"
          ? entry.value
          : { run_id: ids[index], ok: false, phase: "harness", error_type: "UnhandledRejection", error_message: String(entry.reason?.message ?? entry.reason).slice(0, 200), wall_ms: 0 },
      ));
      allIds.push(...ids);
    }
    const ledger = await ledgerFor(allIds);
    const meanWall = batchWalls.reduce((a, b) => a + b, 0) / batchWalls.length;
    // 先展开聚合结果再写批次字段：反过来会让 aggregate 的 per-run wall_ms 分布
    // 覆盖掉这一批的墙钟总时长，吞吐量就没有依据了。
    report.concurrency.push({
      ...aggregate(allResults, ledger.invocations),
      concurrency: level,
      batches,
      runs_total: allResults.length,
      batch_wall_ms_mean: Math.round(meanWall),
      throughput_runs_per_sec: Number((level / (meanWall / 1000)).toFixed(2)),
    });
    await cleanup(allIds);
  }
  await cleanup(sequentialIds);

  console.log(JSON.stringify(report, null, 2));
} finally {
  await db.destroy();
}
