import { createHash } from "node:crypto";

import {
  assertContract,
  type EvidenceCitation,
  type IndexBuildTask,
  type IndexEvaluationCase,
  type IndexEvaluationSet,
  type IndexQualityCheck,
} from "@firefly/contracts";

import type { IndexQualityProbe, IndexReadyGateInput } from "./index-build-worker.ts";

export type IndexEvaluationSetPayload = Omit<IndexEvaluationSet, "artifact_ref">;

export interface IndexQualityEvaluationHit {
  readonly chunk_id: string;
  readonly memory_id: string;
  readonly score: number;
  readonly citation: EvidenceCitation;
}

export interface IndexQualitySearchPort {
  search(input: {
    readonly task: IndexBuildTask;
    readonly evaluation_case: IndexEvaluationCase;
  }): Promise<readonly IndexQualityEvaluationHit[]>;
}

interface IndexQualityCaseResult {
  readonly evaluation_case: IndexEvaluationCase;
  readonly hits: readonly IndexQualityEvaluationHit[];
}

export function indexEvaluationSetDigest(
  input: IndexEvaluationSet | IndexEvaluationSetPayload,
): `sha256:${string}` {
  const payload: IndexEvaluationSetPayload = {
    schema_version: input.schema_version,
    evaluation_set_id: input.evaluation_set_id,
    logical_name: input.logical_name,
    thresholds: input.thresholds,
    cases: input.cases,
  };
  return `sha256:${createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex")}`;
}

export class FixedIndexEvaluationRunner {
  readonly evaluationSet: IndexEvaluationSet;
  private readonly search: IndexQualitySearchPort;
  private readonly runs = new Map<string, Promise<readonly IndexQualityCaseResult[]>>();

  constructor(evaluationSet: IndexEvaluationSet, search: IndexQualitySearchPort) {
    assertContract("IndexEvaluationSet", evaluationSet);
    validateEvaluationSet(evaluationSet);
    this.evaluationSet = evaluationSet;
    this.search = search;
  }

  evaluate(input: IndexReadyGateInput): Promise<readonly IndexQualityCaseResult[]> {
    const key = `${input.task.build_id}\n${input.task.index_version_id}\n${input.task.configuration_digest}`;
    const existing = this.runs.get(key);
    if (existing) return existing;
    const pending = this.run(input);
    this.runs.set(key, pending);
    return pending;
  }

  private async run(input: IndexReadyGateInput): Promise<readonly IndexQualityCaseResult[]> {
    if (input.task.logical_name !== this.evaluationSet.logical_name) {
      throw new TypeError("Index evaluation set logical name does not match the build task");
    }
    if (
      this.evaluationSet.artifact_ref.scope !== "public" &&
      (
        this.evaluationSet.artifact_ref.scope !== "tenant" ||
        this.evaluationSet.artifact_ref.owner_id !== input.task.tenant_id
      )
    ) {
      throw new TypeError("Index evaluation set Artifact must be public or owned by the build tenant");
    }
    if (this.evaluationSet.cases.some((item) => item.principal.tenant_id !== input.task.tenant_id)) {
      throw new TypeError("Index evaluation principals must belong to the build tenant");
    }

    return Promise.all(this.evaluationSet.cases.map(async (evaluationCase) => {
      const hits = await this.search.search({ task: input.task, evaluation_case: evaluationCase });
      validateEvaluationHits(hits);
      return { evaluation_case: evaluationCase, hits };
    }));
  }
}

abstract class FixedIndexQualityProbe implements IndexQualityProbe {
  abstract readonly name: "acl" | "recall" | "citation";
  protected readonly runner: FixedIndexEvaluationRunner;

  constructor(runner: FixedIndexEvaluationRunner) {
    this.runner = runner;
  }

  abstract evaluate(input: IndexReadyGateInput): Promise<Omit<IndexQualityCheck, "name">>;

  protected evidence() {
    return [this.runner.evaluationSet.artifact_ref];
  }
}

export class FixedAclQualityProbe extends FixedIndexQualityProbe {
  readonly name = "acl" as const;

  async evaluate(input: IndexReadyGateInput): Promise<Omit<IndexQualityCheck, "name">> {
    const results = await this.runner.evaluate(input);
    let samples = 0;
    let leaks = 0;
    for (const result of results) {
      const returned = new Set(result.hits.map((hit) => hit.memory_id));
      for (const memoryId of result.evaluation_case.forbidden_memory_ids) {
        samples += 1;
        if (returned.has(memoryId)) leaks += 1;
      }
    }
    const score = (samples - leaks) / samples;
    const threshold = this.runner.evaluationSet.thresholds.acl;
    return {
      passed: score >= threshold,
      score,
      threshold,
      sample_size: samples,
      summary: leaks === 0
        ? `No forbidden Memory was returned across ${samples} ACL assertions`
        : `${leaks} of ${samples} forbidden Memory assertions leaked into evaluation results`,
      evidence_refs: this.evidence(),
    };
  }
}

export class FixedRecallQualityProbe extends FixedIndexQualityProbe {
  readonly name = "recall" as const;

  async evaluate(input: IndexReadyGateInput): Promise<Omit<IndexQualityCheck, "name">> {
    const results = await this.runner.evaluate(input);
    let samples = 0;
    let recalled = 0;
    for (const result of results) {
      const returned = new Set(result.hits.map((hit) => hit.memory_id));
      for (const memoryId of result.evaluation_case.expected_memory_ids) {
        samples += 1;
        if (returned.has(memoryId)) recalled += 1;
      }
    }
    const score = recalled / samples;
    const threshold = this.runner.evaluationSet.thresholds.recall;
    return {
      passed: score >= threshold,
      score,
      threshold,
      sample_size: samples,
      summary: `${recalled} of ${samples} expected Memory assertions were recalled`,
      evidence_refs: this.evidence(),
    };
  }
}

export class FixedCitationQualityProbe extends FixedIndexQualityProbe {
  readonly name = "citation" as const;

  async evaluate(input: IndexReadyGateInput): Promise<Omit<IndexQualityCheck, "name">> {
    const results = await this.runner.evaluate(input);
    let samples = 0;
    let resolved = 0;
    for (const result of results) {
      for (const expected of result.evaluation_case.expected_citations) {
        samples += 1;
        if (result.hits.some((hit) => hit.memory_id === expected.memory_id && citationMatches(hit.citation, expected))) {
          resolved += 1;
        }
      }
    }
    const score = resolved / samples;
    const threshold = this.runner.evaluationSet.thresholds.citation;
    return {
      passed: score >= threshold,
      score,
      threshold,
      sample_size: samples,
      summary: `${resolved} of ${samples} expected Citation assertions resolved exactly`,
      evidence_refs: this.evidence(),
    };
  }
}

export function createFixedIndexQualityProbes(
  evaluationSet: IndexEvaluationSet,
  search: IndexQualitySearchPort,
): readonly [FixedAclQualityProbe, FixedRecallQualityProbe, FixedCitationQualityProbe] {
  const runner = new FixedIndexEvaluationRunner(evaluationSet, search);
  return [
    new FixedAclQualityProbe(runner),
    new FixedRecallQualityProbe(runner),
    new FixedCitationQualityProbe(runner),
  ];
}

function validateEvaluationSet(evaluationSet: IndexEvaluationSet): void {
  if (evaluationSet.artifact_ref.media_type !== "application/vnd.firefly.index-evaluation-set+json") {
    throw new TypeError("Index evaluation set Artifact has an unsupported media type");
  }
  if (evaluationSet.artifact_ref.digest !== indexEvaluationSetDigest(evaluationSet)) {
    throw new TypeError("Index evaluation set Artifact Digest does not match its canonical payload");
  }
  const caseIds = evaluationSet.cases.map((item) => item.case_id);
  if (new Set(caseIds).size !== caseIds.length) throw new TypeError("Index evaluation case IDs must be unique");

  let aclSamples = 0;
  let recallSamples = 0;
  let citationSamples = 0;
  for (const item of evaluationSet.cases) {
    if (!item.query.trim() || !item.purpose.trim()) throw new TypeError("Index evaluation queries and purposes cannot be blank");
    const expected = new Set(item.expected_memory_ids);
    if (item.forbidden_memory_ids.some((memoryId) => expected.has(memoryId))) {
      throw new TypeError("A Memory cannot be both expected and forbidden in one evaluation case");
    }
    if (item.expected_citations.some((citation) => !expected.has(citation.memory_id))) {
      throw new TypeError("Citation expectations must reference an expected Memory");
    }
    aclSamples += item.forbidden_memory_ids.length;
    recallSamples += item.expected_memory_ids.length;
    citationSamples += item.expected_citations.length;
  }
  if (aclSamples === 0 || recallSamples === 0 || citationSamples === 0) {
    throw new TypeError("Index evaluation sets require ACL, Recall and Citation assertions");
  }
}

function validateEvaluationHits(hits: readonly IndexQualityEvaluationHit[]): void {
  const ids = new Set<string>();
  for (const hit of hits) {
    if (!hit.chunk_id || !hit.memory_id || !Number.isFinite(hit.score) || hit.score < 0 || hit.score > 1) {
      throw new TypeError("Index quality evaluator returned an invalid hit");
    }
    if (ids.has(hit.chunk_id)) throw new TypeError("Index quality evaluator returned duplicate Chunk IDs");
    ids.add(hit.chunk_id);
    assertContract("EvidenceCitation", hit.citation);
  }
}

function citationMatches(
  actual: EvidenceCitation,
  expected: IndexEvaluationCase["expected_citations"][number],
): boolean {
  if (
    actual.artifact_id !== expected.artifact_id ||
    actual.uri !== expected.uri ||
    actual.digest !== expected.digest
  ) return false;
  return Object.entries(expected.locator ?? {}).every(([key, value]) => actual.locator?.[key] === value);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizeJson(item)]),
    );
  }
  return value;
}
