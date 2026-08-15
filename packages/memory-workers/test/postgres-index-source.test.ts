import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { ArtifactRef } from "@firefly/contracts";

import { BinaryTextArtifactReadPort, IndexBuildWorkerError } from "../src/index.ts";

function artifact(mediaType = "text/plain", bytes = new TextEncoder().encode("hello text")): ArtifactRef {
  return {
    artifact_id: "artifact.text.source",
    uri: "s3://questlab/memories/source.txt",
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    media_type: mediaType,
    scope: "tenant",
    owner_id: "tenant.test",
    lineage_ids: [],
  };
}

test("text Artifact reader verifies S3 location, UTF-8 and immutable digest", async () => {
  const bytes = new TextEncoder().encode("hello text");
  const reader = new BinaryTextArtifactReadPort({
    readObject: async (input) => {
      assert.deepEqual(input, { bucket: "questlab", key: "memories/source.txt", max_bytes: 1024 });
      return bytes;
    },
  });
  assert.equal(await reader.readText({ artifact: artifact(), max_bytes: 1024 }), "hello text");
});

test("text Artifact reader rejects multimodal bytes until a governed parser creates text", async () => {
  const reader = new BinaryTextArtifactReadPort({ readObject: async () => new Uint8Array([1, 2, 3]) });
  await assert.rejects(
    reader.readText({ artifact: artifact("application/pdf"), max_bytes: 1024 }),
    (error: unknown) => error instanceof IndexBuildWorkerError && error.code === "TEXT_SOURCE_REQUIRES_PARSER",
  );
});

test("text Artifact reader rejects a digest mismatch and invalid UTF-8", async () => {
  const bytes = new TextEncoder().encode("actual");
  const reader = new BinaryTextArtifactReadPort({ readObject: async () => bytes });
  const wrong = { ...artifact(), digest: `sha256:${"0".repeat(64)}` as `sha256:${string}` };
  await assert.rejects(
    reader.readText({ artifact: wrong, max_bytes: 1024 }),
    (error: unknown) => error instanceof IndexBuildWorkerError && error.code === "TEXT_SOURCE_DIGEST_MISMATCH",
  );
  const invalid = new BinaryTextArtifactReadPort({ readObject: async () => new Uint8Array([0xff, 0xfe]) });
  const invalidArtifact = artifact("text/plain", new Uint8Array([0xff, 0xfe]));
  await assert.rejects(
    invalid.readText({ artifact: invalidArtifact, max_bytes: 1024 }),
    (error: unknown) => error instanceof IndexBuildWorkerError && error.code === "TEXT_SOURCE_INVALID_UTF8",
  );
});
