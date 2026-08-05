import { applyTransition, type TransitionCommand, type TransitionTable, type VersionedState } from "./state-machine.ts";

export type PluginReleaseState =
  | "proposed"
  | "sandboxed"
  | "verified"
  | "awaiting_approval"
  | "canary"
  | "active"
  | "rejected"
  | "failed"
  | "rolled_back"
  | "retired";

export type PluginReleaseEvent =
  | "sandbox_passed"
  | "sandbox_failed"
  | "verification_passed"
  | "verification_failed"
  | "request_approval"
  | "approve"
  | "reject"
  | "canary_succeeded"
  | "canary_degraded"
  | "rollback"
  | "retire";

export const pluginReleaseTransitions: TransitionTable<PluginReleaseState, PluginReleaseEvent> = {
  proposed: { sandbox_passed: "sandboxed", sandbox_failed: "failed", reject: "rejected" },
  sandboxed: { verification_passed: "verified", verification_failed: "failed" },
  verified: { request_approval: "awaiting_approval" },
  awaiting_approval: { approve: "canary", reject: "rejected" },
  canary: { canary_succeeded: "active", canary_degraded: "rolled_back", rollback: "rolled_back" },
  active: { rollback: "rolled_back", retire: "retired" },
  rejected: {},
  failed: {},
  rolled_back: { retire: "retired" },
  retired: {},
};

export function transitionPluginRelease(
  release: VersionedState<PluginReleaseState>,
  command: TransitionCommand<PluginReleaseEvent>,
) {
  return applyTransition(pluginReleaseTransitions, release, command);
}
