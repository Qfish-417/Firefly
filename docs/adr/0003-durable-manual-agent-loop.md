# ADR 0003: Durable manual three-Agent loop

- Status: accepted
- Date: 2026-08-05

## Context

The first executable vertical slice must prove Agent boundaries, human approval and causal traceability before model variability or real plugin mutation is introduced. A successful in-memory demo would not prove restart safety, idempotent task handling or administrative auditability.

## Decision

Implement exactly three replaceable `AgentWorker` bundles:

- Learning Director creates deterministic mission and canary assignments;
- Learning Scientist creates the `LearningFinding` and evaluates the synthetic outcome;
- Experience Engineer consumes only an approved `ImprovementPlan` and creates a `ChangeSet` within declared paths.

The Control Plane is a deterministic platform capability, not a fourth Agent. It persists every task before execution, leases it to a worker, validates every result against v1 contracts and advances the `EvolutionRun` state machine. Approval and plan-state changes commit in one PostgreSQL transaction.

Persist LearningEvent, AgentResult, LearningFinding, ImprovementPlan, ChangeSet, VerificationReport and LearningOutcome records with run and causation identifiers. Expose the resulting trace through a read-only internal Admin API.

M2 uses fixed verification and synthetic outcome fixtures. It does not claim that plugin sandboxing, canary statistics or release rollback are implemented; those remain M3 work.

## Consequences

- Agent packages can move behind transport adapters without changing their task/result contract.
- A run stops in `awaiting_approval`; Experience Engineer cannot execute a proposed plan.
- Task leases, cancellation flags and persisted results survive worker process loss.
- The Admin API is bound to loopback and has no external authentication in M2. It must not be exposed outside a trusted development environment.
