import type {
  IndexSourceDocument,
  IndexSourceParserPort,
  IndexStructuredSource,
} from "./index-build-worker.ts";

export interface HttpIndexSourceParserOptions {
  readonly parser_id: string;
  readonly endpoint: string;
  readonly source_types: readonly string[];
  readonly timeout_ms?: number;
  readonly max_response_bytes?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly allow_insecure_localhost?: boolean;
  readonly fetch?: typeof globalThis.fetch;
}

export class HttpIndexSourceParserError extends Error {
  readonly code:
    | "INVALID_CONFIGURATION"
    | "REQUEST_FAILED"
    | "RESPONSE_TOO_LARGE"
    | "INVALID_RESPONSE";
  readonly retryable: boolean;

  constructor(code: HttpIndexSourceParserError["code"], message: string, retryable: boolean) {
    super(message);
    this.name = "HttpIndexSourceParserError";
    this.code = code;
    this.retryable = retryable;
  }
}

/** Fixed-endpoint adapter for local or remote structured parser services. */
export class HttpIndexSourceParser implements IndexSourceParserPort {
  readonly parser_id: string;
  private readonly endpoint: URL;
  private readonly sourceTypes: ReadonlySet<string>;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(options: HttpIndexSourceParserOptions) {
    this.parser_id = options.parser_id.trim();
    this.endpoint = parseEndpoint(options.endpoint, options.allow_insecure_localhost ?? false);
    this.sourceTypes = new Set(options.source_types.map(normalizeSourceType));
    this.timeoutMs = options.timeout_ms ?? 30_000;
    this.maxResponseBytes = options.max_response_bytes ?? 5_000_000;
    this.headers = validateHeaders(options.headers ?? {});
    this.fetcher = options.fetch ?? globalThis.fetch;
    if (!this.parser_id || this.sourceTypes.size === 0 || [...this.sourceTypes].some((type) => !type)) {
      throw configurationError("Parser ID and unique non-empty source types are required");
    }
    if (this.sourceTypes.size !== options.source_types.length) {
      throw configurationError("Parser source types must be unique");
    }
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 300_000) {
      throw configurationError("Parser timeout must be between 100 and 300000 milliseconds");
    }
    if (!Number.isInteger(this.maxResponseBytes) || this.maxResponseBytes < 1_024 || this.maxResponseBytes > 50_000_000) {
      throw configurationError("Parser response limit must be between 1024 and 50000000 bytes");
    }
  }

  supports(sourceType: string): boolean {
    return this.sourceTypes.has(normalizeSourceType(sourceType));
  }

  async parse(document: IndexSourceDocument): Promise<IndexStructuredSource> {
    if (!this.supports(document.source_type)) {
      throw new HttpIndexSourceParserError("INVALID_CONFIGURATION", "Parser does not support the source type", false);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Parser request timed out")), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...this.headers,
        },
        body: JSON.stringify({
          schema_version: 1,
          parser_id: this.parser_id,
          document: {
            memory_id: document.memory_id,
            source_type: document.source_type,
            content: document.content,
            entity_keys: document.entity_keys ?? [],
            citation: document.citation,
          },
        }),
      });
    } catch (error) {
      throw new HttpIndexSourceParserError(
        "REQUEST_FAILED",
        controller.signal.aborted ? "Parser request timed out" : safeErrorMessage(error),
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      throw new HttpIndexSourceParserError(
        "REQUEST_FAILED",
        `Parser returned HTTP ${response.status}`,
        response.status === 408 || response.status === 429 || response.status >= 500,
      );
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("application/json")) {
      throw new HttpIndexSourceParserError("INVALID_RESPONSE", "Parser response must be application/json", false);
    }
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > this.maxResponseBytes) {
      throw new HttpIndexSourceParserError("RESPONSE_TOO_LARGE", "Parser response exceeded the byte limit", false);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > this.maxResponseBytes) {
      throw new HttpIndexSourceParserError("RESPONSE_TOO_LARGE", "Parser response exceeded the byte limit", false);
    }
    let envelope: unknown;
    try {
      envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new HttpIndexSourceParserError("INVALID_RESPONSE", "Parser response is not valid UTF-8 JSON", false);
    }
    if (!isParserEnvelope(envelope)) {
      throw new HttpIndexSourceParserError("INVALID_RESPONSE", "Parser response envelope is invalid", false);
    }
    return envelope.structured;
  }
}

function parseEndpoint(raw: string, allowInsecureLocalhost: boolean): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw configurationError("Parser endpoint must be an absolute URL");
  }
  const local = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1" || endpoint.hostname === "::1";
  if (endpoint.protocol !== "https:" && !(allowInsecureLocalhost && local && endpoint.protocol === "http:")) {
    throw configurationError("Parser endpoint must use HTTPS; HTTP is allowed only for explicitly enabled localhost");
  }
  if (endpoint.username || endpoint.password || endpoint.hash) {
    throw configurationError("Parser endpoint cannot contain credentials or fragments");
  }
  return endpoint;
}

function validateHeaders(headers: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const forbidden = new Set(["accept", "content-type", "content-length", "host", "connection", "transfer-encoding"]);
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.trim().toLowerCase();
    if (!normalized || forbidden.has(normalized) || /[\r\n]/u.test(name) || /[\r\n]/u.test(value)) {
      throw configurationError(`Parser header is forbidden: ${name}`);
    }
    result[normalized] = value;
  }
  return result;
}

function isParserEnvelope(value: unknown): value is { readonly schema_version: 1; readonly structured: IndexStructuredSource } {
  if (!value || typeof value !== "object") return false;
  const envelope = value as { readonly schema_version?: unknown; readonly structured?: unknown };
  if (envelope.schema_version !== 1 || !envelope.structured || typeof envelope.structured !== "object") return false;
  const kind = (envelope.structured as { readonly kind?: unknown }).kind;
  return kind === "pdf-layout" || kind === "code-ast" || kind === "table" || kind === "conversation";
}

function normalizeSourceType(sourceType: string): string {
  return sourceType.trim().toLowerCase();
}

function configurationError(message: string): HttpIndexSourceParserError {
  return new HttpIndexSourceParserError("INVALID_CONFIGURATION", message, false);
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 2_048) : "Parser request failed";
}
