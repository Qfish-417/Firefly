import type { ArtifactRef, JsonObject } from "@firefly/contracts";
import type { Kysely, Selectable, Transaction } from "kysely";

import type { ArtifactTable, QuestLabDatabase } from "./database.ts";

export interface StoreArtifactInput extends ArtifactRef {
  readonly metadata: JsonObject;
}

export interface ArtifactPrincipal {
  readonly type: "user" | "agent" | "tenant" | "role";
  readonly id: string;
}

export type ArtifactRecord = Selectable<ArtifactTable>;

export class ArtifactIdentityConflictError extends Error {
  readonly artifactId: string;

  constructor(artifactId: string) {
    super(`Artifact ID was reused for different immutable content: ${artifactId}`);
    this.name = "ArtifactIdentityConflictError";
    this.artifactId = artifactId;
  }
}

/**
 * The same immutable content already exists under a different artifact ID.
 *
 * `artifact` carries `UNIQUE (digest, scope, owner_id)` (migration 001) which `onConflict("id")`
 * does not cover, so this used to escape as a raw pg 23505 with no artifact context.
 */
export class ArtifactDigestConflictError extends Error {
  readonly artifactId: string;
  readonly digest: string;

  constructor(artifactId: string, digest: string, existingArtifactId?: string) {
    super(
      `Artifact ${artifactId} duplicates digest ${digest} already stored in this scope` +
        (existingArtifactId ? ` as ${existingArtifactId}` : ""),
    );
    this.name = "ArtifactDigestConflictError";
    this.artifactId = artifactId;
    this.digest = digest;
  }
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    typeof error === "object" && error !== null &&
    (error as { code?: unknown }).code === "23505" &&
    String((error as { constraint?: unknown }).constraint ?? "").includes(constraint)
  );
}

export class ArtifactRepository {
  private readonly db: Kysely<QuestLabDatabase>;

  constructor(db: Kysely<QuestLabDatabase>) {
    this.db = db;
  }

  async store(input: StoreArtifactInput): Promise<ArtifactRecord> {
    try {
      return await this.storeOnce(input);
    } catch (error) {
      if (!isUniqueViolation(error, "artifact_digest_scope_owner_id_key")) throw error;
      // A concurrent writer stored the same content under another ID. Report which one, instead of
      // letting a raw driver error reach the caller.
      const existing = await this.db
        .selectFrom("questlab.artifact")
        .select(["id"])
        .where("digest", "=", input.digest)
        .where("scope", "=", input.scope)
        .where("owner_id", "=", input.owner_id)
        .executeTakeFirst();
      throw new ArtifactDigestConflictError(input.artifact_id, input.digest, existing?.id);
    }
  }

  private async storeOnce(input: StoreArtifactInput): Promise<ArtifactRecord> {
    return this.db.transaction().execute(async (trx) => {
      const inserted = await trx
        .insertInto("questlab.artifact")
        .values({
          id: input.artifact_id,
          uri: input.uri,
          digest: input.digest,
          media_type: input.media_type,
          scope: input.scope,
          owner_id: input.owner_id,
          metadata: input.metadata,
        })
        .onConflict((conflict) => conflict.column("id").doNothing())
        .returningAll()
        .executeTakeFirst();
      if (inserted) {
        await this.addLineage(trx, input.artifact_id, input.lineage_ids);
        return inserted;
      }

      const existing = await trx
        .selectFrom("questlab.artifact")
        .selectAll()
        .where("id", "=", input.artifact_id)
        .executeTakeFirstOrThrow();
      if (
        existing.digest !== input.digest ||
        existing.uri !== input.uri ||
        existing.scope !== input.scope ||
        existing.owner_id !== input.owner_id
      ) {
        throw new ArtifactIdentityConflictError(input.artifact_id);
      }
      return existing;
    });
  }

  async grant(
    artifactId: string,
    principal: ArtifactPrincipal,
    permission: "read" | "write" | "delete",
  ): Promise<void> {
    await this.db
      .insertInto("questlab.artifact_acl")
      .values({
        artifact_id: artifactId,
        principal_type: principal.type,
        principal_id: principal.id,
        permission,
      })
      .onConflict((conflict) =>
        conflict.columns(["artifact_id", "principal_type", "principal_id", "permission"]).doNothing(),
      )
      .execute();
  }

  async canRead(artifactId: string, principal: ArtifactPrincipal): Promise<boolean> {
    const artifact = await this.db
      .selectFrom("questlab.artifact")
      .select(["scope", "owner_id"])
      .where("id", "=", artifactId)
      .executeTakeFirst();
    if (!artifact) {
      return false;
    }
    if (artifact.scope === "public" || artifact.owner_id === principal.id) {
      return true;
    }

    const acl = await this.db
      .selectFrom("questlab.artifact_acl")
      .select("artifact_id")
      .where("artifact_id", "=", artifactId)
      .where("principal_type", "=", principal.type)
      .where("principal_id", "=", principal.id)
      .where("permission", "=", "read")
      .executeTakeFirst();
    return Boolean(acl);
  }

  private async addLineage(
    trx: Transaction<QuestLabDatabase>,
    artifactId: string,
    lineageIds: readonly string[],
  ): Promise<void> {
    if (lineageIds.length === 0) {
      return;
    }
    await trx
      .insertInto("questlab.artifact_lineage")
      .values(
        lineageIds.map((sourceArtifactId) => ({
          artifact_id: artifactId,
          source_artifact_id: sourceArtifactId,
          relation: "derived_from",
        })),
      )
      .onConflict((conflict) =>
        conflict.columns(["artifact_id", "source_artifact_id", "relation"]).doNothing(),
      )
      .execute();
  }
}
