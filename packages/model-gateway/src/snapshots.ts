import { createHash } from "node:crypto";

export function snapshotId(kind: string, version: string, value: unknown): string {
  const digest = createHash("sha256").update(stableJson(value)).digest("hex");
  return `${kind}:${version}:sha256:${digest}`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortValue(child)]),
    );
  }
  return value;
}
