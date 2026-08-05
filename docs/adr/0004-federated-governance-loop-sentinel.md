# ADR 0004: Federated execution with centralized loop governance

- Status: accepted
- Date: 2026-08-05

## Context

The three FireFly Agents must remain independently deployable and capable of delegating work through stable contracts. Fully decentralized delegation would also allow accidental self-sustaining task chains, repeated events, budget exhaustion and circular causality. Human review alone is too late and cannot be the only runtime safety mechanism.

## Decision

Use a federated architecture: Agent execution may be distributed, while workflow facts, policy snapshots, budgets, approvals and quarantine decisions remain centrally governed. PostgreSQL is the only workflow fact source. Loop Sentinel is a deterministic platform capability and is not a fourth Agent.

Every governed Task carries a root Run, parent Task, hop count, maximum hops, canonical task fingerprint, policy snapshot, epoch and optional cooldown key. The platform enforces three layers:

- contract rules prevent self-delegation and invalid parent/depth relationships;
- Loop Sentinel enforces task, transition and retry budgets, hop bounds, fingerprint repetition and event-window thresholds;
- an immutable causal graph, budget ledger, incident log and quarantine records preserve the evidence needed for audit and recovery.

Task insertion, causal-edge creation and task-budget consumption commit in one transaction. EvolutionRun transitions consume their budget in the transition transaction. A repeated fingerprint is rejected, self-delegation quarantines the Agent, and causal cycles, event storms or exhausted Run bounds quarantine the Run for explicit governance handling.

## Consequences

- Agent bundles can move to separate processes or services without taking policy ownership with them.
- A message broker remains a delivery mechanism and cannot become the workflow fact source.
- Quarantine release must be an explicit administrative capability added with authorization and audit; the offending Agent cannot release itself.
- Default limits are conservative development values and must evolve as versioned policy snapshots, not mutable hidden configuration.
- M3 plugin execution must enter through the same governed Task path before any source or release mutation occurs.
