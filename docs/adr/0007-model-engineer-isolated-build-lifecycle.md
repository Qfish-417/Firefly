# ADR 0007: Model Engineer uses an isolated build-and-verify lifecycle

- Status: accepted
- Date: 2026-08-06

## Context

ADR 0006 introduced model-assisted Director and Scientist but deliberately kept Experience Engineer deterministic. A model cannot truthfully produce a `ChangeSet` because Git commit identity, plugin digest and independent verification exist only after platform-controlled side effects. Splitting model patch generation, worktree lifetime and Sandbox execution across unrelated processes would also make cleanup, cancellation and evidence binding unreliable.

## Decision

Introduce a versioned `PatchProposal` contract containing only approved paths, content digests, byte lengths, risk declarations and an immutable ArtifactRef. Complete source text remains transient inside the governed engineering call and is not embedded into Task or Event messages.

Implement `IsolatedPluginEngineeringTool` as the Experience Engineer's only mutation capability. Before model invocation it reads only ImprovementPlan-approved paths from the configured Git `base_ref`, rejects symbolic links and path escapes, limits source size and verifies that the full configured baseline digest equals the approved source snapshot.

The model receives the approved plan and source files and returns strict JSON containing full replacement content. Trusted code rejects extra fields, duplicate or unapproved paths, truncation and oversized proposals. The model cannot supply commits, digests, commands, gate results, approvals or release decisions.

After validation, the engineering tool creates a detached worktree, writes only approved files, creates a real Git commit and audit ref, runs the exact approved verification contract in the digest-pinned no-network Docker Sandbox, constructs `ChangeSet` and `VerificationReport`, and cleans the worktree in a `finally` block. Cancellation is propagated to Git and Docker child processes.

The Control Plane persists the real report. Failed gates transition EvolutionRun through `verification_failed`; only passed reports with evidence may enter Canary. `PluginReleaseWorkflow.prepareVerified` consumes the completed governed Engineer task and its existing candidate evidence without rebuilding, then requests a separate release approval.

Keep all deterministic Stub Agents. The default workflow remains Stub mode with zero model budget; all three model Workers require explicit composition through `createModelBackedWorkers`.

## Consequences

- Experience Engineer is now model-backed without giving the model direct filesystem, Git, Docker or release authority.
- Candidate code still executes outside Agent processes and cannot edit its own gates or policy.
- A source snapshot mismatch fails before model cost is incurred.
- A passed model self-review has no authority; only the configured independent Sandbox checks count.
- Plugin release and rollback remain available after Experience Engineer stops because all required commit, digest and verification evidence is persisted.
- Production still needs opt-in live-provider tests and an external Artifact blob store for retaining encrypted PatchProposal bodies; the current database retains immutable metadata and lineage.
