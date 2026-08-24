/**
 * 为 Agent 能力评测播种结构化事实（StructuredEvent + StructuredEdge）。
 *
 * 为什么需要单独播种：scripts/rag-seed.mjs 只造 memory_chunk（文本证据），
 * structured_event / structured_edge 两张表是空的。而计数、比较、时间点、多跳这四类 intent
 * 全部走结构化事实层，事实为空时它们会**正确地** fail closed。
 * 用空表评测"工具选对了没有"是可以的，但评不了"选对之后答案对不对"，
 * 那样 tool_correctness 会好看而 rubric 会莫名偏低，两个指标互相矛盾却找不到原因。
 *
 * 事实是构造的、可复现的，因此每条查询的正确答案在播种时就已知（写进 expectedAnswers），
 * 不需要事后人工标注，也不能用系统自己的查询结果当标准答案。
 *
 * 用法：node --env-file=.eval.env scripts/eval-agent-seed.mjs [--tenant tenant.eval] [--reset]
 */
import { sql } from "kysely";

import { createDatabase } from "../packages/persistence/src/database.ts";
import { MemoryRepository } from "../packages/persistence/src/memory-repository.ts";

const argument = (name, fallback) => {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const tenantId = argument("tenant", "tenant.eval");
const reset = process.argv.includes("--reset");

if (!process.env.DATABASE_URL) throw new TypeError("DATABASE_URL is required");

const db = createDatabase(process.env.DATABASE_URL);
const memories = new MemoryRepository(db);

/**
 * 事件计划。计数刻意设成不相等且不成倍数关系，这样"算错一条"和"用了错误的聚合方式"
 * 都会体现在数字上，而不是碰巧对上。
 */
const eventPlan = [
  { subject: "learner.synthetic.01", type: "challenge_attempted", count: 7, start: "2026-01-05T00:00:00.000Z" },
  { subject: "learner.synthetic.01", type: "misconception_detected", count: 3, start: "2026-01-06T08:00:00.000Z" },
  { subject: "learner.synthetic.01", type: "delayed_review_completed", count: 2, start: "2026-01-09T09:00:00.000Z" },
  { subject: "learner.synthetic.02", type: "challenge_attempted", count: 4, start: "2026-01-05T01:00:00.000Z" },
  { subject: "learner.synthetic.02", type: "delayed_review_completed", count: 5, start: "2026-01-11T10:00:00.000Z" },
  { subject: "learner.synthetic.02", type: "misconception_detected", count: 1, start: "2026-01-07T11:30:00.000Z" },
];

/** 关系图：误概念 → 概念 → 任务，构成一条长度为 2 的确定路径。 */
const edgePlan = [
  {
    source: "misconception.constant_solar_output",
    predicate: "concerns_concept",
    target: "concept.solar_irradiance_cycle",
  },
  {
    source: "concept.solar_irradiance_cycle",
    predicate: "taught_by_mission",
    target: "mission.solar-energy.01",
  },
  // 一条无关分支，确保最短路径不是"图里只有一条边"的平凡结果。
  {
    source: "misconception.constant_solar_output",
    predicate: "concerns_concept",
    target: "concept.panel_temperature",
  },
];

const HOUR_MS = 3_600_000;

/** 结构化事实必须挂在可见的 Memory 上（assertStructuredSourceVisibility 会检查），先建来源 Memory。 */
async function seedSourceMemory() {
  const memoryId = `mem.eval.agent-facts.${tenantId}`;
  await memories.capture({
    memory_id: memoryId,
    tenant_id: tenantId,
    owner_type: "tenant",
    owner_id: tenantId,
    scope: "tenant",
    stage: "structured",
    kind: "agent-evaluation-facts",
    content_digest: `sha256:${"e".repeat(64)}`,
    metadata: { purpose: "agent-capability-evaluation" },
    confidence: 1,
    sensitivity: "internal",
    status: "active",
  });
  await memories.grant(memoryId, { type: "tenant", id: tenantId });
  return memoryId;
}

async function seedEvents(sourceMemoryId) {
  let written = 0;
  for (const plan of eventPlan) {
    const base = new Date(plan.start).getTime();
    for (let index = 0; index < plan.count; index += 1) {
      // 事件时间等间隔递增，使 first/last 的正确答案完全确定。
      const occurredFrom = new Date(base + index * HOUR_MS);
      await memories.recordEvent({
        event_id: `se.eval.${plan.subject}.${plan.type}.${index}`,
        tenant_id: tenantId,
        subject_id: plan.subject,
        event_type: plan.type,
        object: { ordinal: index, mission_id: "mission.solar-energy.01" },
        scope: "tenant",
        owner_id: tenantId,
        occurred_from: occurredFrom,
        dedupe_key: `eval:${plan.subject}:${plan.type}:${index}`,
        source_memory_ids: [sourceMemoryId],
        confidence: 1,
      });
      written += 1;
    }
  }
  return written;
}

async function seedEdges(sourceMemoryId) {
  let written = 0;
  for (const [index, plan] of edgePlan.entries()) {
    await memories.recordEdge({
      edge_id: `sg.eval.${index}`,
      tenant_id: tenantId,
      source_node_id: plan.source,
      predicate: plan.predicate,
      target_node_id: plan.target,
      direction: "directed",
      scope: "tenant",
      owner_id: tenantId,
      valid_from: new Date("2026-01-01T00:00:00.000Z"),
      dedupe_key: `eval:edge:${index}`,
      source_memory_ids: [sourceMemoryId],
      confidence: 1,
    });
    written += 1;
  }
  return written;
}

/**
 * 播种规则直接决定的正确答案。
 *
 * 这些值由上面的 eventPlan / edgePlan 推导，而不是查询系统得到的——评测必须能发现
 * "系统与自己一致但都错了"的情况。
 */
export function expectedAnswers() {
  const countOf = (subject, type) =>
    eventPlan.find((plan) => plan.subject === subject && plan.type === type)?.count ?? 0;
  const timeOf = (subject, type, selector) => {
    const plan = eventPlan.find((item) => item.subject === subject && item.type === type);
    if (!plan) return null;
    const base = new Date(plan.start).getTime();
    return new Date(selector === "first" ? base : base + (plan.count - 1) * HOUR_MS).toISOString();
  };
  return {
    "t.count.basic": { count: countOf("learner.synthetic.01", "challenge_attempted") },
    "t.count.scoped": { count: countOf("learner.synthetic.02", "delayed_review_completed") },
    "t.compare.two-learners": {
      left: countOf("learner.synthetic.01", "challenge_attempted"),
      right: countOf("learner.synthetic.02", "challenge_attempted"),
      difference:
        countOf("learner.synthetic.01", "challenge_attempted") -
        countOf("learner.synthetic.02", "challenge_attempted"),
    },
    "t.temporal.first": { event_time: timeOf("learner.synthetic.01", "misconception_detected", "first") },
    "t.temporal.last": { event_time: timeOf("learner.synthetic.02", "delayed_review_completed", "last") },
    "t.multihop.path": { hops: 2, nodes: ["misconception.constant_solar_output", "concept.solar_irradiance_cycle", "mission.solar-energy.01"] },
  };
}

if (import.meta.url === (process.argv[1] ? new URL(`file://${process.argv[1].replace(/\\/gu, "/")}`).href : "")) {
  try {
    if (reset) {
      // 只删本脚本自己写入的 ID 前缀，避免清掉别的评测数据。
      await sql`DELETE FROM questlab.structured_event WHERE event_id LIKE 'se.eval.%'`.execute(db);
      await sql`DELETE FROM questlab.structured_edge WHERE edge_id LIKE 'sg.eval.%'`.execute(db);
      process.stderr.write("已清除既有 se.eval.* / sg.eval.* 事实\n");
    }
    const sourceMemoryId = await seedSourceMemory();
    const events = await seedEvents(sourceMemoryId);
    const edges = await seedEdges(sourceMemoryId);
    process.stdout.write(`${JSON.stringify({
      tenant_id: tenantId,
      source_memory_id: sourceMemoryId,
      events_written: events,
      edges_written: edges,
      expected_answers: expectedAnswers(),
    }, null, 2)}\n`);
  } finally {
    await db.destroy();
  }
}
