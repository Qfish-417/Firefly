import { DeleteObjectCommand, HeadObjectCommand, S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import type { ArtifactRef, DeletionPropagationTask } from "@firefly/contracts";

import { DeletionWorkerError, type DeletionTargetConsumer } from "./deletion-worker.ts";

export interface S3ObjectDeletionPort {
  deleteObject(input: { readonly bucket: string; readonly key: string }): Promise<void>;
  /** Resolves true only when the object is provably gone. */
  objectAbsent(input: { readonly bucket: string; readonly key: string }): Promise<boolean>;
}

/**
 * `@smithy/node-http-handler` defaults both timeouts to 0 (unlimited), so a black-holed endpoint
 * would block the worker past its Outbox lease and let a second worker claim the same event.
 */
export const defaultS3RequestHandler = {
  connection_timeout_ms: 3_000,
  request_timeout_ms: 30_000,
} as const;

export class AwsS3ObjectDeletionPort implements S3ObjectDeletionPort {
  private readonly client: S3Client;

  constructor(config: S3ClientConfig) {
    this.client = new S3Client({
      requestHandler: new NodeHttpHandler({
        connectionTimeout: defaultS3RequestHandler.connection_timeout_ms,
        requestTimeout: defaultS3RequestHandler.request_timeout_ms,
      }),
      ...config,
    });
  }

  async deleteObject(input: { readonly bucket: string; readonly key: string }): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: input.bucket, Key: input.key }));
  }

  async objectAbsent(input: { readonly bucket: string; readonly key: string }): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: input.bucket, Key: input.key }));
      return false;
    } catch (error) {
      if (isNotFound(error)) return true;
      throw error;
    }
  }

  destroy(): void {
    this.client.destroy();
  }
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    readonly name?: unknown;
    readonly $metadata?: { readonly httpStatusCode?: unknown };
  };
  return candidate.name === "NotFound" || candidate.name === "NoSuchKey"
    || candidate.$metadata?.httpStatusCode === 404;
}

export class ObjectStoreDeletionConsumer implements DeletionTargetConsumer {
  readonly target = "object_store" as const;
  private readonly objects: S3ObjectDeletionPort;

  constructor(objects: S3ObjectDeletionPort) {
    this.objects = objects;
  }

  async delete(task: DeletionPropagationTask): Promise<readonly ArtifactRef[]> {
    const resources = task.resource_refs.filter((resource) => isS3Uri(resource.uri));
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
      // S3 DeleteObject answers 204 for keys that never existed and only writes a delete marker on
      // versioned buckets, so the receipt is only trustworthy after the absence is confirmed.
      if (!(await this.objects.objectAbsent(location))) {
        throw new DeletionWorkerError(
          "OBJECT_STILL_PRESENT",
          `Object is still readable after deletion: s3://${location.bucket}/${location.key}`,
          true,
        );
      }
    }
    return resources;
  }
}

/** `resource_refs` is caller-provided JSON, so an unparsable URI must not throw a bare TypeError. */
function isS3Uri(uri: string): boolean {
  try {
    return new URL(uri).protocol === "s3:";
  } catch {
    return false;
  }
}

function parseS3Uri(uri: string): { readonly bucket: string; readonly key: string } {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new DeletionWorkerError("INVALID_S3_URI", `Invalid object-store URI: ${uri}`, false);
  }
  if (parsed.protocol !== "s3:" || !parsed.hostname || parsed.pathname.length < 2) {
    throw new DeletionWorkerError("INVALID_S3_URI", `Invalid object-store URI: ${uri}`, false);
  }
  // `new URL` normalises `..`, so a traversal in the raw URI could address a different key than the
  // artifact records. Deletion has no digest check to fall back on, so it is rejected outright.
  const rawPath = uri.slice(uri.indexOf(parsed.hostname) + parsed.hostname.length);
  if (/(^|\/)\.\.(\/|$)/u.test(rawPath) || /%2f/iu.test(rawPath) || rawPath.includes("//")) {
    throw new DeletionWorkerError("INVALID_S3_URI", `Object-store URI must not contain traversal: ${uri}`, false);
  }
  return { bucket: parsed.hostname, key: decodeURIComponent(parsed.pathname.slice(1)) };
}
