import { applyTransition, type TransitionCommand, type TransitionTable, type VersionedState } from "./state-machine.ts";

export type EvolutionRunState =
  | "observed"
  | "diagnosed"
  | "planned"
  | "awaiting_approval"
  | "executing"
  | "verifying"
  | "canary"
  | "released"
  | "learned"
  | "rejected"
  | "failed"
  | "rolled_back"
  | "canceled"
  | "needs_human";

export type EvolutionRunEvent =
  | "finding_created"
  | "plan_created"
  | "approval_requested"
  | "plan_approved"
  | "plan_rejected"
  | "change_built"
  | "execution_failed"
  | "verification_passed"
  | "verification_failed"
  | "canary_started"
  | "canary_succeeded"
  | "canary_degraded"
  | "outcome_recorded"
  | "cancel"
  | "request_human";

export const evolutionRunTransitions: TransitionTable<EvolutionRunState, EvolutionRunEvent> = {
  observed: { finding_created: "diagnosed", cancel: "canceled", request_human: "needs_human" },
  diagnosed: { plan_created: "planned", cancel: "canceled", request_human: "needs_human" },
  planned: { approval_requested: "awaiting_approval", cancel: "canceled", request_human: "needs_human" },
  awaiting_approval: {
    plan_approved: "executing",
    plan_rejected: "rejected",
    cancel: "canceled",
    request_human: "needs_human",
  },
  executing: {
    change_built: "verifying",
    execution_failed: "failed",
    cancel: "canceled",
    request_human: "needs_human",
  },
  verifying: {
    verification_passed: "canary",
    verification_failed: "failed",
    cancel: "canceled",
    request_human: "needs_human",
  },
  canary: {
    canary_started: "canary",
    canary_succeeded: "released",
    canary_degraded: "rolled_back",
    cancel: "canceled",
    request_human: "needs_human",
  },
  released: { outcome_recorded: "learned", canary_degraded: "rolled_back", request_human: "needs_human" },
  learned: {},
  rejected: {},
  failed: {},
  rolled_back: { outcome_recorded: "learned" },
  canceled: {},
  needs_human: { plan_approved: "executing", plan_rejected: "rejected", cancel: "canceled" },
};

export function transitionEvolutionRun(
  run: VersionedState<EvolutionRunState>,
  command: TransitionCommand<EvolutionRunEvent>,
) {
  return applyTransition(evolutionRunTransitions, run, command);
}
