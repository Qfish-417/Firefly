export interface GovernancePolicy {
  readonly snapshot: string;
  readonly max_hops: number;
  readonly max_tasks_per_run: number;
  readonly max_transitions_per_run: number;
  readonly max_retries_per_task: number;
}

export const defaultGovernancePolicy: GovernancePolicy = {
  snapshot: "governance.default.v1",
  max_hops: 8,
  max_tasks_per_run: 32,
  max_transitions_per_run: 24,
  max_retries_per_task: 3,
};
