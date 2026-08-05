import { createHash } from "node:crypto";

export interface CanaryPolicy {
  readonly percentage: number;
  readonly authorized_subjects: readonly string[];
  readonly subject_prefixes: readonly string[];
}

export interface CanaryResolution {
  readonly selected_digest: `sha256:${string}`;
  readonly cohort: "canary" | "baseline";
  readonly bucket: number;
}

export class InvalidCanaryPolicyError extends Error {
  constructor(detail: string) {
    super(`Invalid canary policy: ${detail}`);
    this.name = "InvalidCanaryPolicyError";
  }
}

export function resolveCanaryVersion(input: {
  readonly release_id: string;
  readonly subject_id: string;
  readonly baseline_digest: `sha256:${string}`;
  readonly candidate_digest: `sha256:${string}`;
  readonly policy: CanaryPolicy;
}): CanaryResolution {
  validatePolicy(input.policy);
  const authorized =
    input.policy.authorized_subjects.includes(input.subject_id) ||
    input.policy.subject_prefixes.some((prefix) => input.subject_id.startsWith(prefix));
  const bucket = hashBucket(`${input.release_id}:${input.subject_id}`);
  const selected = authorized && bucket < input.policy.percentage;
  return {
    selected_digest: selected ? input.candidate_digest : input.baseline_digest,
    cohort: selected ? "canary" : "baseline",
    bucket,
  };
}

function validatePolicy(policy: CanaryPolicy): void {
  if (!Number.isInteger(policy.percentage) || policy.percentage < 0 || policy.percentage > 100) {
    throw new InvalidCanaryPolicyError("percentage must be an integer from 0 to 100");
  }
  if (policy.authorized_subjects.length === 0 && policy.subject_prefixes.length === 0) {
    throw new InvalidCanaryPolicyError("an explicit subject allowlist or prefix is required");
  }
}

function hashBucket(value: string): number {
  return createHash("sha256").update(value).digest().readUInt32BE(0) % 100;
}
