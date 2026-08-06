# ADR 0008: Persist model invocation attempts as an operational projection

- Status: accepted
- Date: 2026-08-06

## Context

The Model Gateway enforces routing, retry, timeout and token/cost budgets, but those decisions were previously only present in process memory. Without a durable projection, operators cannot distinguish provider failure from successful fallback, aggregate spend by workload, or audit which immutable model and routing snapshots produced an Agent result.

## Decision

Add an optional `ModelInvocationObserver` to the gateway. The gateway emits one privacy-preserving `ModelInvocationRecord` for every provider attempt, including retry attempts and terminal failures. Records contain route identity, usage, latency, error classification and prompt/tool/knowledge snapshot IDs, never raw prompts, credentials or generated text.

Persist records in `questlab.model_invocation` through `ModelInvocationRepository`. The table is append-oriented, keyed by a deterministic request/attempt ID, and indexed for workload time series and provider health queries. Replays are idempotent. Aggregates are projections only; workflow state, Agent results and release decisions remain in their existing fact tables.

Observer failures are swallowed by the gateway so telemetry outages cannot change model or workflow semantics. Deployments that require stronger accounting can provide a durable observer and monitor its delivery lag separately.

## Consequences

- Retry cost and provider failure rates become queryable without storing sensitive prompt data.
- Model Gateway remains independent of PostgreSQL and can be used with another observer in tests or a future event stream.
- The projection is not a source of truth and must not be used to reconstruct workflow state.
