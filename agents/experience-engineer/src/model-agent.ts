import { createHash } from "node:crypto";

import type {
  AgentResult,
  ArtifactRef,
  ImprovementPlan,
  JsonObject,
  PatchProposal,
  TaskEnvelope,
} from "@firefly/contracts";
import { assertContract } from "@firefly/contracts";
import {
  InvalidAgentTaskPayloadError,
  assertTaskAccepted,
  completedAgentResult,
  requireObject,
  type AgentExecutionContext,
  type AgentWorker,
} from "@firefly/agent-kernel";
import {
  snapshotId,
  type GenerationResult,
  type TextGenerationPort,
} from "@firefly/model-gateway";
import type {
  PluginEngineeringTool,
  PluginSourceFile,
  WorktreePatchFile,
} from "@firefly/plugin-platform";

const PATCH_PROMPT_VERSION = "experience-engineer.patch-proposal.v1";
const PATCH_SYSTEM_PROMPT = `You are the Experience Engineer in FireFly QuestLab.
Return exactly one JSON object without Markdown and do not call tools.
You may propose complete replacement content only for paths listed in approved_paths.
Never provide a Git commit, artifact digest, approval, verification result, command, or release decision.
The object must be {"patch_files":[{"path":"...","content":"..."}],
"risk_declaration":["..."]}. Include only files that need changes. Preserve public contracts and
write deterministic, dependency-free code unless the approved source requires otherwise.`;

export class EngineerModelOutputError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EngineerModelOutputError";
  }
}

export class ExperienceEngineerAgent implements AgentWorker {
  readonly id = "experience-engineer" as const;
  readonly taskTypes = ["BuildPluginChangeTask"] as const;
  private readonly gateway: TextGenerationPort;
  private readonly engineering: PluginEngineeringTool;

  constructor(gateway: TextGenerationPort, engineering: PluginEngineeringTool) {
    this.gateway = gateway;
    this.engineering = engineering;
  }

  async execute(task: TaskEnvelope, context: AgentExecutionContext): Promise<AgentResult> {
    context.signal?.throwIfAborted();
    assertTaskAccepted(this, task, "BuildPluginChangeTask");
    const plan = requireObject(
      task.payload.plan,
      task.message_type,
      "plan",
    ) as unknown as ImprovementPlan;
    assertContract("ImprovementPlan", plan);
    if (plan.status !== "approved" || !plan.approved_by || !plan.approved_at) {
      throw new InvalidAgentTaskPayloadError(task.message_type, "an approved plan is required");
    }

    const sourceFiles = await this.engineering.loadApprovedSource(plan, context.signal);
    validateSourceFiles(sourceFiles, plan);
    const promptSnapshot = snapshotId("prompt", PATCH_PROMPT_VERSION, PATCH_SYSTEM_PROMPT);
    const knowledgeSnapshot = snapshotId("knowledge", "approved-plugin-source.v1", {
      source_snapshot: plan.target_artifact,
      files: sourceFiles.map((file) => ({
        path: file.path,
        digest: digestText(file.content),
        byte_length: Buffer.byteLength(file.content, "utf8"),
      })),
    });
    const model = await this.gateway.generate({
      request_id: `model.${task.message_id}`,
      workload: "experience-engineer.patch",
      system_prompt: PATCH_SYSTEM_PROMPT,
      user_prompt: JSON.stringify({
        plan_id: plan.plan_id,
        approved_paths: plan.allowed_paths,
        verification_contract: plan.verification_contract,
        source_files: sourceFiles,
      }),
      max_output_tokens: Math.min(8_000, task.budget.max_tokens),
      budget: {
        max_tokens: task.budget.max_tokens,
        max_cost_usd: task.budget.max_cost_usd,
        max_duration_ms: task.budget.max_duration_sec * 1_000,
      },
      snapshots: {
        prompt: promptSnapshot,
        tools: "tools:none:model-gateway.v1",
        knowledge: knowledgeSnapshot,
      },
      temperature: 0,
      ...(context.signal ? { signal: context.signal } : {}),
    });
    if (model.finish_reason === "length") {
      throw new EngineerModelOutputError("Patch proposal was truncated by the model");
    }
    const proposed = parsePatchProposal(model.text, plan);
    const proposal = createPatchProposal(task, plan, proposed);
    assertContract("PatchProposal", proposal.summary);

    const candidate = await this.engineering.buildAndVerify({
      run_id: task.correlation_id,
      plan,
      patch_files: proposal.patchFiles,
      ...(context.signal ? { signal: context.signal } : {}),
    });
    assertContract("ChangeSet", candidate.change_set);
    assertContract("VerificationReport", candidate.verification);
    if (
      candidate.change_set.plan_id !== plan.plan_id ||
      candidate.change_set.source_snapshot.digest !== plan.target_artifact.digest ||
      candidate.verification.changeset_id !== candidate.change_set.changeset_id
    ) {
      throw new EngineerModelOutputError("Engineering tool returned evidence for a different plan");
    }

    const evidence = candidate.verification.checks.flatMap((check) => check.evidence_refs);
    const artifacts = uniqueArtifacts([
      proposal.summary.proposal_artifact,
      candidate.change_set.plugin_artifact,
      ...candidate.change_set.generated_tests,
      ...evidence,
    ]);
    return modelResult(
      task,
      {
        patch_proposal: proposal.summary as unknown as JsonObject,
        change_set: candidate.change_set as unknown as JsonObject,
        verification_report: candidate.verification as unknown as JsonObject,
        sandbox_execution: {
          status: candidate.sandbox.status,
          runner: candidate.sandbox.runner,
          image: candidate.sandbox.image,
          network: candidate.sandbox.network,
          read_only: candidate.sandbox.read_only,
          limits: candidate.sandbox.limits as unknown as JsonObject,
          checks: candidate.sandbox.checks.map((check) => ({
            name: check.name,
            status: check.status,
            exit_code: check.exit_code,
            evidence: check.evidence as unknown as JsonObject,
          })),
        },
      },
      artifacts,
      context.now(),
      model,
    );
  }
}

interface ParsedPatchProposal {
  readonly patch_files: readonly WorktreePatchFile[];
  readonly risk_declaration: readonly string[];
}

function parsePatchProposal(text: string, plan: ImprovementPlan): ParsedPatchProposal {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new EngineerModelOutputError("Patch proposal must be strict JSON", {
      cause: error instanceof Error ? error : undefined,
    });
  }
  if (!isRecord(value) || !hasOnlyKeys(value, ["patch_files", "risk_declaration"])) {
    throw new EngineerModelOutputError("Patch proposal has an invalid top-level shape");
  }
  if (!Array.isArray(value.patch_files) || value.patch_files.length === 0) {
    throw new EngineerModelOutputError("patch_files must be a non-empty array");
  }
  const allowed = new Set(plan.allowed_paths);
  const seen = new Set<string>();
  const patchFiles = value.patch_files.map((file, index): WorktreePatchFile => {
    if (!isRecord(file) || !hasOnlyKeys(file, ["path", "content"])) {
      throw new EngineerModelOutputError(`patch_files[${index}] has an invalid shape`);
    }
    if (typeof file.path !== "string" || typeof file.content !== "string") {
      throw new EngineerModelOutputError(`patch_files[${index}] path and content must be strings`);
    }
    if (!allowed.has(file.path) || seen.has(file.path)) {
      throw new EngineerModelOutputError(`patch path is not uniquely approved: ${file.path}`);
    }
    seen.add(file.path);
    return { path: file.path, content: file.content };
  });
  if (
    !Array.isArray(value.risk_declaration) ||
    value.risk_declaration.some((risk) => typeof risk !== "string" || risk.trim().length === 0)
  ) {
    throw new EngineerModelOutputError("risk_declaration must be a string array");
  }
  return {
    patch_files: patchFiles,
    risk_declaration: value.risk_declaration as string[],
  };
}

function createPatchProposal(
  task: TaskEnvelope,
  plan: ImprovementPlan,
  parsed: ParsedPatchProposal,
): { readonly summary: PatchProposal; readonly patchFiles: readonly WorktreePatchFile[] } {
  const canonical = [...parsed.patch_files]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => `${file.path}\0${file.content}\0`)
    .join("");
  const proposalDigest = digestText(canonical);
  const artifact: ArtifactRef = {
    artifact_id: `artifact.patch-proposal.${task.correlation_id}`,
    uri: `urn:firefly:patch-proposal:${task.correlation_id}:${proposalDigest.slice(7)}`,
    digest: proposalDigest,
    media_type: "application/vnd.firefly.patch-proposal+json",
    scope: plan.target_artifact.scope,
    owner_id: plan.target_artifact.owner_id,
    lineage_ids: [plan.target_artifact.artifact_id],
  };
  return {
    summary: {
      proposal_id: `patch-proposal.${task.correlation_id}`,
      plan_id: plan.plan_id,
      source_snapshot: plan.target_artifact,
      proposal_artifact: artifact,
      files: parsed.patch_files.map((file) => ({
        path: file.path,
        content_digest: digestText(file.content),
        byte_length: Buffer.byteLength(file.content, "utf8"),
      })),
      risk_declaration: parsed.risk_declaration,
    },
    patchFiles: parsed.patch_files,
  };
}

function validateSourceFiles(files: readonly PluginSourceFile[], plan: ImprovementPlan): void {
  const allowed = new Set(plan.allowed_paths);
  const seen = new Set<string>();
  for (const file of files) {
    if (!allowed.has(file.path) || seen.has(file.path) || typeof file.content !== "string") {
      throw new EngineerModelOutputError("Engineering tool returned source outside the approved scope");
    }
    seen.add(file.path);
  }
}

function modelResult(
  task: TaskEnvelope,
  output: JsonObject,
  artifacts: readonly ArtifactRef[],
  completedAt: Date,
  model: GenerationResult,
): AgentResult {
  return {
    ...completedAgentResult(task, output, completedAt),
    snapshots: {
      input_version: `task-v${task.schema_version}`,
      model: `${model.snapshots.model}|${model.snapshots.routing}`,
      prompt: model.snapshots.prompt,
      tools: `${model.snapshots.tools}|plugin-engineering:isolated-worktree-sandbox.v1`,
      knowledge: model.snapshots.knowledge,
    },
    artifact_refs: artifacts,
    output: {
      ...output,
      model_execution: {
        route_id: model.route_id,
        latency_ms: model.latency_ms,
        usage: model.usage as unknown as JsonObject,
      },
    },
  };
}

function uniqueArtifacts(artifacts: readonly ArtifactRef[]): readonly ArtifactRef[] {
  return [...new Map(artifacts.map((artifact) => [artifact.artifact_id, artifact])).values()];
}

function digestText(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}
