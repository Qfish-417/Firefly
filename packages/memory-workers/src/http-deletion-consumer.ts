import { assertContract, type ArtifactRef, type DeletionPropagationTarget, type DeletionPropagationTask } from "@firefly/contracts";

import { DeletionWorkerError, type DeletionTargetConsumer } from "./deletion-worker.ts";

export type HttpDeletionTarget = Exclude<DeletionPropagationTarget, "object_store">;

export interface HttpDeletionTargetConsumerOptions {
  readonly target: HttpDeletionTarget;
  readonly endpoint: string;
  readonly timeout_ms?: number;
  readonly max_response_bytes?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly allow_insecure_localhost?: boolean;
  readonly fetch?: typeof globalThis.fetch;
}

/** Fixed-endpoint deletion adapter for external indexes, caches and derived projections. */
export class HttpDeletionTargetConsumer implements DeletionTargetConsumer {
  readonly target: HttpDeletionTarget;
  private readonly endpoint: URL;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(options: HttpDeletionTargetConsumerOptions) {
    this.target = options.target;
    this.endpoint = parseEndpoint(options.endpoint, options.allow_insecure_localhost ?? false);
    this.timeoutMs = options.timeout_ms ?? 30_000;
    this.maxResponseBytes = options.max_response_bytes ?? 1_000_000;
    this.headers = validateHeaders(options.headers ?? {});
    this.fetcher = options.fetch ?? globalThis.fetch;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 300_000) {
      throw configurationError("Deletion timeout must be between 100 and 300000 milliseconds");
    }
    if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1_024 || this.maxResponseBytes > 10_000_000) {
      throw configurationError("Deletion response limit must be between 1024 and 10000000 bytes");
    }
  }

  async delete(task: DeletionPropagationTask): Promise<readonly ArtifactRef[]> {
    if (task.target !== this.target) {
      throw new DeletionWorkerError("DELETION_TARGET_MISMATCH", "HTTP deletion consumer received another target", false);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Deletion provider request timed out")), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: { accept: "application/json", "content-type": "application/json", ...this.headers },
        body: JSON.stringify({ schema_version: 1, deletion: task }),
      });
    } catch (error) {
      throw new DeletionWorkerError(
        controller.signal.aborted ? "DELETION_PROVIDER_TIMEOUT" : "DELETION_PROVIDER_REQUEST_FAILED",
        controller.signal.aborted ? "Deletion provider request timed out" : safeErrorMessage(error),
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      throw new DeletionWorkerError(
        "DELETION_PROVIDER_REJECTED",
        `Deletion provider returned HTTP ${response.status}`,
        response.status === 408 || response.status === 429 || response.status >= 500,
      );
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("application/json")) {
      throw new DeletionWorkerError("DELETION_PROVIDER_INVALID_RESPONSE", "Deletion provider response must be application/json", false);
    }
    const bytes = await boundedResponseBytes(response, this.maxResponseBytes);
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new DeletionWorkerError("DELETION_PROVIDER_INVALID_RESPONSE", "Deletion provider returned invalid UTF-8 JSON", false); }
    const evidence = parseReceipt(value, task);
    return evidence;
  }
}

async function boundedResponseBytes(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maximum) {
    throw new DeletionWorkerError("DELETION_PROVIDER_RESPONSE_TOO_LARGE", "Deletion provider response exceeded the byte limit", false);
  }
  // `content-length` is advisory: a chunked response bypasses the check above entirely, so the cap
  // is enforced while streaming instead of after the body is already buffered.
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new DeletionWorkerError("DELETION_PROVIDER_RESPONSE_TOO_LARGE", "Deletion provider response exceeded the byte limit", false);
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseReceipt(value: unknown, task: DeletionPropagationTask): readonly ArtifactRef[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidReceipt();
  const receipt = value as Record<string, unknown>;
  if (
    receipt.schema_version !== 1 || receipt.deletion_id !== task.deletion_id ||
    receipt.target !== task.target || receipt.content_digest !== task.content_digest ||
    receipt.status !== "completed" || !Array.isArray(receipt.evidence_refs) ||
    receipt.evidence_refs.length === 0
  ) throw invalidReceipt();
  try {
    for (const artifact of receipt.evidence_refs) assertContract("ArtifactRef", artifact);
  } catch {
    throw invalidReceipt();
  }
  const evidence = receipt.evidence_refs as ArtifactRef[];
  if (new Set(evidence.map((artifact) => artifact.artifact_id)).size !== evidence.length) throw invalidReceipt();
  if (evidence.some((artifact) =>
    artifact.media_type !== "application/vnd.firefly.deletion-receipt+json" ||
    artifact.scope !== "tenant" || artifact.owner_id !== task.tenant_id
  )) throw invalidReceipt();
  return evidence;
}

function invalidReceipt(): DeletionWorkerError {
  return new DeletionWorkerError("DELETION_PROVIDER_INVALID_RESPONSE", "Deletion provider receipt is invalid or does not match the task", false);
}

function parseEndpoint(raw: string, allowInsecureLocalhost: boolean): URL {
  let endpoint: URL;
  try { endpoint = new URL(raw); }
  catch { throw configurationError("Deletion provider endpoint must be an absolute URL"); }
  const local = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1" || endpoint.hostname === "::1";
  if (endpoint.protocol !== "https:" && !(allowInsecureLocalhost && local && endpoint.protocol === "http:")) {
    throw configurationError("Deletion provider endpoint must use HTTPS; HTTP requires explicit localhost mode");
  }
  if (endpoint.username || endpoint.password || endpoint.hash) throw configurationError("Deletion provider endpoint cannot contain credentials or fragments");
  return endpoint;
}

function validateHeaders(headers: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const forbidden = new Set(["accept", "content-type", "content-length", "host", "connection", "transfer-encoding"]);
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.trim().toLowerCase();
    if (!normalized || forbidden.has(normalized) || /[\r\n]/u.test(name) || /[\r\n]/u.test(value)) {
      throw configurationError(`Deletion provider header is forbidden: ${name}`);
    }
    result[normalized] = value;
  }
  return result;
}

function configurationError(message: string): DeletionWorkerError {
  return new DeletionWorkerError("DELETION_PROVIDER_INVALID_CONFIGURATION", message, false);
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 2_048) : "Deletion provider request failed";
}
