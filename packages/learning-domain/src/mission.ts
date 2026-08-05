import { applyTransition, type TransitionCommand, type TransitionTable, type VersionedState } from "./state-machine.ts";

export type MissionState =
  | "draft"
  | "ready"
  | "active"
  | "assessing"
  | "mastered"
  | "remediation"
  | "waiting_support"
  | "abandoned";

export type MissionEvent =
  | "mark_ready"
  | "activate"
  | "submit_for_assessment"
  | "confirm_mastery"
  | "require_remediation"
  | "request_support"
  | "support_resolved"
  | "retry"
  | "abandon";

export const missionTransitions: TransitionTable<MissionState, MissionEvent> = {
  draft: { mark_ready: "ready", abandon: "abandoned" },
  ready: { activate: "active", abandon: "abandoned" },
  active: {
    submit_for_assessment: "assessing",
    request_support: "waiting_support",
    abandon: "abandoned",
  },
  assessing: {
    confirm_mastery: "mastered",
    require_remediation: "remediation",
    request_support: "waiting_support",
    abandon: "abandoned",
  },
  mastered: {},
  remediation: { retry: "active", request_support: "waiting_support", abandon: "abandoned" },
  waiting_support: { support_resolved: "active", abandon: "abandoned" },
  abandoned: {},
};

export function transitionMission(
  mission: VersionedState<MissionState>,
  command: TransitionCommand<MissionEvent>,
) {
  return applyTransition(missionTransitions, mission, command);
}
