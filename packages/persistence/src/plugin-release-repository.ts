import type { ArtifactRef, ChangeSet, JsonObject } from "@firefly/contracts";
import {
  transitionPluginRelease,
  type PluginReleaseEvent,
  type PluginReleaseState,
} from "@firefly/learning-domain";
import type { Kysely, Selectable, Transaction } from "kysely";

import type {
  CanaryEvaluationTable,
  PluginReleaseTable,
  PluginTable,
  PluginVersionTable,
  QuestLabDatabase,
  SandboxRunTable,
} from "./database.ts";

export type PluginRecord = Selectable<PluginTable>;
export type PluginVersionRecord = Selectable<PluginVersionTable>;
export type PluginReleaseRecord = Selectable<PluginReleaseTable>;
export type SandboxRunRecord = Selectable<SandboxRunTable>;
export type CanaryEvaluationRecord = Selectable<CanaryEvaluationTable>;

export class PluginReleaseEvidenceError extends Error {
  constructor(releaseId: string, detail: string) {
    super(`Plugin release ${releaseId} is missing required evidence: ${detail}`);
    this.name = "PluginReleaseEvidenceError";
  }
}

export class PluginReleaseNotFoundError extends Error {
  constructor(releaseId: string) {
    super(`Plugin release not found: ${releaseId}`);
    this.name = "PluginReleaseNotFoundError";
  }
}

export interface PluginReleaseTransitionCommand {
  readonly event_id: string;
  readonly event: PluginReleaseEvent;
  readonly expected_version: number;
  readonly occurred_at: Date;
  readonly evidence?: JsonObject;
  readonly verification_report_id?: string;
  readonly approval_id?: string;
}

export class PluginReleaseRepository {
  private readonly db: Kysely<QuestLabDatabase>;

  constructor(db: Kysely<QuestLabDatabase>) {
    this.db = db;
  }

  async registerBaseline(input: {
    readonly plugin_id: string;
    readonly version_id: string;
    readonly version: string;
    readonly artifact: ArtifactRef;
    readonly source_commit: string;
  }): Promise<PluginRecord> {
    return this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto("questlab.plugin")
        .values({ plugin_id: input.plugin_id, active_version_id: null })
        .onConflict((conflict) => conflict.column("plugin_id").doNothing())
        .execute();
      await trx
        .insertInto("questlab.plugin_version")
        .values({
          version_id: input.version_id,
          plugin_id: input.plugin_id,
          version: input.version,
          digest: input.artifact.digest,
          artifact_ref: input.artifact as unknown as JsonObject,
          source_commit: input.source_commit,
          status: "active",
        })
        .onConflict((conflict) => conflict.column("version_id").doNothing())
        .execute();
      return trx
        .updateTable("questlab.plugin")
        .set({ active_version_id: input.version_id, updated_at: new Date() })
        .where("plugin_id", "=", input.plugin_id)
        .where((expression) =>
          expression.or([
            expression("active_version_id", "is", null),
            expression("active_version_id", "=", input.version_id),
          ]),
        )
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }

  async propose(input: {
    readonly release_id: string;
    readonly run_id: string;
    readonly plugin_id: string;
    readonly candidate_version_id: string;
    readonly candidate_version: string;
    readonly candidate_artifact: ArtifactRef;
    readonly source_commit: string;
    readonly rollback_version_id: string;
    readonly change_set: ChangeSet;
    readonly authorized_task_id: string;
    readonly canary_policy: JsonObject;
  }): Promise<PluginReleaseRecord> {
    return this.db.transaction().execute(async (trx) => {
      const replay = await trx
        .selectFrom("questlab.plugin_release")
        .selectAll()
        .where("release_id", "=", input.release_id)
        .executeTakeFirst();
      if (replay) {
        if (
          replay.run_id !== input.run_id ||
          replay.changeset_id !== input.change_set.changeset_id ||
          replay.authorized_task_id !== input.authorized_task_id
        ) {
          throw new PluginReleaseEvidenceError(input.release_id, "idempotent proposal identity");
        }
        return replay;
      }
      const task = await trx
        .selectFrom("questlab.workflow_task")
        .select(["id", "run_id", "subject", "status"])
        .where("id", "=", input.authorized_task_id)
        .executeTakeFirst();
      if (
        !task ||
        task.run_id !== input.run_id ||
        task.subject !== "experience-engineer" ||
        task.status !== "completed"
      ) {
        throw new PluginReleaseEvidenceError(input.release_id, "completed governed Engineer task");
      }
      const persistedChange = await trx
        .selectFrom("questlab.change_set")
        .select(["changeset_id", "run_id"])
        .where("changeset_id", "=", input.change_set.changeset_id)
        .executeTakeFirst();
      if (!persistedChange || persistedChange.run_id !== input.run_id) {
        throw new PluginReleaseEvidenceError(input.release_id, "persisted ChangeSet");
      }
      const plugin = await trx
        .selectFrom("questlab.plugin")
        .select(["plugin_id", "active_version_id"])
        .where("plugin_id", "=", input.plugin_id)
        .forUpdate()
        .executeTakeFirst();
      if (!plugin || plugin.active_version_id !== input.rollback_version_id) {
        throw new PluginReleaseEvidenceError(input.release_id, "active rollback version");
      }
      const rollback = await trx
        .selectFrom("questlab.plugin_version")
        .select(["version_id", "plugin_id"])
        .where("version_id", "=", input.rollback_version_id)
        .executeTakeFirst();
      if (!rollback || rollback.plugin_id !== input.plugin_id) {
        throw new PluginReleaseEvidenceError(input.release_id, "registered rollback version");
      }
      await trx
        .insertInto("questlab.plugin_version")
        .values({
          version_id: input.candidate_version_id,
          plugin_id: input.plugin_id,
          version: input.candidate_version,
          digest: input.candidate_artifact.digest,
          artifact_ref: input.candidate_artifact as unknown as JsonObject,
          source_commit: input.source_commit,
          status: "candidate",
        })
        .execute();
      return trx
        .insertInto("questlab.plugin_release")
        .values({
          release_id: input.release_id,
          run_id: input.run_id,
          plugin_id: input.plugin_id,
          candidate_version_id: input.candidate_version_id,
          rollback_version_id: input.rollback_version_id,
          changeset_id: input.change_set.changeset_id,
          authorized_task_id: input.authorized_task_id,
          state: "proposed",
          version: 0,
          canary_policy: input.canary_policy,
          verification_report_id: null,
          approval_id: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }

  async recordSandboxRun(input: {
    readonly sandbox_run_id: string;
    readonly release_id: string;
    readonly status: SandboxRunTable["status"];
    readonly image: string;
    readonly limits: JsonObject;
    readonly checks: readonly JsonObject[];
    readonly started_at: Date;
    readonly completed_at: Date;
  }): Promise<SandboxRunRecord> {
    const inserted = await this.db
      .insertInto("questlab.sandbox_run")
      .values({
        ...input,
        runner: "docker",
        network_mode: "none",
        read_only: true,
        checks: JSON.stringify(input.checks),
      })
      .onConflict((conflict) => conflict.column("sandbox_run_id").doNothing())
      .returningAll()
      .executeTakeFirst();
    if (inserted) return inserted;
    return this.db
      .selectFrom("questlab.sandbox_run")
      .selectAll()
      .where("sandbox_run_id", "=", input.sandbox_run_id)
      .executeTakeFirstOrThrow();
  }

  async recordCanaryEvaluation(input: {
    readonly evaluation_id: string;
    readonly release_id: string;
    readonly cohort: string;
    readonly sample_size: number;
    readonly metrics: JsonObject;
    readonly decision: CanaryEvaluationTable["decision"];
    readonly evidence_refs: readonly ArtifactRef[];
    readonly evaluated_at: Date;
  }): Promise<CanaryEvaluationRecord> {
    const inserted = await this.db
      .insertInto("questlab.canary_evaluation")
      .values({ ...input, evidence_refs: JSON.stringify(input.evidence_refs) })
      .onConflict((conflict) => conflict.column("evaluation_id").doNothing())
      .returningAll()
      .executeTakeFirst();
    if (inserted) return inserted;
    return this.db
      .selectFrom("questlab.canary_evaluation")
      .selectAll()
      .where("evaluation_id", "=", input.evaluation_id)
      .executeTakeFirstOrThrow();
  }

  async transition(
    releaseId: string,
    command: PluginReleaseTransitionCommand,
  ): Promise<{ readonly release: PluginReleaseRecord; readonly changed: boolean }> {
    return this.db.transaction().execute(async (trx) => {
      const replay = await trx
        .selectFrom("questlab.plugin_release_transition")
        .select("release_id")
        .where("event_id", "=", command.event_id)
        .executeTakeFirst();
      if (replay) {
        if (replay.release_id !== releaseId) {
          throw new PluginReleaseEvidenceError(releaseId, "globally unique transition event");
        }
        const release = await trx
          .selectFrom("questlab.plugin_release")
          .selectAll()
          .where("release_id", "=", releaseId)
          .executeTakeFirstOrThrow();
        return { release, changed: false };
      }
      const current = await trx
        .selectFrom("questlab.plugin_release")
        .selectAll()
        .where("release_id", "=", releaseId)
        .forUpdate()
        .executeTakeFirst();
      if (!current) {
        throw new PluginReleaseNotFoundError(releaseId);
      }
      await this.assertEvidence(trx, current, command);
      const transition = transitionPluginRelease(
        { state: current.state, version: current.version, applied_event_ids: [] },
        command,
      );
      const release = await trx
        .updateTable("questlab.plugin_release")
        .set({
          state: transition.aggregate.state,
          version: transition.aggregate.version,
          updated_at: command.occurred_at,
          ...(command.verification_report_id
            ? { verification_report_id: command.verification_report_id }
            : {}),
          ...(command.approval_id ? { approval_id: command.approval_id } : {}),
        })
        .where("release_id", "=", releaseId)
        .where("version", "=", current.version)
        .returningAll()
        .executeTakeFirstOrThrow();
      await trx
        .insertInto("questlab.plugin_release_transition")
        .values({
          event_id: command.event_id,
          release_id: releaseId,
          event_type: command.event,
          from_state: current.state,
          to_state: release.state,
          from_version: current.version,
          to_version: release.version,
          evidence: command.evidence ?? {},
          occurred_at: command.occurred_at,
        })
        .execute();
      if (command.event === "canary_succeeded") {
        await this.activateVersion(trx, current.plugin_id, current.candidate_version_id);
      } else if (command.event === "canary_degraded" || command.event === "rollback") {
        await this.activateVersion(trx, current.plugin_id, current.rollback_version_id);
      }
      const run = await trx
        .selectFrom("questlab.evolution_run")
        .select("correlation_id")
        .where("id", "=", current.run_id)
        .executeTakeFirstOrThrow();
      await trx
        .insertInto("questlab.outbox_event")
        .values({
          event_id: `outbox.${command.event_id}`,
          event_type: "PluginReleaseTransitioned",
          schema_version: 1,
          correlation_id: run.correlation_id,
          causation_id: command.event_id,
          trace_id: `trace.${current.run_id}`,
          producer: "plugin-platform",
          idempotency_key: `plugin-release-transition:${command.event_id}`,
          payload: {
            release_id: releaseId,
            plugin_id: current.plugin_id,
            transition_event: command.event,
            from_state: current.state,
            to_state: release.state,
            version: release.version,
          },
          artifact_refs: "[]",
          occurred_at: command.occurred_at,
          available_at: command.occurred_at,
          attempts: 0,
          locked_by: null,
          locked_until: null,
          published_at: null,
          last_error: null,
        })
        .execute();
      return { release, changed: true };
    });
  }

  async findById(releaseId: string): Promise<PluginReleaseRecord | undefined> {
    return this.db
      .selectFrom("questlab.plugin_release")
      .selectAll()
      .where("release_id", "=", releaseId)
      .executeTakeFirst();
  }

  async getActiveVersion(pluginId: string): Promise<PluginVersionRecord | undefined> {
    return this.db
      .selectFrom("questlab.plugin")
      .innerJoin(
        "questlab.plugin_version",
        "questlab.plugin_version.version_id",
        "questlab.plugin.active_version_id",
      )
      .selectAll("questlab.plugin_version")
      .where("questlab.plugin.plugin_id", "=", pluginId)
      .executeTakeFirst();
  }

  private async assertEvidence(
    trx: Transaction<QuestLabDatabase>,
    release: PluginReleaseRecord,
    command: PluginReleaseTransitionCommand,
  ): Promise<void> {
    if (command.event === "sandbox_passed") {
      const sandbox = await trx
        .selectFrom("questlab.sandbox_run")
        .select("sandbox_run_id")
        .where("release_id", "=", release.release_id)
        .where("status", "=", "passed")
        .executeTakeFirst();
      if (!sandbox) throw new PluginReleaseEvidenceError(release.release_id, "passed Sandbox run");
    }
    if (command.event === "verification_passed") {
      if (!command.verification_report_id) {
        throw new PluginReleaseEvidenceError(release.release_id, "VerificationReport id");
      }
      const report = await trx
        .selectFrom("questlab.verification_report")
        .select(["report_id", "changeset_id"])
        .where("report_id", "=", command.verification_report_id)
        .where("status", "=", "passed")
        .executeTakeFirst();
      if (!report || report.changeset_id !== release.changeset_id) {
        throw new PluginReleaseEvidenceError(release.release_id, "passed matching VerificationReport");
      }
    }
    if (command.event === "approve") {
      if (!command.approval_id) {
        throw new PluginReleaseEvidenceError(release.release_id, "release Approval id");
      }
      const approval = await trx
        .selectFrom("questlab.approval")
        .select("id")
        .where("id", "=", command.approval_id)
        .where("subject_type", "=", "PluginRelease")
        .where("subject_id", "=", release.release_id)
        .where("status", "=", "approved")
        .executeTakeFirst();
      if (!approval) throw new PluginReleaseEvidenceError(release.release_id, "approved release");
    }
    if (["canary_succeeded", "canary_degraded", "rollback"].includes(command.event)) {
      const expected = command.event === "canary_succeeded" ? "activate" : "rollback";
      const evaluation = await trx
        .selectFrom("questlab.canary_evaluation")
        .select(["evaluation_id", "decision"])
        .where("release_id", "=", release.release_id)
        .orderBy("evaluated_at", "desc")
        .executeTakeFirst();
      if (!evaluation || evaluation.decision !== expected) {
        throw new PluginReleaseEvidenceError(release.release_id, `${expected} CanaryEvaluation`);
      }
    }
  }

  private async activateVersion(
    trx: Transaction<QuestLabDatabase>,
    pluginId: string,
    versionId: string,
  ): Promise<void> {
    await trx
      .updateTable("questlab.plugin_version")
      .set({ status: "inactive" })
      .where("plugin_id", "=", pluginId)
      .where("status", "=", "active")
      .execute();
    await trx
      .updateTable("questlab.plugin_version")
      .set({ status: "active" })
      .where("version_id", "=", versionId)
      .where("plugin_id", "=", pluginId)
      .executeTakeFirstOrThrow();
    await trx
      .updateTable("questlab.plugin")
      .set({ active_version_id: versionId, updated_at: new Date() })
      .where("plugin_id", "=", pluginId)
      .execute();
  }
}
