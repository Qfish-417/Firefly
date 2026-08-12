import { createHash } from "node:crypto";

import type {
  IndexPdfLayoutBlock,
  IndexPdfLayoutSource,
  IndexSourceDocument,
  IndexSourceParserPort,
} from "./index-build-worker.ts";
import { PdfJsLayoutParserError } from "./pdf-js-layout-parser.ts";

const defaultSourceTypes = ["application/pdf", "image/png", "image/jpeg", "image/tiff"] as const;
const blockKinds = new Set<IndexPdfLayoutBlock["kind"]>([
  "heading", "paragraph", "list", "table", "figure", "caption",
]);

export interface HttpOcrLayoutParserOptions {
  readonly parser_id?: string;
  readonly endpoint: string;
  readonly source_types?: readonly string[];
  readonly timeout_ms?: number;
  readonly max_source_bytes?: number;
  readonly max_response_bytes?: number;
  readonly max_pages?: number;
  readonly max_blocks?: number;
  readonly max_text_characters?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly allow_insecure_localhost?: boolean;
  readonly fetch?: typeof globalThis.fetch;
}

export class HttpOcrLayoutParserError extends Error {
  readonly code:
    | "INVALID_CONFIGURATION"
    | "BINARY_SOURCE_MISSING"
    | "SOURCE_TOO_LARGE"
    | "DIGEST_MISMATCH"
    | "REQUEST_FAILED"
    | "RESPONSE_TOO_LARGE"
    | "INVALID_RESPONSE"
    | "NO_EXTRACTABLE_TEXT";
  readonly retryable: boolean;

  constructor(code: HttpOcrLayoutParserError["code"], message: string, retryable: boolean) {
    super(message);
    this.name = "HttpOcrLayoutParserError";
    this.code = code;
    this.retryable = retryable;
  }
}

/** Sends verified binary artifacts to a fixed OCR gateway and validates its versioned layout response. */
export class HttpOcrLayoutParser implements IndexSourceParserPort {
  readonly parser_id: string;
  private readonly endpoint: URL;
  private readonly sourceTypes: ReadonlySet<string>;
  private readonly timeoutMs: number;
  private readonly maxSourceBytes: number;
  private readonly maxResponseBytes: number;
  private readonly maxPages: number;
  private readonly maxBlocks: number;
  private readonly maxTextCharacters: number;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(options: HttpOcrLayoutParserOptions) {
    this.parser_id = options.parser_id?.trim() || "http-ocr-layout";
    this.endpoint = parseEndpoint(options.endpoint, options.allow_insecure_localhost ?? false);
    const sourceTypes = (options.source_types ?? defaultSourceTypes).map(normalizeSourceType);
    this.sourceTypes = new Set(sourceTypes);
    this.timeoutMs = options.timeout_ms ?? 120_000;
    this.maxSourceBytes = options.max_source_bytes ?? 50_000_000;
    this.maxResponseBytes = options.max_response_bytes ?? 20_000_000;
    this.maxPages = options.max_pages ?? 2_000;
    this.maxBlocks = options.max_blocks ?? 1_000_000;
    this.maxTextCharacters = options.max_text_characters ?? 20_000_000;
    this.headers = validateHeaders(options.headers ?? {});
    this.fetcher = options.fetch ?? globalThis.fetch;
    if (!this.parser_id || this.sourceTypes.size === 0 || this.sourceTypes.size !== sourceTypes.length || sourceTypes.some((type) => !type)) {
      throw configurationError("OCR parser ID and source types must be non-empty and unique");
    }
    validateInteger(this.timeoutMs, 100, 300_000, "timeout milliseconds");
    validateInteger(this.maxSourceBytes, 1_024, 500_000_000, "source byte limit");
    validateInteger(this.maxResponseBytes, 1_024, 100_000_000, "response byte limit");
    validateInteger(this.maxPages, 1, 100_000, "page limit");
    validateInteger(this.maxBlocks, 1, 5_000_000, "block limit");
    validateInteger(this.maxTextCharacters, 1, 100_000_000, "text character limit");
  }

  supports(sourceType: string): boolean {
    return this.sourceTypes.has(normalizeSourceType(sourceType));
  }

  async parse(document: IndexSourceDocument): Promise<IndexPdfLayoutSource> {
    if (!this.supports(document.source_type)) throw configurationError(`Unsupported OCR source type: ${document.source_type}`);
    const bytes = document.content_bytes;
    if (!bytes?.byteLength) {
      throw new HttpOcrLayoutParserError("BINARY_SOURCE_MISSING", "OCR parser requires hydrated binary source bytes", false);
    }
    if (bytes.byteLength > this.maxSourceBytes) {
      throw new HttpOcrLayoutParserError("SOURCE_TOO_LARGE", "OCR source exceeds the configured byte limit", false);
    }
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (digest !== document.citation.digest) {
      throw new HttpOcrLayoutParserError("DIGEST_MISMATCH", "OCR source does not match its Citation digest", false);
    }

    const metadata = {
      schema_version: 1,
      parser_id: this.parser_id,
      output_contract: "firefly.ocr-layout.v1",
      document: {
        memory_id: document.memory_id,
        source_type: document.source_type,
        entity_keys: document.entity_keys ?? [],
        citation: document.citation,
      },
    } as const;
    const form = new FormData();
    form.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata.json");
    form.set("document", new Blob([bytes.slice()], { type: document.source_type }), "source.bin");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("OCR request timed out")), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: { accept: "application/json", ...this.headers },
        body: form,
      });
    } catch (error) {
      throw new HttpOcrLayoutParserError(
        "REQUEST_FAILED",
        controller.signal.aborted ? "OCR request timed out" : safeErrorMessage(error),
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      throw new HttpOcrLayoutParserError(
        "REQUEST_FAILED",
        `OCR provider returned HTTP ${response.status}`,
        response.status === 408 || response.status === 429 || response.status >= 500,
      );
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("application/json")) {
      throw new HttpOcrLayoutParserError("INVALID_RESPONSE", "OCR response must be application/json", false);
    }
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > this.maxResponseBytes) {
      throw new HttpOcrLayoutParserError("RESPONSE_TOO_LARGE", "OCR response exceeded the byte limit", false);
    }
    const responseBytes = await readBoundedBody(response, this.maxResponseBytes);
    let envelope: unknown;
    try {
      envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(responseBytes));
    } catch {
      throw new HttpOcrLayoutParserError("INVALID_RESPONSE", "OCR response is not valid UTF-8 JSON", false);
    }
    return validateEnvelope(envelope, document.citation.digest, {
      max_pages: this.maxPages,
      max_blocks: this.maxBlocks,
      max_text_characters: this.maxTextCharacters,
    });
  }
}

export interface PdfTextOrOcrParserOptions {
  readonly parser_id?: string;
  readonly native: IndexSourceParserPort;
  readonly ocr: IndexSourceParserPort;
}

/** Explicitly falls back to OCR only when PDF.js proves that the document has no extractable text. */
export class PdfTextOrOcrParser implements IndexSourceParserPort {
  readonly parser_id: string;
  private readonly native: IndexSourceParserPort;
  private readonly ocr: IndexSourceParserPort;

  constructor(options: PdfTextOrOcrParserOptions) {
    this.parser_id = options.parser_id?.trim() || "pdf-text-or-ocr";
    this.native = options.native;
    this.ocr = options.ocr;
    if (!this.parser_id || !this.native.supports("application/pdf") || !this.ocr.supports("application/pdf")) {
      throw configurationError("PDF text/OCR parser requires a non-empty ID and two PDF-capable parsers");
    }
  }

  supports(sourceType: string): boolean {
    return normalizeSourceType(sourceType) === "application/pdf";
  }

  async parse(document: IndexSourceDocument): Promise<IndexPdfLayoutSource> {
    try {
      const result = await this.native.parse(document);
      if (result.kind !== "pdf-layout") throw configurationError("Native PDF parser returned a non-layout source");
      return result;
    } catch (error) {
      if (!(error instanceof PdfJsLayoutParserError) || error.code !== "NO_EXTRACTABLE_TEXT") throw error;
      const result = await this.ocr.parse(document);
      if (result.kind !== "pdf-layout") throw configurationError("OCR parser returned a non-layout source");
      return result;
    }
  }
}

interface OcrLimits {
  readonly max_pages: number;
  readonly max_blocks: number;
  readonly max_text_characters: number;
}

function validateEnvelope(value: unknown, expectedDigest: string, limits: OcrLimits): IndexPdfLayoutSource {
  if (!isRecord(value) || value.schema_version !== 1 || value.contract !== "firefly.ocr-layout.v1" ||
    value.document_digest !== expectedDigest ||
    !isRecord(value.provider) || !Array.isArray(value.pages)) {
    throw invalidResponse("OCR response envelope or document digest is invalid");
  }
  const providerId = requiredString(value.provider.provider_id, 200, "provider ID");
  const modelId = optionalString(value.provider.model_id, 200, "model ID");
  const modelVersion = optionalString(value.provider.model_version, 200, "model version");
  if (value.pages.length === 0) throw new HttpOcrLayoutParserError("NO_EXTRACTABLE_TEXT", "OCR response contains no pages", false);
  if (value.pages.length > limits.max_pages) throw invalidResponse("OCR response exceeds the page limit");

  let blockCount = 0;
  let characterCount = 0;
  const pages = value.pages.map((rawPage, pageIndex) => {
    if (!isRecord(rawPage) || !Number.isInteger(rawPage.page) || (rawPage.page as number) < 1 ||
      typeof rawPage.width !== "number" || !Number.isFinite(rawPage.width) || rawPage.width <= 0 ||
      typeof rawPage.height !== "number" || !Number.isFinite(rawPage.height) || rawPage.height <= 0 ||
      rawPage.coordinate_unit !== "pixel" || !Array.isArray(rawPage.blocks)) {
      throw invalidResponse(`OCR page ${pageIndex + 1} is invalid`);
    }
    const pageNumber = rawPage.page as number;
    if (pageNumber !== pageIndex + 1) throw invalidResponse("OCR page numbers must be contiguous and ordered from 1");
    const width = rawPage.width;
    const height = rawPage.height;
    const regionIds = new Set<string>();
    const blocks = rawPage.blocks.map((rawBlock, blockIndex) => {
      if (!isRecord(rawBlock) || typeof rawBlock.kind !== "string" ||
        !blockKinds.has(rawBlock.kind as IndexPdfLayoutBlock["kind"])) {
        throw invalidResponse(`OCR block ${blockIndex + 1} on page ${pageNumber} has an invalid kind`);
      }
      const text = requiredString(rawBlock.text, 1_000_000, "block text");
      if (rawBlock.sequence !== blockIndex + 1) {
        throw invalidResponse(`OCR block sequence must be contiguous and ordered within page ${pageNumber}`);
      }
      const regionId = requiredString(rawBlock.region_id, 300, "region ID");
      if (regionIds.has(regionId)) throw invalidResponse(`OCR region IDs must be unique within page ${pageNumber}`);
      regionIds.add(regionId);
      if (!Array.isArray(rawBlock.bbox) || rawBlock.bbox.length !== 4 ||
        !rawBlock.bbox.every((part) => typeof part === "number" && Number.isFinite(part))) {
        throw invalidResponse(`OCR block ${regionId} has an invalid bbox`);
      }
      const [x, y, boxWidth, boxHeight] = rawBlock.bbox as [number, number, number, number];
      if (x < 0 || y < 0 || boxWidth <= 0 || boxHeight <= 0 || x + boxWidth > width || y + boxHeight > height) {
        throw invalidResponse(`OCR block ${regionId} bbox falls outside the page`);
      }
      if (typeof rawBlock.confidence !== "number" || !Number.isFinite(rawBlock.confidence) ||
        rawBlock.confidence < 0 || rawBlock.confidence > 1) {
        throw invalidResponse(`OCR block ${regionId} has an invalid confidence`);
      }
      const language = optionalString(rawBlock.language, 100, "block language");
      const headingLevel = rawBlock.heading_level;
      if (headingLevel !== undefined && (!Number.isInteger(headingLevel) || (headingLevel as number) < 1 || (headingLevel as number) > 6)) {
        throw invalidResponse(`OCR block ${regionId} has an invalid heading level`);
      }
      blockCount += 1;
      characterCount += text.length;
      if (blockCount > limits.max_blocks || characterCount > limits.max_text_characters) {
        throw invalidResponse("OCR response exceeds the block or text limit");
      }
      return {
        kind: rawBlock.kind as IndexPdfLayoutBlock["kind"],
        text,
        bbox: [x, y, boxWidth, boxHeight] as const,
        region_id: regionId,
        confidence: rawBlock.confidence,
        ...(language ? { language } : {}),
        ...(headingLevel === undefined ? {} : { heading_level: headingLevel as number }),
      };
    });
    return { page: pageNumber, width, height, coordinate_unit: "pixel" as const, blocks };
  });
  if (blockCount === 0 || characterCount === 0) {
    throw new HttpOcrLayoutParserError("NO_EXTRACTABLE_TEXT", "OCR response contains no extractable text", false);
  }
  return {
    kind: "pdf-layout",
    pages,
    extraction: {
      method: "ocr",
      provider_id: providerId,
      ...(modelId ? { model_id: modelId } : {}),
      ...(modelVersion ? { model_version: modelVersion } : {}),
    },
  };
}

async function readBoundedBody(response: Response, maximum: number): Promise<Uint8Array> {
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
        throw new HttpOcrLayoutParserError("RESPONSE_TOO_LARGE", "OCR response exceeded the byte limit", false);
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function parseEndpoint(raw: string, allowInsecureLocalhost: boolean): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw configurationError("OCR endpoint must be an absolute URL");
  }
  const local = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1" || endpoint.hostname === "::1";
  if (endpoint.protocol !== "https:" && !(allowInsecureLocalhost && local && endpoint.protocol === "http:")) {
    throw configurationError("OCR endpoint must use HTTPS; HTTP is allowed only for explicitly enabled localhost");
  }
  if (endpoint.username || endpoint.password || endpoint.hash) {
    throw configurationError("OCR endpoint cannot contain credentials or fragments");
  }
  return endpoint;
}

function validateHeaders(headers: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const forbidden = new Set(["accept", "content-type", "content-length", "host", "connection", "transfer-encoding"]);
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.trim().toLowerCase();
    if (!normalized || forbidden.has(normalized) || /[\r\n]/u.test(name) || /[\r\n]/u.test(value)) {
      throw configurationError(`OCR header is forbidden: ${name}`);
    }
    result[normalized] = value;
  }
  return result;
}

function requiredString(value: unknown, maximum: number, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw invalidResponse(`OCR ${label} is invalid`);
  return value.trim();
}

function optionalString(value: unknown, maximum: number, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, maximum, label);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeSourceType(value: string): string {
  return value.trim().toLowerCase();
}

function validateInteger(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw configurationError(`OCR parser ${label} must be between ${minimum} and ${maximum}`);
  }
}

function invalidResponse(message: string): HttpOcrLayoutParserError {
  return new HttpOcrLayoutParserError("INVALID_RESPONSE", message, false);
}

function configurationError(message: string): HttpOcrLayoutParserError {
  return new HttpOcrLayoutParserError("INVALID_CONFIGURATION", message, false);
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 2_048) : "OCR request failed";
}
