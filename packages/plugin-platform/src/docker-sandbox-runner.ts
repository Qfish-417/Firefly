import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

import type { ArtifactRef, ChangeSet, VerificationReport } from "@firefly/contracts";

const executeFile = promisify(execFile);

export interface SandboxCheck {
  readonly name: string;
  readonly command: readonly string[];
}

export interface SandboxLimits {
  readonly timeout_ms: number;
  readonly memory_mb: number;
  readonly cpus: number;
  readonly pids: number;
}

export interface SandboxCheckResult {
  readonly name: string;
  readonly status: "passed" | "failed";
  readonly exit_code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly evidence: ArtifactRef;
}

export interface SandboxExecutionResult {
  readonly status: "passed" | "failed";
  readonly runner: "docker";
  readonly image: string;
  readonly network: "none";
  readonly read_only: true;
  readonly limits: SandboxLimits;
  readonly checks: readonly SandboxCheckResult[];
}

export interface SandboxReleaseEvidence {
  readonly status: "passed" | "failed";
  readonly runner: "docker";
  readonly image: string;
  readonly network: "none";
  readonly read_only: true;
  readonly limits: SandboxLimits;
  readonly checks: readonly {
    readonly name: string;
    readonly status: "passed" | "failed";
    readonly exit_code: number;
    readonly evidence: ArtifactRef;
  }[];
}

export function toSandboxReleaseEvidence(
  result: SandboxExecutionResult,
): SandboxReleaseEvidence {
  return {
    status: result.status,
    runner: result.runner,
    image: result.image,
    network: result.network,
    read_only: result.read_only,
    limits: result.limits,
    checks: result.checks.map((check) => ({
      name: check.name,
      status: check.status,
      exit_code: check.exit_code,
      evidence: check.evidence,
    })),
  };
}

export class UnpinnedSandboxImageError extends Error {
  constructor(image: string) {
    super(`Sandbox image must be pinned by sha256 digest: ${image}`);
    this.name = "UnpinnedSandboxImageError";
  }
}

export class DockerSandboxRunner {
  private readonly image: string;
  private readonly dockerCommand: string;

  constructor(image: string, dockerCommand = "docker") {
    if (!/@sha256:[a-f0-9]{64}$/.test(image)) {
      throw new UnpinnedSandboxImageError(image);
    }
    this.image = image;
    this.dockerCommand = dockerCommand;
  }

  async run(input: {
    readonly run_id: string;
    readonly worktree_path: string;
    readonly owner_id: string;
    readonly checks: readonly SandboxCheck[];
    readonly limits?: SandboxLimits;
    readonly signal?: AbortSignal;
  }): Promise<SandboxExecutionResult> {
    const limits = input.limits ?? {
      timeout_ms: 30_000,
      memory_mb: 128,
      cpus: 1,
      pids: 64,
    };
    const results: SandboxCheckResult[] = [];
    for (const check of input.checks) {
      if (check.command.length === 0) {
        throw new TypeError(`Sandbox check ${check.name} has no command`);
      }
      const args = [
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        String(limits.pids),
        "--memory",
        `${limits.memory_mb}m`,
        "--cpus",
        String(limits.cpus),
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=16m",
        "--mount",
        `type=bind,source=${input.worktree_path},target=/workspace,readonly`,
        "--workdir",
        "/workspace",
        this.image,
        ...check.command,
      ];
      let stdout = "";
      let stderr = "";
      let exitCode = 0;
      try {
        const result = await executeFile(this.dockerCommand, args, {
          encoding: "utf8",
          timeout: limits.timeout_ms,
          windowsHide: true,
          maxBuffer: 1024 * 1024,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        stdout = result.stdout;
        stderr = result.stderr;
      } catch (error) {
        if (input.signal?.aborted) {
          throw error;
        }
        const failure = error as Error & { code?: number | string; stdout?: string; stderr?: string };
        exitCode = typeof failure.code === "number" ? failure.code : 1;
        stdout = failure.stdout ?? "";
        stderr = failure.stderr ?? failure.message;
      }
      const digest = createHash("sha256")
        .update(`${check.name}\0${exitCode}\0${stdout}\0${stderr}`)
        .digest("hex");
      results.push({
        name: check.name,
        status: exitCode === 0 ? "passed" : "failed",
        exit_code: exitCode,
        stdout,
        stderr,
        evidence: {
          artifact_id: `artifact.sandbox.${input.run_id}.${check.name}`,
          uri: `urn:firefly:sandbox:${input.run_id}:${check.name}`,
          digest: `sha256:${digest}`,
          media_type: "application/json",
          scope: "tenant",
          owner_id: input.owner_id,
          lineage_ids: [],
        },
      });
    }
    return {
      status: results.every((result) => result.status === "passed") ? "passed" : "failed",
      runner: "docker",
      image: this.image,
      network: "none",
      read_only: true,
      limits,
      checks: results,
    };
  }
}

export function createVerificationReport(input: {
  readonly run_id: string;
  readonly change_set: ChangeSet;
  readonly sandbox: SandboxExecutionResult;
}): VerificationReport {
  return {
    report_id: `verification.${input.run_id}`,
    changeset_id: input.change_set.changeset_id,
    status: input.sandbox.status,
    baseline_snapshot: input.change_set.source_snapshot,
    checks: input.sandbox.checks.map((check) => ({
      name: check.name,
      status: check.status,
      evidence_refs: [
        {
          ...check.evidence,
          lineage_ids: [input.change_set.plugin_artifact.artifact_id],
        },
      ],
    })),
  };
}
