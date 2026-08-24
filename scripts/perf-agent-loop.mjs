/**
 * 三 Agent 闭环延迟与并发吞吐基准。
 *
 * 使用 Stub Agent，因此测出的是治理状态机、任务租约与持久化的成本，不含模型 I/O。
 * 这是有意的：真实模型接入后延迟几乎全部由 provider 决定，混在一起就看不出平台自身的开销，
 * 也无法判断"并发多个 run 是否真的并行"。
 *
 * 在进程内直接调用，不经过 npm 脚本：命令行方式每次要付约 930ms 的 TypeScript 转译，
 * 会把 150ms 级的闭环成本完全淹没。
 *
 * 用法：
 *   node --env-file=<env> scripts/perf-agent-loop.mjs [--iterations 20] [--concurrency 1,4,8]
 */
import { createDatabase } from "../packages/persistence/src/database.ts";
import { startLocalDemo, approveLocalDemo } from "../packages/control-plane/src/local-demo.ts";
import { AdminQueryService } from "../packages/control-plane/src/admin-api.ts";

const argument = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const iterations = Number(argument("iterations", "20"));
const concurrencies = argument("concurrency", "1,4,8").split(",").map((value) => Number(value.trim()));

if (!Number.isInteger(iterations) || iterations < 1) throw new TypeError("--iterations must be a positive integer");
if (concurrencies.some((value) => !Number.isInteger(value) || value < 1)) {
  throw new TypeError("--concurrency must be a comma-separated list of positive integers");
}
if (!process.env.DATABASE_URL) throw new TypeError("DATABASE_URL is required");

/**
 * 基准脚本会写入并删除数据，必须指向专用库。
 * 误跑在 questlab 主库上会污染运行事实表与审计账本，因此这里 fail closed 而不是给出警告。
 */
function assertPerfDatabase(url) {
  const database = url.split("/").pop()?.split("?")[0] ?? "";
  if (!/perf/i.test(database)) {
    throw new Error(
      `Refusing to run a benchmark against database "${database}": ` +
      `the name must contain "perf" (e.g. questlab_perf). Benchmarks write and delete rows.`,
    );
  }
}

assertPerfDatabase(process.env.DATABASE_URL);
const db = createDatabase(process.env.DATABASE_URL);
const admin = new AdminQueryService(db);

function summarize(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  const mean = sorted.reduce((total, value) => total + value, 0) / sorted.length;
  return {
    mean: Number(mean.toFixed(1)),
    p50: Number(at(0.5).toFixed(1)),
    p95: Number(at(0.95).toFixed(1)),
    max: Number(sorted.at(-1).toFixed(1)),
  };
}

async function oneRun(runId) {
  const marks = {};
  let t = performance.now();
  await startLocalDemo(db, runId);
  marks.start = performance.now() - t;
  t = performance.now();
  await approveLocalDemo(db, runId, "perf", "baseline");
  marks.approve = performance.now() - t;
  t = performance.now();
  await admin.getEvolutionTrace(runId);
  marks.trace = performance.now() - t;
  return marks;
}

const prefix = `run.perf.${Date.now()}`;
let sequence = 0;

// 预热：首个 run 要付 JIT、连接池建立与 prepared statement 首次编译
await oneRun(`${prefix}.warm`);

const report = { iterations, unit: "ms", sequential: null, concurrent: [] };

const sequential = { start: [], approve: [], trace: [] };
for (let index = 0; index < iterations; index += 1) {
  const marks = await oneRun(`${prefix}.seq.${sequence += 1}`);
  sequential.start.push(marks.start);
  sequential.approve.push(marks.approve);
  sequential.trace.push(marks.trace);
}
report.sequential = {
  "demo:start": summarize(sequential.start),
  "demo:approve": summarize(sequential.approve),
  "getTrace(21q)": summarize(sequential.trace),
};

// 并发段会暴露一个已确认的架构约束，而不是简单地产出吞吐数字：
// ManualEvolutionWorkflow 用 `subject = agentId`（如 "experience-engineer"）派发任务，
// claimNext 也按 subject 认领，并断言 `claimed.id === taskId`。两个 run 并发时，
// A 的 Engineer 会认领到 B 的 Engineer 任务，于是抛
// "Task ... could not be leased by experience-engineer"。
// 因此这里记录失败率，而不是让脚本崩掉：失败本身就是要量化的结果。
for (const concurrency of concurrencies) {
  const total = [];
  const failures = [];
  const startedAt = performance.now();
  const batches = Math.max(1, Math.ceil(iterations / concurrency));
  for (let batch = 0; batch < batches; batch += 1) {
    const jobs = Array.from({ length: concurrency }, () => {
      const runId = `${prefix}.c${concurrency}.${sequence += 1}`;
      const jobStartedAt = performance.now();
      return oneRun(runId).then(
        () => total.push(performance.now() - jobStartedAt),
        (error) => failures.push(String(error?.message ?? error).slice(0, 120)),
      );
    });
    await Promise.all(jobs);
  }
  const elapsed = performance.now() - startedAt;
  const attempted = total.length + failures.length;
  report.concurrent.push({
    concurrency,
    attempted_runs: attempted,
    completed_runs: total.length,
    failed_runs: failures.length,
    failure_rate: Number((failures.length / attempted).toFixed(3)),
    wall_clock_ms: Number(elapsed.toFixed(0)),
    completed_runs_per_second: Number(((total.length / elapsed) * 1000).toFixed(2)),
    per_run: total.length > 0 ? summarize(total) : null,
    ...(failures.length > 0 ? { sample_failure: failures[0] } : {}),
  });
}

console.log(JSON.stringify(report, null, 2));

// 基准数据不留在库里：evolution_run 是运行事实表，留下几百条 perf 行会污染审计查询
const deleted = await db
  .deleteFrom("questlab.evolution_run")
  .where("id", "like", `${prefix}%`)
  .executeTakeFirst();
console.log(`cleaned ${Number(deleted?.numDeletedRows ?? 0)} perf runs`);
await db.destroy();
