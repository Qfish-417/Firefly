import { applyTransition, type TransitionCommand, type TransitionTable, type VersionedState } from "./state-machine.ts";

export type JourneyState =
  | "onboarding"
  | "diagnosing"
  | "planning"
  | "active"
  | "reflecting"
  | "delayed_review"
  | "transferring"
  | "completed"
  | "paused"
  | "waiting_teacher"
  | "waiting_consent"
  | "withdrawn";

export type JourneyEvent =
  | "start_diagnosis"
  | "complete_diagnosis"
  | "activate_plan"
  | "start_reflection"
  | "schedule_delayed_review"
  | "start_transfer"
  | "complete_journey"
  | "pause"
  | "resume"
  | "wait_for_teacher"
  | "teacher_resolved"
  | "wait_for_consent"
  | "consent_granted"
  | "withdraw";

export const journeyTransitions: TransitionTable<JourneyState, JourneyEvent> = {
  onboarding: { start_diagnosis: "diagnosing", withdraw: "withdrawn" },
  diagnosing: { complete_diagnosis: "planning", withdraw: "withdrawn" },
  planning: {
    activate_plan: "active",
    wait_for_teacher: "waiting_teacher",
    wait_for_consent: "waiting_consent",
    withdraw: "withdrawn",
  },
  active: {
    start_reflection: "reflecting",
    pause: "paused",
    wait_for_teacher: "waiting_teacher",
    wait_for_consent: "waiting_consent",
    withdraw: "withdrawn",
  },
  reflecting: { schedule_delayed_review: "delayed_review", withdraw: "withdrawn" },
  delayed_review: { start_transfer: "transferring", withdraw: "withdrawn" },
  transferring: { complete_journey: "completed", withdraw: "withdrawn" },
  completed: {},
  paused: { resume: "active", withdraw: "withdrawn" },
  waiting_teacher: { teacher_resolved: "active", withdraw: "withdrawn" },
  waiting_consent: { consent_granted: "active", withdraw: "withdrawn" },
  withdrawn: {},
};

export function transitionJourney(
  journey: VersionedState<JourneyState>,
  command: TransitionCommand<JourneyEvent>,
) {
  return applyTransition(journeyTransitions, journey, command);
}
