import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type { ArtifactRef, ChangeSet, ImprovementPlan } from "@firefly/contracts";

const executeFile = promisify(execFile);

export interface WorktreePatchFile {
  readonly path: string;
  readonly content: string;
}

export interface BuildPluginChangeInput {
  readonly run_id: string;
  readonly repository_path: string;
  readonly base_ref: string;
  readonly plugin_id: string;
  readonly candidate_version: string;
  readonly plan: ImprovementPlan;
  readonly patch_files: readonly WorktreePatchFile[];
  readonly artifact_paths: readonly string[];
  readonly generated_test_paths: readonly string[];
  readonly owner_id: string;
}

export interface PluginWorktreeBuild {
  readonly worktree_path: string;
  readonly change_set: ChangeSet;
  cleanup(): Promise<void>;
}

export class WorktreePolicyError extends Error {
  constructor(detail: string) {
    super(`Worktree policy rejected the change: ${detail}`);
    this.name = "WorktreePolicyError";
  }
}

export class GitWorktreeBuilder {
  private readonly temporaryRoot: string;

  constructor(temporaryRoot = tmpdir()) {
    this.temporaryRoot = temporaryRoot;
  }

  async build(input: BuildPluginChangeInput): Promise<PluginWorktreeBuild> {
    if (input.plan.status !== "approved" || !input.plan.approved_by || !input.plan.approved_at) {
      throw new WorktreePolicyError("an approved ImprovementPlan is required");
    }
    if (!/^[A-Za-z0-9._/-]+$/.test(input.base_ref) || input.base_ref.startsWith("-")) {
      throw new WorktreePolicyError("base_ref contains unsupported characters");
    }
    const pluginRoot = `plugins/${input.plugin_id}/`;
    const allowed = new Set(input.plan.allowed_paths.map(normalizeRepositoryPath));
    const patchFiles = input.patch_files.map((file) => ({
      path: normalizeRepositoryPath(file.path),
      content: file.content,
    }));
    if (
      patchFiles.length === 0 ||
      new Set(patchFiles.map((file) => file.path)).size !== patchFiles.length ||
      patchFiles.some((file) => !allowed.has(file.path) || !file.path.startsWith(pluginRoot)) ||
      [...input.artifact_paths, ...input.generated_test_paths]
        .map(normalizeRepositoryPath)
        .some((path) => !path.startsWith(pluginRoot))
    ) {
      throw new WorktreePolicyError("every patch path must be explicitly allowed by the plan");
    }

    const sessionRoot = await mkdtemp(join(this.temporaryRoot, "firefly-plugin-"));
    const worktreePath = join(sessionRoot, "worktree");
    let attached = false;
    try {
      await git(input.repository_path, ["worktree", "add", "--detach", worktreePath, input.base_ref]);
      attached = true;
      const baselineDigest = await digestFiles(worktreePath, input.artifact_paths);
      if (baselineDigest !== input.plan.target_artifact.digest) {
        throw new WorktreePolicyError("base_ref content does not match the approved source digest");
      }

      for (const file of patchFiles) {
        const target = resolveInside(worktreePath, file.path);
        await assertNoSymlink(worktreePath, file.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.content, "utf8");
      }
      const changedPaths = await listChangedPaths(worktreePath);
      if (changedPaths.length === 0 || changedPaths.some((path) => !allowed.has(path))) {
        throw new WorktreePolicyError("the resulting Git diff is empty or escapes approved paths");
      }

      await git(worktreePath, ["add", "--", ...changedPaths]);
      await git(worktreePath, [
        "-c",
        "user.name=FireFly Experience Engineer",
        "-c",
        "user.email=experience-engineer@firefly.invalid",
        "commit",
        "-m",
        `plugin(${input.plugin_id}): build ${input.candidate_version}`,
      ]);
      const patchCommit = (await git(worktreePath, ["rev-parse", "HEAD"])).trim();
      const manifest = JSON.parse(
        await readFile(resolveInside(worktreePath, `${pluginRoot}manifest.json`), "utf8"),
      ) as { plugin_id?: unknown; version?: unknown };
      if (manifest.plugin_id !== input.plugin_id || manifest.version !== input.candidate_version) {
        throw new WorktreePolicyError("candidate manifest identity or version does not match the build request");
      }
      const candidateDigest = await digestFiles(worktreePath, input.artifact_paths);
      const pluginArtifact: ArtifactRef = {
        artifact_id: `artifact.plugin.${input.plugin_id}.${input.candidate_version}.${input.run_id}`,
        uri: `urn:firefly:plugin:${input.plugin_id}:${input.candidate_version}:${candidateDigest.slice(7)}`,
        digest: candidateDigest,
        media_type: "application/vnd.firefly.plugin+json",
        scope: "tenant",
        owner_id: input.owner_id,
        lineage_ids: [input.plan.target_artifact.artifact_id],
      };
      const generatedTests = await Promise.all(
        input.generated_test_paths.map(async (path, index): Promise<ArtifactRef> => ({
          artifact_id: `artifact.plugin-test.${input.plugin_id}.${input.run_id}.${index + 1}`,
          uri: `urn:firefly:plugin-test:${input.plugin_id}:${input.run_id}:${index + 1}`,
          digest: await digestFiles(worktreePath, [path]),
          media_type: "text/javascript",
          scope: "tenant",
          owner_id: input.owner_id,
          lineage_ids: [pluginArtifact.artifact_id],
        })),
      );
      const auditRef = `refs/firefly/changes/${createHash("sha256").update(input.run_id).digest("hex").slice(0, 32)}`;
      await git(input.repository_path, ["update-ref", auditRef, patchCommit]);
      const changeSet: ChangeSet = {
        changeset_id: `changeset.${input.run_id}`,
        plan_id: input.plan.plan_id,
        source_snapshot: input.plan.target_artifact,
        patch_commit: patchCommit,
        plugin_artifact: pluginArtifact,
        generated_tests: generatedTests,
        changed_paths: changedPaths,
        risk_declaration: ["isolated-worktree", "requires-independent-gates"],
      };
      return {
        worktree_path: worktreePath,
        change_set: changeSet,
        cleanup: async () => cleanupWorktree(input.repository_path, worktreePath, sessionRoot),
      };
    } catch (error) {
      if (attached) {
        await cleanupWorktree(input.repository_path, worktreePath, sessionRoot);
      } else {
        await rm(sessionRoot, { recursive: true, force: true });
      }
      throw error;
    }
  }
}

export async function digestFiles(
  root: string,
  repositoryPaths: readonly string[],
): Promise<`sha256:${string}`> {
  const hash = createHash("sha256");
  for (const path of [...repositoryPaths].map(normalizeRepositoryPath).sort()) {
    await assertNoSymlink(root, path);
    hash.update(path);
    hash.update("\0");
    const content = await readFile(resolveInside(root, path));
    hash.update(isTextArtifact(path) ? content.toString("utf8").replaceAll("\r\n", "\n") : content);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

async function assertNoSymlink(root: string, repositoryPath: string): Promise<void> {
  const segments = normalizeRepositoryPath(repositoryPath).split("/");
  let current = resolve(root);
  for (const segment of segments) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new WorktreePolicyError(`symbolic links are not allowed in plugin paths: ${repositoryPath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
  }
}

function isTextArtifact(path: string): boolean {
  return /\.(?:json|mjs|cjs|js|ts|tsx|md|txt|ya?ml)$/i.test(path);
}

async function listChangedPaths(worktreePath: string): Promise<string[]> {
  const output = await git(worktreePath, ["status", "--porcelain=v1", "-z"]);
  return output
    .split("\0")
    .filter(Boolean)
    .map((entry) => normalizeRepositoryPath(entry.slice(3)))
    .sort();
}

function normalizeRepositoryPath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    normalized.length === 0 ||
    isAbsolute(path) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new WorktreePolicyError(`unsafe repository path: ${path}`);
  }
  return normalized;
}

function resolveInside(root: string, repositoryPath: string): string {
  const target = resolve(root, repositoryPath);
  const relation = relative(resolve(root), target);
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new WorktreePolicyError(`path escapes worktree: ${repositoryPath}`);
  }
  return target;
}

async function cleanupWorktree(repositoryPath: string, worktreePath: string, sessionRoot: string) {
  try {
    await git(repositoryPath, ["worktree", "remove", "--force", worktreePath]);
  } finally {
    await rm(sessionRoot, { recursive: true, force: true });
  }
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await executeFile("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout;
}
