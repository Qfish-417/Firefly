import { createHash } from "node:crypto";

import { GetObjectCommand, S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";

import type { IndexBuildTask } from "@firefly/contracts";

import { IndexBuildWorkerError, type IndexSourceDocument, type IndexSourcePort } from "./index-build-worker.ts";

export interface BinaryObjectReadInput {
  readonly bucket: string;
  readonly key: string;
  readonly max_bytes: number;
}

export interface BinaryObjectReadPort {
  readObject(input: BinaryObjectReadInput): Promise<Uint8Array>;
}

export class AwsS3ObjectReadPort implements BinaryObjectReadPort {
  private readonly client: S3Client;

  constructor(config: S3ClientConfig) {
    this.client = new S3Client(config);
  }

  async readObject(input: BinaryObjectReadInput): Promise<Uint8Array> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: input.bucket, Key: input.key }));
    if (response.ContentLength !== undefined && response.ContentLength > input.max_bytes) {
      throw new IndexBuildWorkerError("BINARY_SOURCE_TOO_LARGE", "Object exceeds the configured byte limit", false);
    }
    if (!response.Body || !isAsyncIterable(response.Body)) {
      throw new IndexBuildWorkerError("BINARY_SOURCE_MISSING", "Object store returned no readable body", true);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of response.Body) {
      const bytes = toBytes(chunk);
      total += bytes.byteLength;
      if (total > input.max_bytes) {
        throw new IndexBuildWorkerError("BINARY_SOURCE_TOO_LARGE", "Object exceeds the configured byte limit", false);
      }
      chunks.push(bytes);
    }
    if (total === 0) throw new IndexBuildWorkerError("BINARY_SOURCE_EMPTY", "Object store returned an empty body", false);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }

  destroy(): void {
    this.client.destroy();
  }
}

export interface BinaryContentHydratingIndexSourceOptions {
  readonly source_types: readonly string[];
  readonly max_object_bytes?: number;
}

/** Loads immutable s3:// artifacts into bounded bytes and verifies their Citation digest. */
export class BinaryContentHydratingIndexSourcePort implements IndexSourcePort {
  private readonly source: IndexSourcePort;
  private readonly objects: BinaryObjectReadPort;
  private readonly sourceTypes: ReadonlySet<string>;
  private readonly maxObjectBytes: number;

  constructor(source: IndexSourcePort, objects: BinaryObjectReadPort, options: BinaryContentHydratingIndexSourceOptions) {
    const sourceTypes = options.source_types.map(normalizeSourceType);
    this.source = source;
    this.objects = objects;
    this.sourceTypes = new Set(sourceTypes);
    this.maxObjectBytes = options.max_object_bytes ?? 50_000_000;
    if (this.sourceTypes.size === 0 || this.sourceTypes.size !== sourceTypes.length || sourceTypes.some((type) => !type)) {
      throw new TypeError("Binary source types must be non-empty and unique");
    }
    if (!Number.isInteger(this.maxObjectBytes) || this.maxObjectBytes < 1_024 || this.maxObjectBytes > 500_000_000) {
      throw new TypeError("Binary object limit must be between 1024 and 500000000 bytes");
    }
  }

  async load(task: IndexBuildTask): Promise<readonly IndexSourceDocument[]> {
    const documents = await this.source.load(task);
    return Promise.all(documents.map((document) => this.hydrate(document)));
  }

  private async hydrate(document: IndexSourceDocument): Promise<IndexSourceDocument> {
    if (!this.sourceTypes.has(normalizeSourceType(document.source_type))) return document;
    const bytes = document.content_bytes ?? await this.objects.readObject({
      ...parseS3Uri(document.citation.uri),
      max_bytes: this.maxObjectBytes,
    });
    if (bytes.byteLength === 0) throw new IndexBuildWorkerError("BINARY_SOURCE_EMPTY", "Binary source is empty", false);
    if (bytes.byteLength > this.maxObjectBytes) {
      throw new IndexBuildWorkerError("BINARY_SOURCE_TOO_LARGE", "Binary source exceeds the configured byte limit", false);
    }
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (digest !== document.citation.digest) {
      throw new IndexBuildWorkerError("BINARY_SOURCE_DIGEST_MISMATCH", "Binary source does not match its Citation digest", false);
    }
    return { ...document, content_bytes: bytes };
  }
}

function parseS3Uri(uri: string): { readonly bucket: string; readonly key: string } {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new IndexBuildWorkerError("INVALID_BINARY_SOURCE_URI", "Binary source URI must be an absolute s3:// URI", false);
  }
  if (parsed.protocol !== "s3:" || !parsed.hostname || parsed.pathname.length < 2 || parsed.search || parsed.hash) {
    throw new IndexBuildWorkerError("INVALID_BINARY_SOURCE_URI", "Binary source URI must be an absolute s3:// URI", false);
  }
  return { bucket: parsed.hostname, key: decodeURIComponent(parsed.pathname.slice(1)) };
}

function normalizeSourceType(value: string): string {
  return value.trim().toLowerCase();
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return !!value && typeof (value as { readonly [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function";
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new IndexBuildWorkerError("BINARY_SOURCE_INVALID_CHUNK", "Object store returned a non-binary chunk", true);
}
