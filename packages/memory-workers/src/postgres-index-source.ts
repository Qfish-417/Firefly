import { createHash } from "node:crypto";
import type { ArtifactRef, IndexBuildTask } from "@firefly/contracts";
import type { Kysely } from "kysely";

import type { MemoryRecordTable, QuestLabDatabase } from "@firefly/persistence";

import { IndexBuildWorkerError, type IndexSourceDocument, type IndexSourcePort } from "./index-build-worker.ts";
import type { BinaryObjectReadPort } from "./binary-object-source.ts";

export interface TextArtifactReadInput {
  readonly artifact: ArtifactRef;
  readonly max_bytes: number;
}

export interface TextArtifactReadPort {
  readText(input: TextArtifactReadInput): Promise<string>;
}

/** Reads UTF-8 text from an object store and verifies the immutable Artifact digest. */
export class BinaryTextArtifactReadPort implements TextArtifactReadPort {
  private readonly objects: BinaryObjectReadPort;

  constructor(objects: BinaryObjectReadPort) {
    this.objects = objects;
  }

  async readText(input: TextArtifactReadInput): Promise<string> {
    if (!isTextMediaType(input.artifact.media_type)) {
      throw new IndexBuildWorkerError(
        "TEXT_SOURCE_REQUIRES_PARSER",
        `Artifact ${input.artifact.artifact_id} is ${input.artifact.media_type}; a governed parser must produce text first`,
        false,
      );
    }
    const bytes = await this.objects.readObject({
      ...parseObjectUri(input.artifact.uri),
      max_bytes: input.max_bytes,
    });
    const digest = `sha256:${createSha256(bytes)}`;
    if (digest !== input.artifact.digest) {
      throw new IndexBuildWorkerError("TEXT_SOURCE_DIGEST_MISMATCH", "Text Artifact digest does not match Citation", false);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new IndexBuildWorkerError("TEXT_SOURCE_INVALID_UTF8", "Text Artifact is not valid UTF-8", false);
    }
  }
}

export interface PostgresMemoryIndexSourceOptions {
  readonly max_documents?: number;
  readonly max_artifact_bytes?: number;
  readonly read_artifact: TextArtifactReadPort;
}

/**
 * Loads active Memory source artifacts for a tenant and exposes only verified text.
 * The index worker intentionally has no multimodal model dependency: binary inputs
 * must be converted by a governed parser before they become indexable text.
 */
export class PostgresMemoryIndexSourcePort implements IndexSourcePort {
  private readonly db: Kysely<QuestLabDatabase>;
  private readonly options: Required<Pick<PostgresMemoryIndexSourceOptions, "max_documents" | "max_artifact_bytes">> &
    Pick<PostgresMemoryIndexSourceOptions, "read_artifact">;

  constructor(db: Kysely<QuestLabDatabase>, options: PostgresMemoryIndexSourceOptions) {
    this.db = db;
    this.options = {
      max_documents: options.max_documents ?? 10_000,
      max_artifact_bytes: options.max_artifact_bytes ?? 50_000_000,
      read_artifact: options.read_artifact,
    };
    if (!Number.isInteger(this.options.max_documents) || this.options.max_documents < 1 || this.options.max_documents > 100_000) {
      throw new TypeError("max_documents must be between 1 and 100000");
    }
    if (!Number.isInteger(this.options.max_artifact_bytes) || this.options.max_artifact_bytes < 1_024 || this.options.max_artifact_bytes > 500_000_000) {
      throw new TypeError("max_artifact_bytes must be between 1024 and 500000000");
    }
  }

  async load(task: IndexBuildTask): Promise<readonly IndexSourceDocument[]> {
    const rows = await this.db
      .selectFrom("questlab.memory_record")
      .selectAll()
      .where("tenant_id", "=", task.tenant_id)
      .where("status", "=", "active")
      .where("deleted_at", "is", null)
      .where("scope", "in", ["public", "tenant"] satisfies readonly MemoryRecordTable["scope"][])
      .orderBy("updated_at", "asc")
      .orderBy("memory_id", "asc")
      .limit(this.options.max_documents + 1)
      .execute();
    if (rows.length > this.options.max_documents) {
      throw new IndexBuildWorkerError("MEMORY_SOURCE_LIMIT_EXCEEDED", "Memory source exceeds the configured document limit", false);
    }
    const observedWatermark = sourceWatermark(rows);
    if (task.source_watermark !== observedWatermark) {
      throw new IndexBuildWorkerError(
        "MEMORY_SOURCE_WATERMARK_MISMATCH",
        `Memory source watermark changed from ${task.source_watermark} to ${observedWatermark}`,
        false,
      );
    }
    const documents: IndexSourceDocument[] = [];
    for (const row of rows) {
      const refs = parseArtifactRefs(row.source_refs);
      if (refs.length === 0) {
        throw new IndexBuildWorkerError("MEMORY_SOURCE_MISSING", `Memory ${row.memory_id} has no source artifact`, false);
      }
      if (refs.length > 1) {
        throw new IndexBuildWorkerError("MEMORY_SOURCE_MULTIPLE_ARTIFACTS_UNSUPPORTED", `Memory ${row.memory_id} has multiple source artifacts; create a derived text Artifact first`, false);
      }
      if (row.content_digest !== refs[0]!.digest) {
        throw new IndexBuildWorkerError("MEMORY_SOURCE_DIGEST_MISMATCH", `Memory ${row.memory_id} digest differs from its source Artifact`, false);
      }
      for (const artifact of refs) {
        if (!artifactBelongsToTenant(artifact, task.tenant_id)) {
          throw new IndexBuildWorkerError("MEMORY_SOURCE_TENANT_MISMATCH", `Artifact ${artifact.artifact_id} crosses tenant boundary`, false);
        }
        await verifyPersistedArtifact(this.db, artifact, task.tenant_id);
        const content = await this.options.read_artifact.readText({ artifact, max_bytes: this.options.max_artifact_bytes });
        if (!content.trim()) continue;
        documents.push({
          memory_id: row.memory_id,
          content,
          source_type: sourceType(artifact.media_type),
          entity_keys: metadataStringList(row.metadata, "entity_keys"),
          citation: { artifact_id: artifact.artifact_id, uri: artifact.uri, digest: artifact.digest },
        });
      }
    }
    return documents;
  }

  async currentWatermark(task: Pick<IndexBuildTask, "tenant_id">): Promise<string> {
    const rows = await this.db
      .selectFrom("questlab.memory_record")
      .select(["memory_id", "version", "content_digest", "updated_at"])
      .where("tenant_id", "=", task.tenant_id)
      .where("status", "=", "active")
      .where("deleted_at", "is", null)
      .where("scope", "in", ["public", "tenant"] satisfies readonly MemoryRecordTable["scope"][])
      .orderBy("updated_at", "asc")
      .orderBy("memory_id", "asc")
      .limit(this.options.max_documents + 1)
      .execute();
    if (rows.length > this.options.max_documents) {
      throw new IndexBuildWorkerError("MEMORY_SOURCE_LIMIT_EXCEEDED", "Memory source exceeds the configured document limit", false);
    }
    return sourceWatermark(rows);
  }
}

function sourceWatermark(rows: readonly {
  readonly memory_id: string;
  readonly version: number;
  readonly content_digest: string;
  readonly updated_at: Date;
}[]): string {
  const canonical = rows.map((row) => [
    row.memory_id,
    row.version,
    row.content_digest,
    row.updated_at.toISOString(),
  ]);
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex")}`;
}

function parseArtifactRefs(value: unknown): readonly ArtifactRef[] {
  if (!Array.isArray(value)) throw new IndexBuildWorkerError("MEMORY_SOURCE_INVALID", "Memory source_refs must be an array", false);
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new IndexBuildWorkerError("MEMORY_SOURCE_INVALID", "Memory source reference is invalid", false);
    const ref = item as Partial<ArtifactRef>;
    if (!ref.artifact_id || !ref.uri || !ref.digest || !ref.media_type || !ref.scope || !ref.owner_id) {
      throw new IndexBuildWorkerError("MEMORY_SOURCE_INVALID", "Memory source reference is incomplete", false);
    }
    return ref as ArtifactRef;
  });
}

function artifactBelongsToTenant(artifact: ArtifactRef, tenantId: string): boolean {
  return artifact.scope === "public" || (artifact.scope === "tenant" && artifact.owner_id === tenantId);
}

async function verifyPersistedArtifact(
  db: Kysely<QuestLabDatabase>,
  artifact: ArtifactRef,
  tenantId: string,
): Promise<void> {
  const persisted = await db
    .selectFrom("questlab.artifact")
    .select(["uri", "digest", "media_type", "scope", "owner_id"])
    .where("id", "=", artifact.artifact_id)
    .executeTakeFirst();
  if (!persisted) {
    throw new IndexBuildWorkerError("MEMORY_SOURCE_ARTIFACT_MISSING", `Artifact ${artifact.artifact_id} is not persisted`, false);
  }
  if (
    persisted.uri !== artifact.uri ||
    persisted.digest !== artifact.digest ||
    persisted.media_type !== artifact.media_type ||
    persisted.scope !== artifact.scope ||
    persisted.owner_id !== artifact.owner_id
  ) {
    throw new IndexBuildWorkerError("MEMORY_SOURCE_ARTIFACT_CONFLICT", `Artifact ${artifact.artifact_id} differs from persisted identity`, false);
  }
  if (persisted.scope !== "public" && (persisted.scope !== "tenant" || persisted.owner_id !== tenantId)) {
    throw new IndexBuildWorkerError("MEMORY_SOURCE_TENANT_MISMATCH", `Persisted Artifact ${artifact.artifact_id} crosses tenant boundary`, false);
  }
}

function sourceType(mediaType: string): string {
  const normalized = mediaType.toLowerCase();
  return normalized.startsWith("text/") || normalized.includes("markdown") || normalized.includes("json")
    ? normalized
    : "text/derived";
}

function metadataStringList(metadata: unknown, key: string): readonly string[] {
  if (!metadata || typeof metadata !== "object") return [];
  const value = (metadata as Record<string, unknown>)[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isTextMediaType(mediaType: string): boolean {
  const value = mediaType.trim().toLowerCase();
  return value.startsWith("text/") || value === "application/json" || value.endsWith("+json") || value.includes("markdown");
}

function parseObjectUri(uri: string): { readonly bucket: string; readonly key: string } {
  let parsed: URL;
  try { parsed = new URL(uri); } catch { throw new IndexBuildWorkerError("INVALID_TEXT_SOURCE_URI", "Text Artifact URI is invalid", false); }
  if (parsed.protocol !== "s3:" || !parsed.hostname || parsed.pathname.length < 2 || parsed.search || parsed.hash) {
    throw new IndexBuildWorkerError("INVALID_TEXT_SOURCE_URI", "Text Artifact URI must be an absolute s3:// URI", false);
  }
  return { bucket: parsed.hostname, key: decodeURIComponent(parsed.pathname.slice(1)) };
}

function createSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
