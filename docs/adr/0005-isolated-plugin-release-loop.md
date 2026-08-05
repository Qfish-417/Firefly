# ADR 0005: Isolated plugin release loop with digest rollback

- Status: accepted
- Date: 2026-08-05

## Context

M2 proved the three-Agent causal chain with deterministic fixtures, but its ChangeSet, verification and canary outcome did not mutate or execute real plugin source. M3 must prove that an approved improvement can become a traceable Git commit, run outside the Agent process, reach only authorized canary subjects and recover the exact baseline artifact after degradation.

## Decision

Implement the solar-energy plugin as the first executable release slice. Version 1.2.0 deliberately models constant output at night. The 1.3.0 candidate introduces a diurnal output model while preserving the assessment contract and accessibility metadata.

Use `GitWorktreeBuilder` as the only mutation adapter. It requires an approved ImprovementPlan, verifies the baseline content digest, permits only exact paths under the target plugin root, rejects path traversal and symbolic links, commits with a platform identity and stores the commit under a dedicated `refs/firefly/changes/*` audit ref. Artifact digests normalize line endings for supported text formats so they are stable across operating systems.

Run independent gates in a digest-pinned Docker image with no network, a read-only root filesystem and worktree, all Linux capabilities dropped, `no-new-privileges` and explicit CPU, memory, PID and timeout limits. The candidate must pass physics invariants, assessment-contract invariance, accessibility and historical replay. Candidate code never enters an Agent process.

Persist Plugin, PluginVersion, PluginRelease, PluginReleaseTransition, SandboxRun and CanaryEvaluation records in PostgreSQL. A release proposal must reference a persisted ChangeSet and a completed governed Experience Engineer Task. Verification and release approval are independent evidence requirements. Canary routing uses deterministic buckets but first requires an explicit subject allowlist or prefix. Candidate activation and digest rollback update the active version pointer in the release transition transaction and emit an Outbox event.

Expose the sequence through the Control Plane `PluginReleaseWorkflow`. It owns build-and-verify preparation, the release approval boundary, canary resolution and evaluation completion. Tests and callers do not advance release states directly.

## Consequences

- M3 tests require PostgreSQL, Docker and a pinned sandbox image.
- A mutable image tag is rejected even in development.
- The release authority approves after independent gates; ImprovementPlan approval alone cannot publish code.
- Unauthorized learners always receive the active baseline during canary, regardless of percentage.
- Production deployment may replace the local Git repository and Docker runner with remote providers, but must preserve the same digest, evidence and state-transition contracts.
