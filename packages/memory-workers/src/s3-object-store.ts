import { DeleteObjectCommand, S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
import type { ArtifactRef, DeletionPropagationTask } from "@firefly/contracts";

import { DeletionWorkerError, type DeletionTargetConsumer } from "./deletion-worker.ts";

export interface S3ObjectDeletionPort {
  deleteObject(input: { readonly bucket: string; readonly key: string }): Promise<void>;
}

export class AwsS3ObjectDeletionPort implements S3ObjectDeletionPort {
  private readonly client: S3Client;

  constructor(config: S3ClientConfig) {
    this.client = new S3Client(config);
  }

  async deleteObject(input: { readonly bucket: string; readonly key: string }): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: input.bucket, Key: input.key }));
  }

  destroy(): void {
    this.client.destroy();
  }
}

export class ObjectStoreDeletionConsumer implements DeletionTargetConsumer {
  readonly target = "object_store" as const;
  private readonly objects: S3ObjectDeletionPort;

  constructor(objects: S3ObjectDeletionPort) {
    this.objects = objects;
  }

  async delete(task: DeletionPropagationTask): Promise<readonly ArtifactRef[]> {
    const resources = task.resource_refs.filter((resource) => new URL(resource.uri).protocol === "s3:");
    if (resources.length === 0) {
      throw new DeletionWorkerError(
        "OBJECT_RESOURCE_MISSING",
        "Object-store deletion requires at least one s3:// resource reference",
        false,
      );
    }
    const seen = new Set<string>();
    for (const resource of resources) {
      const location = parseS3Uri(resource.uri);
      const identity = `${location.bucket}\n${location.key}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      await this.objects.deleteObject(location);
    }
    return resources;
  }
}

function parseS3Uri(uri: string): { readonly bucket: string; readonly key: string } {
  const parsed = new URL(uri);
  if (parsed.protocol !== "s3:" || !parsed.hostname || parsed.pathname.length < 2) {
    throw new DeletionWorkerError("INVALID_S3_URI", `Invalid object-store URI: ${uri}`, false);
  }
  return { bucket: parsed.hostname, key: decodeURIComponent(parsed.pathname.slice(1)) };
}
