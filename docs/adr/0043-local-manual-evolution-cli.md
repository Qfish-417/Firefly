# ADR 0043: Expose the governed three-Agent loop through a local CLI

## Context

The manual evolution workflow was exercised by PostgreSQL integration tests but had no operator-facing mutation entry point. The read-only Admin API could inspect a run only after another caller had created it. A local-first project is not usable if its central three-Agent workflow exists solely as a test fixture, but adding an unauthenticated mutation HTTP API would unnecessarily broaden the trust boundary.

## Decision

Add a database-local CLI with separate `start` and `approve` commands. `demo:start` migrates the configured PostgreSQL database, creates deterministic synthetic learning evidence and executes the Director and Scientist stages. It always stops in `awaiting_approval` and returns the persisted approval and plan identities.

`demo:approve` requires the existing run ID, a non-empty approver identity and a non-empty reason. It records the approval and resumes the Engineer, Director canary and Scientist outcome stages through `ManualEvolutionWorkflow`. Successful completion returns a compact summary derived from the persisted trace. The full trace remains available through the read-only Admin API.

The input factory is shared with the existing integration test so the demo and tested workflow cannot silently diverge. Run IDs use a bounded allowlist. The local CLI defaults to the lite PostgreSQL port but accepts `DATABASE_URL`. It uses deterministic Stub Agents and zero model budget; it does not claim real model, Git worktree, Sandbox or external-provider execution.

## Consequences

- A user can operate the core three-Agent lifecycle without writing code or enabling heavy services.
- Human approval remains a durable two-command boundary rather than an automatic demo shortcut.
- Reusing a run ID is rejected by persistence invariants instead of overwriting history.
- Model-assisted and production mutation APIs remain separate, explicitly authenticated deployment concerns.
