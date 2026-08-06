import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type { ArtifactRef, ChangeSet, ImprovementPlan } from "@firefly/contracts";

import {
  IsolatedPluginEngineeringTool,
  GitWorktreeBuilder,
  WorktreePolicyError,
  digestFiles,
  type BuildPluginChangeInput,
  type PluginEngineeringProfile,
  type PluginSandboxRunnerPort,
  type PluginWorktreeBuild,
  type PluginWorktreeBuilderPort,
  type SandboxExecutionResult,
} from "../src/index.ts";

const executeFile = promisify(execFile);

test("engineering tool loads only approved source from the digest-matched Git snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "firefly-engineering-source-"));
  try {
    await writeRepository(root);
    const artifactPaths = [
      "plugins/solar-energy/manifest.json",
      "plugins/solar-energy/src/daylight.mjs",
    ];
    const source = sourceArtifact(await digestFiles(root, artifactPaths));
    const tool = new IsolatedPluginEngineeringTool(
      new FakeBuilder(source),
      new FakeSandbox(),
      profile(root, artifactPaths),
    );

    const files = await tool.loadApprovedSource(approvedPlan(source));

    assert.deepEqual(files.map((file) => file.path), artifactPaths);
    assert.match(files[1]?.content ?? "", /solarOutputKw/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("engineering tool runs worktree and Sandbox in one lifecycle and always cleans up", async () => {
  const source = sourceArtifact(`sha256:${"a".repeat(64)}`);
  const builder = new FakeBuilder(source);
  const tool = new IsolatedPluginEngineeringTool(
    builder,
    new FakeSandbox(),
    profile("D:/fixture", ["plugins/solar-energy/manifest.json"]),
  );

  const result = await tool.buildAndVerify({
    run_id: "run.engineering-tool-unit",
    plan: approvedPlan(source),
    patch_files: [
      { path: "plugins/solar-energy/manifest.json", content: "{\"version\":\"1.3.0\"}\n" },
    ],
  });

  assert.equal(result.verification.status, "passed");
  assert.equal(builder.cleaned, true);
  assert.equal(builder.calls, 1);
});

test("engineering tool creates a real audited Git commit before cleaning the worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "firefly-engineering-git-"));
  const repository = join(root, "repository");
  try {
    await mkdir(repository, { recursive: true });
    await writeRepository(repository);
    const artifactPaths = [
      "plugins/solar-energy/manifest.json",
      "plugins/solar-energy/src/daylight.mjs",
    ];
    const source = sourceArtifact(await digestFiles(repository, artifactPaths));
    const sandbox = new FakeSandbox();
    const tool = new IsolatedPluginEngineeringTool(
      new GitWorktreeBuilder(root),
      sandbox,
      profile(repository, artifactPaths),
    );

    const result = await tool.buildAndVerify({
      run_id: "run.engineering-real-git",
      plan: approvedPlan(source),
      patch_files: [
        {
          path: "plugins/solar-energy/manifest.json",
          content: "{\"plugin_id\":\"solar-energy\",\"version\":\"1.3.0\"}\n",
        },
        {
          path: "plugins/solar-energy/src/daylight.mjs",
          content: "export function solarOutputKw() { return 0; }\n",
        },
      ],
    });

    assert.match(result.change_set.patch_commit, /^[a-f0-9]{40}$/);
    assert.notEqual(result.change_set.plugin_artifact.digest, source.digest);
    assert.ok(sandbox.lastWorktreePath);
    await assert.rejects(access(sandbox.lastWorktreePath));
    const auditCommits = await gitOutput(repository, [
      "for-each-ref",
      "refs/firefly/changes",
      "--format=%(objectname)",
    ]);
    assert.match(auditCommits, new RegExp(result.change_set.patch_commit));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("engineering tool rejects Sandbox gates that differ from the approved contract", async () => {
  const source = sourceArtifact(`sha256:${"a".repeat(64)}`);
  const builder = new FakeBuilder(source);
  const tool = new IsolatedPluginEngineeringTool(
    builder,
    new FakeSandbox(),
    profile("D:/fixture", ["plugins/solar-energy/manifest.json"]),
  );
  const invalidPlan = {
    ...approvedPlan(source),
    verification_contract: ["physics_invariants", "model_self_review"],
  };

  await assert.rejects(
    tool.buildAndVerify({
      run_id: "run.engineering-tool-invalid-gates",
      plan: invalidPlan,
      patch_files: [
        { path: "plugins/solar-energy/manifest.json", content: "{\"version\":\"1.3.0\"}\n" },
      ],
    }),
    WorktreePolicyError,
  );
  assert.equal(builder.calls, 0);
});

class FakeBuilder implements PluginWorktreeBuilderPort {
  calls = 0;
  cleaned = false;
  private readonly source: ArtifactRef;

  constructor(source: ArtifactRef) {
    this.source = source;
  }

  async build(input: BuildPluginChangeInput): Promise<PluginWorktreeBuild> {
    this.calls += 1;
    const candidate: ArtifactRef = {
      artifact_id: `artifact.plugin.candidate.${input.run_id}`,
      uri: `urn:firefly:plugin:solar-energy:1.3.0:${input.run_id}`,
      digest: `sha256:${"b".repeat(64)}`,
      media_type: "application/vnd.firefly.plugin+json",
      scope: "tenant",
      owner_id: input.owner_id,
      lineage_ids: [this.source.artifact_id],
    };
    const changeSet: ChangeSet = {
      changeset_id: `changeset.${input.run_id}`,
      plan_id: input.plan.plan_id,
      source_snapshot: this.source,
      patch_commit: "c".repeat(40),
      plugin_artifact: candidate,
      generated_tests: [],
      changed_paths: input.patch_files.map((file) => file.path),
      risk_declaration: ["isolated-worktree"],
    };
    return {
      worktree_path: "D:/fixture/worktree",
      change_set: changeSet,
      cleanup: async () => {
        this.cleaned = true;
      },
    };
  }
}

class FakeSandbox implements PluginSandboxRunnerPort {
  lastWorktreePath: string | undefined;

  async run(input: {
    readonly run_id: string;
    readonly worktree_path: string;
    readonly owner_id: string;
    readonly checks: PluginEngineeringProfile["checks"];
    readonly signal?: AbortSignal;
  }): Promise<SandboxExecutionResult> {
    this.lastWorktreePath = input.worktree_path;
    return {
      status: "passed",
      runner: "docker",
      image: `node@sha256:${"d".repeat(64)}`,
      network: "none",
      read_only: true,
      limits: { timeout_ms: 30_000, memory_mb: 128, cpus: 1, pids: 64 },
      checks: input.checks.map((check) => ({
        name: check.name,
        status: "passed",
        exit_code: 0,
        stdout: "",
        stderr: "",
        evidence: {
          artifact_id: `artifact.sandbox.${input.run_id}.${check.name}`,
          uri: `urn:firefly:sandbox:${input.run_id}:${check.name}`,
          digest: `sha256:${"e".repeat(64)}`,
          media_type: "application/json",
          scope: "tenant",
          owner_id: input.owner_id,
          lineage_ids: [],
        },
      })),
    };
  }
}

function profile(repositoryPath: string, artifactPaths: readonly string[]): PluginEngineeringProfile {
  return {
    repository_path: repositoryPath,
    base_ref: "HEAD",
    plugin_id: "solar-energy",
    candidate_version: "1.3.0",
    artifact_paths: artifactPaths,
    generated_test_paths: [],
    owner_id: "tenant.questlab",
    checks: [
      { name: "physics_invariants", command: ["node", "gate.mjs", "physics_invariants"] },
      { name: "assessment_invariance", command: ["node", "gate.mjs", "assessment_invariance"] },
    ],
  };
}

function approvedPlan(source: ArtifactRef): ImprovementPlan {
  return {
    plan_id: "plan.engineering-tool-unit",
    finding_id: "finding.engineering-tool-unit",
    status: "approved",
    change_class: "A3",
    target_artifact: source,
    allowed_paths: [
      "plugins/solar-energy/manifest.json",
      "plugins/solar-energy/src/daylight.mjs",
    ],
    risk_level: "high",
    verification_contract: ["physics_invariants", "assessment_invariance"],
    rollback_target: source,
    approved_by: "teacher.unit",
    approved_at: "2026-08-06T09:00:00.000Z",
  };
}

function sourceArtifact(digest: `sha256:${string}`): ArtifactRef {
  return {
    artifact_id: "artifact.plugin.source.engineering-tool-unit",
    uri: "urn:firefly:plugin:solar-energy:1.2.0",
    digest,
    media_type: "application/vnd.firefly.plugin+json",
    scope: "tenant",
    owner_id: "tenant.questlab",
    lineage_ids: [],
  };
}

async function writeRepository(root: string): Promise<void> {
  const pluginRoot = join(root, "plugins/solar-energy");
  await mkdir(join(pluginRoot, "src"), { recursive: true });
  await writeFile(
    join(pluginRoot, "manifest.json"),
    "{\"plugin_id\":\"solar-energy\",\"version\":\"1.2.0\"}\n",
    "utf8",
  );
  await writeFile(
    join(pluginRoot, "src/daylight.mjs"),
    "export function solarOutputKw() { return 1; }\n",
    "utf8",
  );
  await git(root, ["init"]);
  await git(root, ["add", "."]);
  await git(root, [
    "-c",
    "user.name=FireFly Test",
    "-c",
    "user.email=test@firefly.invalid",
    "commit",
    "-m",
    "baseline",
  ]);
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await executeFile("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
  const result = await executeFile("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return result.stdout;
}
