import type { AgentWorker } from "@firefly/agent-kernel";
import type { AgentResult, ArtifactRef, ChangeSet, VerificationReport } from "@firefly/contracts";
import { assertContract } from "@firefly/contracts";
import { ExperienceEngineerAgent, ExperienceEngineerStub } from "@firefly/experience-engineer";
import { LearningDirectorAgent } from "@firefly/learning-director";
import { LearningScientistAgent } from "@firefly/learning-scientist";
import { createPiAiModelGateway, type ModelGatewayConfiguration, type TextGenerationPort } from "@firefly/model-gateway";
import { ModelInvocationRepository, type QuestLabDatabase } from "@firefly/persistence";
import type { PluginEngineeringTool, SandboxReleaseEvidence } from "@firefly/plugin-platform";
import type { Kysely } from "kysely";

export function createAuditedPiAiModelGateway(
  configuration: ModelGatewayConfiguration,
  db: Kysely<QuestLabDatabase>,
) {
  const repository = new ModelInvocationRepository(db);
  return createPiAiModelGateway(configuration, {
    observer: {
      async record(invocation) {
        await repository.record(invocation);
      },
    },
  });
}

export function createModelAssistedWorkers(gateway: TextGenerationPort): readonly AgentWorker[] {
  return [
    new LearningDirectorAgent(gateway),
    new LearningScientistAgent(gateway),
    // Engineer remains deterministic until its model proposal and M3 worktree share one lifecycle.
    new ExperienceEngineerStub(),
  ];
}

export function createModelBackedWorkers(
  gateway: TextGenerationPort,
  engineering: PluginEngineeringTool,
): readonly AgentWorker[] {
  return [
    new LearningDirectorAgent(gateway),
    new LearningScientistAgent(gateway),
    new ExperienceEngineerAgent(gateway, engineering),
  ];
}

export interface VerifiedEngineerEvidence {
  readonly change_set: ChangeSet;
  readonly verification: VerificationReport;
  readonly sandbox: SandboxReleaseEvidence;
}

export function extractVerifiedEngineerEvidence(result: AgentResult): VerifiedEngineerEvidence {
  const changeSet = result.output.change_set;
  const verification = result.output.verification_report;
  const sandbox = result.output.sandbox_execution;
  assertContract("ChangeSet", changeSet);
  assertContract("VerificationReport", verification);
  if (!isRecord(sandbox) || !Array.isArray(sandbox.checks) || !isRecord(sandbox.limits)) {
    throw new TypeError("Engineer result is missing Sandbox release evidence");
  }
  if (
    !["passed", "failed"].includes(String(sandbox.status)) ||
    sandbox.runner !== "docker" ||
    sandbox.network !== "none" ||
    sandbox.read_only !== true ||
    typeof sandbox.image !== "string"
  ) {
    throw new TypeError("Engineer Sandbox evidence has an invalid execution boundary");
  }
  const checks = sandbox.checks.map((value, index) => {
    if (
      !isRecord(value) ||
      typeof value.name !== "string" ||
      !["passed", "failed"].includes(String(value.status)) ||
      typeof value.exit_code !== "number" ||
      !Number.isInteger(value.exit_code)
    ) {
      throw new TypeError(`Engineer Sandbox check ${index} is invalid`);
    }
    assertContract("ArtifactRef", value.evidence);
    return {
      name: value.name,
      status: value.status as "passed" | "failed",
      exit_code: value.exit_code,
      evidence: value.evidence as unknown as ArtifactRef,
    };
  });
  const limits = sandbox.limits;
  for (const field of ["timeout_ms", "memory_mb", "cpus", "pids"] as const) {
    if (typeof limits[field] !== "number" || !Number.isFinite(limits[field])) {
      throw new TypeError(`Engineer Sandbox limit ${field} is invalid`);
    }
  }
  return {
    change_set: changeSet as unknown as ChangeSet,
    verification: verification as unknown as VerificationReport,
    sandbox: {
      status: sandbox.status as "passed" | "failed",
      runner: "docker",
      image: sandbox.image,
      network: "none",
      read_only: true,
      limits: {
        timeout_ms: limits.timeout_ms as number,
        memory_mb: limits.memory_mb as number,
        cpus: limits.cpus as number,
        pids: limits.pids as number,
      },
      checks,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
