import assert from "node:assert/strict";
import test from "node:test";

import type { ArtifactRef, DeletionPropagationTask } from "@firefly/contracts";
import { DeletionWorkerError, HttpDeletionTargetConsumer } from "../src/index.ts";

const digest = `sha256:${"a".repeat(64)}` as const;
const evidence: ArtifactRef = {
  artifact_id: "artifact.deletion-receipt.vector",
  uri: "https://vector.example.test/deletions/delete-1",
  digest,
  media_type: "application/vnd.firefly.deletion-receipt+json",
  scope: "tenant",
  owner_id: "tenant.test",
  lineage_ids: [],
};

test("HTTP deletion consumer binds provider receipt to deletion identity and target", async () => {
  let requestBody: unknown;
  const consumer = new HttpDeletionTargetConsumer({
    target: "external_vector",
    endpoint: "https://vector.example.test/v1/delete",
    headers: { authorization: "Bearer secret" },
    fetch: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({ schema_version: 1, deletion_id: "delete-1", target: "external_vector", content_digest: digest, status: "completed", evidence_refs: [evidence] });
    },
  });
  const result = await consumer.delete(task("external_vector"));
  assert.deepEqual(result, [evidence]);
  assert.equal((requestBody as { deletion: { memory_id: string } }).deletion.memory_id, "memory.test");
});

test("HTTP deletion consumer rejects mismatched or evidence-free receipts", async () => {
  const consumer = new HttpDeletionTargetConsumer({
    target: "cache",
    endpoint: "https://cache.example.test/v1/delete",
    fetch: async () => Response.json({ schema_version: 1, deletion_id: "another", target: "cache", content_digest: digest, status: "completed", evidence_refs: [] }),
  });
  await assert.rejects(
    consumer.delete(task("cache")),
    (error: unknown) => error instanceof DeletionWorkerError && !error.retryable && error.code === "DELETION_PROVIDER_INVALID_RESPONSE",
  );
});

test("HTTP deletion consumer allows insecure transport only for explicit localhost development", () => {
  assert.throws(() => new HttpDeletionTargetConsumer({ target: "cache", endpoint: "http://cache.internal/delete" }), /HTTPS/u);
  assert.doesNotThrow(() => new HttpDeletionTargetConsumer({ target: "cache", endpoint: "http://127.0.0.1:9000/delete", allow_insecure_localhost: true }));
});

test("HTTP deletion consumer classifies provider status retryability", async () => {
  const retryable = new HttpDeletionTargetConsumer({ target: "external_lexical", endpoint: "https://search.example.test/delete", fetch: async () => new Response("unavailable", { status: 503 }) });
  await assert.rejects(retryable.delete(task("external_lexical")), (error: unknown) => error instanceof DeletionWorkerError && error.retryable);
  const permanent = new HttpDeletionTargetConsumer({ target: "external_lexical", endpoint: "https://search.example.test/delete", fetch: async () => new Response("bad request", { status: 400 }) });
  await assert.rejects(permanent.delete(task("external_lexical")), (error: unknown) => error instanceof DeletionWorkerError && !error.retryable);
});

function task(target: DeletionPropagationTask["target"]): DeletionPropagationTask {
  return { schema_version: 1, deletion_id: "delete-1", memory_id: "memory.test", tenant_id: "tenant.test", target, content_digest: digest, resource_refs: [], requested_at: "2026-08-16T00:00:00.000Z" };
}
