export interface VersionedState<TState extends string> {
  readonly state: TState;
  readonly version: number;
  readonly applied_event_ids: readonly string[];
}

export interface TransitionCommand<TEvent extends string> {
  readonly event_id: string;
  readonly event: TEvent;
  readonly expected_version: number;
}

export interface TransitionResult<TState extends string> {
  readonly aggregate: VersionedState<TState>;
  readonly changed: boolean;
}

export type TransitionTable<TState extends string, TEvent extends string> = Readonly<
  Record<TState, Readonly<Partial<Record<TEvent, TState>>>>
>;

export class InvalidTransitionError extends Error {
  readonly currentState: string;
  readonly event: string;

  constructor(
    currentState: string,
    event: string,
  ) {
    super(`Event ${event} is not allowed from state ${currentState}`);
    this.name = "InvalidTransitionError";
    this.currentState = currentState;
    this.event = event;
  }
}

export class VersionConflictError extends Error {
  readonly expectedVersion: number;
  readonly actualVersion: number;

  constructor(
    expectedVersion: number,
    actualVersion: number,
  ) {
    super(`Expected version ${expectedVersion}, received ${actualVersion}`);
    this.name = "VersionConflictError";
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

export function createInitialState<TState extends string>(state: TState): VersionedState<TState> {
  return {
    state,
    version: 0,
    applied_event_ids: [],
  };
}

export function applyTransition<TState extends string, TEvent extends string>(
  transitions: TransitionTable<TState, TEvent>,
  aggregate: VersionedState<TState>,
  command: TransitionCommand<TEvent>,
): TransitionResult<TState> {
  if (aggregate.applied_event_ids.includes(command.event_id)) {
    return { aggregate, changed: false };
  }

  if (command.expected_version !== aggregate.version) {
    throw new VersionConflictError(command.expected_version, aggregate.version);
  }

  const nextState = transitions[aggregate.state][command.event];
  if (!nextState) {
    throw new InvalidTransitionError(aggregate.state, command.event);
  }

  return {
    changed: true,
    aggregate: {
      state: nextState,
      version: aggregate.version + 1,
      applied_event_ids: [...aggregate.applied_event_ids, command.event_id],
    },
  };
}
