import assert from "node:assert/strict";
import test from "node:test";

import type { IndexEvaluationSet } from "@firefly/contracts";
import { indexEvaluationSetDigest, parseIndexEvaluationSetJson } from "../src/index.ts";

test("evaluation set JSON loader verifies contract and canonical Artifact digest", () => {
  const payload = {
    schema_version: 1,
    evaluation_set_id: "eval.loader.unit",
    logical_name: "memory.hybrid",
    thresholds: { acl: 1, recall: 0.8, citation: 1 },
    cases: [{
      case_id: "eval.case.loader.unit", stage: "lexical", query: "solar", purpose: "quality",
      principal: { tenant_id: "tenant.loader" }, max_results: 5,
      expected_memory_ids: ["memory.allowed"], forbidden_memory_ids: ["memory.denied"],
      expected_citations: [{ memory_id: "memory.allowed", artifact_id: "artifact.allowed", uri: "s3://bucket/allowed.md", digest: `sha256:${"a".repeat(64)}` as const }],
    }],
  } as const;
  const evaluationSet: IndexEvaluationSet = {
    ...payload,
    artifact_ref: {
      artifact_id: "artifact.eval.loader.unit", uri: "file:///config/eval.json",
      digest: indexEvaluationSetDigest(payload), media_type: "application/vnd.firefly.index-evaluation-set+json",
      scope: "tenant", owner_id: "tenant.loader", lineage_ids: [],
    },
  };
  const parsed = parseIndexEvaluationSetJson(Buffer.from(JSON.stringify(evaluationSet)));
  assert.equal(parsed.evaluation_set_id, evaluationSet.evaluation_set_id);
});

test("evaluation set JSON loader rejects digest drift and invalid UTF-8", () => {
  const invalid = { schema_version: 1, evaluation_set_id: "invalid" };
  assert.throws(() => parseIndexEvaluationSetJson(Buffer.from(JSON.stringify(invalid))), /v1 contract/u);
  const tampered = {
    schema_version: 1, evaluation_set_id: "eval.tampered", logical_name: "memory.hybrid",
    thresholds: { acl: 1, recall: 1, citation: 1 },
    cases: [{
      case_id: "eval.case.tampered", stage: "lexical", query: "solar", purpose: "quality",
      principal: { tenant_id: "tenant.loader" }, max_results: 5,
      expected_memory_ids: ["memory.allowed"], forbidden_memory_ids: ["memory.denied"],
      expected_citations: [{ memory_id: "memory.allowed", artifact_id: "artifact.allowed", uri: "s3://bucket/allowed.md", digest: `sha256:${"a".repeat(64)}` }],
    }],
    artifact_ref: {
      artifact_id: "artifact.eval.tampered", uri: "file:///config/eval.json", digest: `sha256:${"b".repeat(64)}`,
      media_type: "application/vnd.firefly.index-evaluation-set+json", scope: "tenant", owner_id: "tenant.loader", lineage_ids: [],
    },
  };
  assert.throws(() => parseIndexEvaluationSetJson(Buffer.from(JSON.stringify(tampered))), /canonical payload/u);
  assert.throws(() => parseIndexEvaluationSetJson(new Uint8Array([0xff, 0xfe])), /UTF-8 JSON/u);
});
