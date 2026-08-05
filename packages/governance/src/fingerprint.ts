import { createHash } from "node:crypto";

import type { ArtifactRef, JsonObject, JsonValue } from "@firefly/contracts";

export function fingerprintTask(input: {
  readonly task_type: string;
  readonly subject: string;
  readonly payload: JsonObject;
  readonly artifact_refs: readonly ArtifactRef[];
}): `sha256:${string}` {
  const canonical = canonicalize({
    task_type: input.task_type,
    subject: input.subject,
    payload: input.payload,
    artifact_digests: input.artifact_refs.map((artifact) => artifact.digest).sort(),
  } as JsonObject);
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function canonicalize(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  const object = value as JsonObject;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key]!)}`)
    .join(",")}}`;
}
