import assert from "node:assert/strict";
import test from "node:test";

import {
  InvalidTransitionError,
  VersionConflictError,
  createInitialState,
  transitionEvolutionRun,
  transitionJourney,
  transitionMission,
  transitionPluginRelease,
  type EvolutionRunState,
  type JourneyState,
  type MissionState,
  type PluginReleaseState,
  type VersionedState,
} from "../src/index.ts";

test("journey follows the complete learning lifecycle", () => {
  let journey: VersionedState<JourneyState> = createInitialState("onboarding");
  const events = [
    "start_diagnosis",
    "complete_diagnosis",
    "activate_plan",
    "start_reflection",
    "schedule_delayed_review",
    "start_transfer",
    "complete_journey",
  ] as const;

  for (const [index, event] of events.entries()) {
    journey = transitionJourney(journey, {
      event_id: `journey-event.${index}`,
      event,
      expected_version: index,
    }).aggregate;
  }

  assert.equal(journey.state, "completed");
  assert.equal(journey.version, events.length);
});

test("mission can remediate and then reach mastery", () => {
  let mission: VersionedState<MissionState> = createInitialState("draft");
  const events = [
    "mark_ready",
    "activate",
    "submit_for_assessment",
    "require_remediation",
    "retry",
    "submit_for_assessment",
    "confirm_mastery",
  ] as const;

  for (const [index, event] of events.entries()) {
    mission = transitionMission(mission, {
      event_id: `mission-event.${index}`,
      event,
      expected_version: index,
    }).aggregate;
  }

  assert.equal(mission.state, "mastered");
});

test("plugin release requires sandbox, verification and approval before activation", () => {
  let release: VersionedState<PluginReleaseState> = createInitialState("proposed");
  const events = [
    "sandbox_passed",
    "verification_passed",
    "request_approval",
    "approve",
    "canary_succeeded",
  ] as const;

  for (const [index, event] of events.entries()) {
    release = transitionPluginRelease(release, {
      event_id: `release-event.${index}`,
      event,
      expected_version: index,
    }).aggregate;
  }

  assert.equal(release.state, "active");
});

test("a degraded plugin canary reaches a terminal rollback state", () => {
  let release: VersionedState<PluginReleaseState> = createInitialState("proposed");
  const events = [
    "sandbox_passed",
    "verification_passed",
    "request_approval",
    "approve",
    "canary_degraded",
  ] as const;

  for (const [index, event] of events.entries()) {
    release = transitionPluginRelease(release, {
      event_id: `rollback-event.${index}`,
      event,
      expected_version: index,
    }).aggregate;
  }

  assert.equal(release.state, "rolled_back");
});

test("evolution run follows the evidence-to-learning happy path", () => {
  let run: VersionedState<EvolutionRunState> = createInitialState("observed");
  const events = [
    "finding_created",
    "plan_created",
    "approval_requested",
    "plan_approved",
    "change_built",
    "verification_passed",
    "canary_succeeded",
    "outcome_recorded",
  ] as const;

  for (const [index, event] of events.entries()) {
    run = transitionEvolutionRun(run, {
      event_id: `evolution-event.${index}`,
      event,
      expected_version: index,
    }).aggregate;
  }

  assert.equal(run.state, "learned");
});

test("invalid state transitions are rejected", () => {
  const journey = createInitialState("onboarding" as const);

  assert.throws(
    () =>
      transitionJourney(journey, {
        event_id: "journey-event.invalid",
        event: "complete_journey",
        expected_version: 0,
      }),
    InvalidTransitionError,
  );
});

test("optimistic version conflicts are rejected", () => {
  const mission = createInitialState("draft" as const);

  assert.throws(
    () =>
      transitionMission(mission, {
        event_id: "mission-event.conflict",
        event: "mark_ready",
        expected_version: 2,
      }),
    VersionConflictError,
  );
});

test("replaying the same event is idempotent even with a stale expected version", () => {
  const initial = createInitialState("draft" as const);
  const command = {
    event_id: "mission-event.once",
    event: "mark_ready" as const,
    expected_version: 0,
  };

  const first = transitionMission(initial, command);
  const replay = transitionMission(first.aggregate, command);

  assert.equal(first.changed, true);
  assert.equal(replay.changed, false);
  assert.strictEqual(replay.aggregate, first.aggregate);
});
