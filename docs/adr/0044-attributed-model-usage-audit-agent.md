# ADR 0044: Attribute model usage to a read-only Audit Agent ledger

## Context

The three business Agents can call text models through the pi-ai gateway, but the existing model invocation projection cannot answer which run, task, Agent, tenant or user caused a charge. Provider logs alone are not a sufficient fact source: retries span routes, provider retention varies, and workflow operators need one causal view of what an Agent did and what it cost.

An LLM-based supervisor would introduce another paid and fallible call into the control path. It could also become a fourth participant in the delegation graph, creating new loop and authority risks. Raw prompts and responses are too sensitive for a general operational endpoint.

## Decision

Use two layers:

1. Trusted application code emits one `ModelInvocationRecord` per provider attempt. It carries capability, immutable execution snapshots, usage and explicit run/task/Agent attribution. It never carries raw prompts, responses, credentials or hidden reasoning.
2. A deterministic `AuditAgent` reads the workflow and model ledgers. It calculates Agent totals, a redacted activity timeline and alerts for failed calls, retries, telemetry gaps and 70/90 percent cost thresholds.

The Audit Agent is not an `AgentWorker`, cannot receive business tasks, does not call a model, and cannot transition workflow state. It is a read-only projection exposed through localhost Admin API routes.

`ModelInvocationRepository.record()` inserts the invocation and increments `run_budget_usage` in one transaction. Replaying an identical invocation is free and idempotent. Reusing an invocation ID with different accounting fields is an identity conflict. Cost is persisted as integer micro-USD; the provider-reported token and cost values are authoritative when present.

## Consequences

- Operators can compare calls, failed attempts, retries, tokens, cost and latency for the Director, Scientist and Engineer.
- A run report connects tasks, state transitions, model attempts and Sandbox execution without exposing prompt or response content.
- A dropped observer write does not change model-provider semantics; the report detects a telemetry gap when a model-backed Agent result has no durable invocation.
- The current API is an operator interface bound to localhost. Any remote deployment must add authentication, tenant authorization, retention and rate limiting before exposure.
- Failed provider attempts without reported usage remain unknown rather than estimated. An estimated billing adapter may be added later, but must set `billing_source=estimated` and remain distinguishable from provider facts.
