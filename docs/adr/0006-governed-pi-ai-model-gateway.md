# ADR 0006: Governed pi-ai model gateway and model-assisted Agents

- Status: accepted
- Date: 2026-08-05

## Context

M0 through M3 proved contracts, durable orchestration, loop governance and isolated plugin release with deterministic Agents. M4 introduces model interpretation without allowing provider SDKs or model output to become a second control plane. The system needs provider replacement, fallback and streaming while preserving task budgets, cancellation, immutable execution evidence and deterministic release authority.

The former package `@mariozechner/pi-ai` is deprecated. npm directs consumers to the maintained `@earendil-works/pi-ai` namespace.

## Decision

Create `packages/model-gateway` as a provider-neutral application boundary. It owns generate and stream routing, retry, fallback, timeout, cancellation, preflight and postflight token/cost checks, and immutable model/routing/prompt/tool/knowledge snapshots. Embed and rerank remain explicit ports backed by separate providers because pi-ai does not expose those capabilities.

Pin `@earendil-works/pi-ai` to `0.83.0`. Its adapter resolves models from pi-ai's provider catalog and auth layer, but never stores credentials in route or execution snapshots. Provider-side retries are disabled because the Gateway owns the visible retry budget.

Do not pass tools to pi-ai. Reject any model-initiated tool call. A stream may fall back only before emitting text; a failure after partial output is terminal to prevent concatenating results from different models.

Model-enable Agents incrementally:

- Learning Scientist uses the model only to interpret authorized evidence. Trusted code binds finding identity, scope, evidence references and no-harm constraints, then validates the `LearningFinding` contract.
- Learning Director uses the model only for guidance within five trusted mission stages. Trusted code binds mission identity, plugin exposure and stage order. Canary assignment remains deterministic.
- Experience Engineer remained deterministic in M4.1. ADR 0007 completes its authorized source, model proposal, Git worktree and Sandbox lifecycle without accepting model-generated commits.

The default workflow remains zero-budget deterministic mode. Real calls require explicit model Workers, non-zero task budgets and a `FIREFLY_MODEL_ROUTES` configuration. Model usage, route and latency are persisted inside the versioned Agent result.

## Consequences

- Provider and model selection are configuration, not Agent code.
- Missing routes, zero budgets and unsupported capabilities fail closed before network calls.
- API keys stay in provider-supported environment or credential stores; they never enter Task payloads, snapshots, logs or the repository.
- Model output cannot activate a release, approve a plan, execute a tool or alter evidence identity.
- ADR 0007 fulfills the remaining Engineer consequence and completes the three-Agent model milestone.
