import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ChangeSet, ImprovementPlan, VerificationReport } from "@firefly/contracts";
import { assertContract } from "@firefly/contracts";

import {
  createVerificationReport,
  type SandboxCheck,
  type SandboxExecutionResult,
} from "./docker-sandbox-runner.ts";
import {
  WorktreePolicyError,
  digestFileContents,
  normalizeRepositoryPath,
  type BuildPluginChangeInput,
  type PluginWorktreeBuild,
  type WorktreePatchFile,
} from "./git-worktree-builder.ts";

const executeFile = promisify(execFile);

export interface PluginSourceFile {
  readonly path: string;
  readonly content: string;
}

export interface PluginEngineeringProfile {
  readonly repository_path: string;
  readonly base_ref: string;
  readonly plugin_id: string;
  readonly candidate_version: string;
  readonly artifact_paths: readonly string[];
  readonly generated_test_paths: readonly string[];
  readonly owner_id: string;
  readonly checks: readonly SandboxCheck[];
  readonly max_source_bytes?: number;
  readonly max_patch_bytes?: number;
}

export interface VerifiedPluginCandidate {
  readonly change_set: ChangeSet;
  readonly verification: VerificationReport;
  readonly sandbox: SandboxExecutionResult;
}

export interface PluginEngineeringTool {
  loadApprovedSource(
    plan: ImprovementPlan,
    signal?: AbortSignal,
  ): Promise<readonly PluginSourceFile[]>;
  buildAndVerify(input: {
    readonly run_id: string;
    readonly plan: ImprovementPlan;
    readonly patch_files: readonly WorktreePatchFile[];
    readonly signal?: AbortSignal;
  }): Promise<VerifiedPluginCandidate>;
}

export interface PluginWorktreeBuilderPort {
  build(input: BuildPluginChangeInput): Promise<PluginWorktreeBuild>;
}

export interface PluginSandboxRunnerPort {
  run(input: {
    readonly run_id: string;
    readonly worktree_path: string;
    readonly owner_id: string;
    readonly checks: readonly SandboxCheck[];
    readonly signal?: AbortSignal;
  }): Promise<SandboxExecutionResult>;
}

export class IsolatedPluginEngineeringTool implements PluginEngineeringTool {
  private readonly builder: PluginWorktreeBuilderPort;
  private readonly sandbox: PluginSandboxRunnerPort;
  private readonly profile: PluginEngineeringProfile;

  constructor(
    builder: PluginWorktreeBuilderPort,
    sandbox: PluginSandboxRunnerPort,
    profile: PluginEngineeringProfile,
  ) {
    this.builder = builder;
    this.sandbox = sandbox;
    this.profile = profile;
    validateProfile(profile);
  }

  async loadApprovedSource(
    plan: ImprovementPlan,
    signal?: AbortSignal,
  ): Promise<readonly PluginSourceFile[]> {
    assertApprovedPlan(plan);
    const pluginRoot = `plugins/${this.profile.plugin_id}/`;
    const approvedPaths = plan.allowed_paths.map(normalizeRepositoryPath);
    if (approvedPaths.some((path) => !path.startsWith(pluginRoot))) {
      throw new WorktreePolicyError("approved source path escapes the configured plugin root");
    }

    const baselineEntries = await Promise.all(
      this.profile.artifact_paths.map(async (path) => ({
        path,
        content: await this.readRequiredTextFile(path, signal),
      })),
    );
    if (digestFileContents(baselineEntries) !== plan.target_artifact.digest) {
      throw new WorktreePolicyError("configured base_ref does not match the approved source digest");
    }

    const sourceFiles: PluginSourceFile[] = [];
    for (const path of approvedPaths) {
      const content = await this.readOptionalTextFile(path, signal);
      if (content !== undefined) {
        sourceFiles.push({ path, content });
      }
    }
    const totalBytes = sourceFiles.reduce(
      (total, file) => total + Buffer.byteLength(file.content, "utf8"),
      0,
    );
    if (totalBytes > (this.profile.max_source_bytes ?? 256 * 1024)) {
      throw new WorktreePolicyError("approved source exceeds the model context source limit");
    }
    return sourceFiles;
  }

  async buildAndVerify(input: {
    readonly run_id: string;
    readonly plan: ImprovementPlan;
    readonly patch_files: readonly WorktreePatchFile[];
    readonly signal?: AbortSignal;
  }): Promise<VerifiedPluginCandidate> {
    assertApprovedPlan(input.plan);
    assertVerificationContract(input.plan, this.profile.checks);
    const patchBytes = input.patch_files.reduce(
      (total, file) => total + Buffer.byteLength(file.content, "utf8"),
      0,
    );
    if (patchBytes > (this.profile.max_patch_bytes ?? 256 * 1024)) {
      throw new WorktreePolicyError("patch proposal exceeds the configured size limit");
    }

    const build = await this.builder.build({
      run_id: input.run_id,
      repository_path: this.profile.repository_path,
      base_ref: this.profile.base_ref,
      plugin_id: this.profile.plugin_id,
      candidate_version: this.profile.candidate_version,
      plan: input.plan,
      patch_files: input.patch_files,
      artifact_paths: this.profile.artifact_paths,
      generated_test_paths: this.profile.generated_test_paths,
      owner_id: this.profile.owner_id,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    try {
      const sandbox = await this.sandbox.run({
        run_id: input.run_id,
        worktree_path: build.worktree_path,
        owner_id: this.profile.owner_id,
        checks: this.profile.checks,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const verification = createVerificationReport({
        run_id: input.run_id,
        change_set: build.change_set,
        sandbox,
      });
      assertContract("ChangeSet", build.change_set);
      assertContract("VerificationReport", verification);
      return { change_set: build.change_set, verification, sandbox };
    } finally {
      await build.cleanup();
    }
  }

  private async readRequiredTextFile(path: string, signal?: AbortSignal): Promise<string> {
    const content = await this.readOptionalTextFile(path, signal);
    if (content === undefined) {
      throw new WorktreePolicyError(`baseline artifact path does not exist: ${path}`);
    }
    return content;
  }

  private async readOptionalTextFile(
    repositoryPath: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const path = normalizeRepositoryPath(repositoryPath);
    const tree = await git(
      this.profile.repository_path,
      ["ls-tree", this.profile.base_ref, "--", path],
      signal,
    );
    if (!tree.trim()) {
      return undefined;
    }
    if (tree.startsWith("120000 ")) {
      throw new WorktreePolicyError(`symbolic links are not allowed in plugin source: ${path}`);
    }
    return git(
      this.profile.repository_path,
      ["show", `${this.profile.base_ref}:${path}`],
      signal,
    );
  }
}

function validateProfile(profile: PluginEngineeringProfile): void {
  if (!/^[A-Za-z0-9._/-]+$/.test(profile.base_ref) || profile.base_ref.startsWith("-")) {
    throw new WorktreePolicyError("base_ref contains unsupported characters");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(profile.plugin_id) || !profile.candidate_version) {
    throw new WorktreePolicyError("plugin identity is invalid");
  }
  if (profile.artifact_paths.length === 0 || profile.checks.length === 0) {
    throw new WorktreePolicyError("artifact paths and independent checks are required");
  }
}

function assertApprovedPlan(plan: ImprovementPlan): void {
  assertContract("ImprovementPlan", plan);
  if (plan.status !== "approved" || !plan.approved_by || !plan.approved_at) {
    throw new WorktreePolicyError("an approved ImprovementPlan is required");
  }
}

function assertVerificationContract(plan: ImprovementPlan, checks: readonly SandboxCheck[]): void {
  const expected = [...plan.verification_contract].sort();
  const actual = checks.map((check) => check.name).sort();
  if (expected.length !== actual.length || expected.some((name, index) => name !== actual[index])) {
    throw new WorktreePolicyError("Sandbox checks do not match the approved verification contract");
  }
}

async function git(
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  const result = await executeFile("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    ...(signal ? { signal } : {}),
  });
  return result.stdout;
}
