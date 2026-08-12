import { createHash } from "node:crypto";

import type {
  IndexConversationSource,
  IndexConversationTurn,
  IndexSourceDocument,
  IndexSourceParserPort,
} from "./index-build-worker.ts";

const defaultSourceTypes = [
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
] as const;

export interface HttpAsrDiarizationParserOptions {
  readonly parser_id?: string;
  readonly endpoint: string;
  readonly source_types?: readonly string[];
  readonly timeout_ms?: number;
  readonly max_source_bytes?: number;
  readonly max_response_bytes?: number;
  readonly max_duration_ms?: number;
  readonly max_turns?: number;
  readonly max_speakers?: number;
  readonly max_text_characters?: number;
  readonly max_turn_characters?: number;
  readonly max_identity_characters?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly allow_insecure_localhost?: boolean;
  readonly fetch?: typeof globalThis.fetch;
}

export class HttpAsrDiarizationParserError extends Error {
  readonly code:
    | "INVALID_CONFIGURATION"
    | "BINARY_SOURCE_MISSING"
    | "SOURCE_TOO_LARGE"
    | "DIGEST_MISMATCH"
    | "REQUEST_FAILED"
    | "RESPONSE_TOO_LARGE"
    | "INVALID_RESPONSE"
    | "NO_EXTRACTABLE_SPEECH";
  readonly retryable: boolean;

  constructor(code: HttpAsrDiarizationParserError["code"], message: string, retryable: boolean) {
    super(message);
    this.name = "HttpAsrDiarizationParserError";
    this.code = code;
    this.retryable = retryable;
  }
}

/** Sends verified audio to a fixed ASR/diarization gateway and validates canonical timed turns. */
export class HttpAsrDiarizationParser implements IndexSourceParserPort {
  readonly parser_id: string;
  private readonly endpoint: URL;
  private readonly sourceTypes: ReadonlySet<string>;
  private readonly timeoutMs: number;
  private readonly maxSourceBytes: number;
  private readonly maxResponseBytes: number;
  private readonly maxDurationMs: number;
  private readonly maxTurns: number;
  private readonly maxSpeakers: number;
  private readonly maxTextCharacters: number;
  private readonly maxTurnCharacters: number;
  private readonly maxIdentityCharacters: number;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(options: HttpAsrDiarizationParserOptions) {
    this.parser_id = options.parser_id?.trim() || "http-asr-diarization";
    this.endpoint = parseEndpoint(options.endpoint, options.allow_insecure_localhost ?? false);
    const sourceTypes = (options.source_types ?? defaultSourceTypes).map(normalizeSourceType);
    this.sourceTypes = new Set(sourceTypes);
    this.timeoutMs = options.timeout_ms ?? 300_000;
    this.maxSourceBytes = options.max_source_bytes ?? 100_000_000;
    this.maxResponseBytes = options.max_response_bytes ?? 20_000_000;
    this.maxDurationMs = options.max_duration_ms ?? 14_400_000;
    this.maxTurns = options.max_turns ?? 100_000;
    this.maxSpeakers = options.max_speakers ?? 1_000;
    this.maxTextCharacters = options.max_text_characters ?? 20_000_000;
    this.maxTurnCharacters = options.max_turn_characters ?? 100_000;
    this.maxIdentityCharacters = options.max_identity_characters ?? 256;
    this.headers = validateHeaders(options.headers ?? {});
    this.fetcher = options.fetch ?? globalThis.fetch;
    if (!this.parser_id || this.sourceTypes.size === 0 || this.sourceTypes.size !== sourceTypes.length || sourceTypes.some((type) => !type)) {
      throw configurationError("ASR parser ID and source types must be non-empty and unique");
    }
    validateInteger(this.timeoutMs, 100, 900_000, "timeout milliseconds");
    validateInteger(this.maxSourceBytes, 1_024, 1_000_000_000, "source byte limit");
    validateInteger(this.maxResponseBytes, 1_024, 100_000_000, "response byte limit");
    validateInteger(this.maxDurationMs, 1, 86_400_000, "duration limit");
    validateInteger(this.maxTurns, 1, 1_000_000, "turn limit");
    validateInteger(this.maxSpeakers, 1, 100_000, "speaker limit");
    validateInteger(this.maxTextCharacters, 1, 100_000_000, "text character limit");
    validateInteger(this.maxTurnCharacters, 1, 5_000_000, "turn character limit");
    validateInteger(this.maxIdentityCharacters, 1, 1_024, "identity character limit");
  }

  supports(sourceType: string): boolean {
    return this.sourceTypes.has(normalizeSourceType(sourceType));
  }

  async parse(document: IndexSourceDocument): Promise<IndexConversationSource> {
    if (!this.supports(document.source_type)) throw configurationError(`Unsupported ASR source type: ${document.source_type}`);
    const bytes = document.content_bytes;
    if (!bytes?.byteLength) {
      throw new HttpAsrDiarizationParserError("BINARY_SOURCE_MISSING", "ASR parser requires hydrated binary source bytes", false);
    }
    if (bytes.byteLength > this.maxSourceBytes) {
      throw new HttpAsrDiarizationParserError("SOURCE_TOO_LARGE", "Audio source exceeds the configured byte limit", false);
    }
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (digest !== document.citation.digest) {
      throw new HttpAsrDiarizationParserError("DIGEST_MISMATCH", "Audio source does not match its Citation digest", false);
    }

    const metadata = {
      schema_version: 1,
      parser_id: this.parser_id,
      output_contract: "firefly.asr-diarization.v1",
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
    const timeout = setTimeout(() => controller.abort(new Error("ASR request timed out")), this.timeoutMs);
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
      throw new HttpAsrDiarizationParserError(
        "REQUEST_FAILED",
        controller.signal.aborted ? "ASR request timed out" : safeErrorMessage(error),
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      throw new HttpAsrDiarizationParserError(
        "REQUEST_FAILED",
        `ASR provider returned HTTP ${response.status}`,
        response.status === 408 || response.status === 429 || response.status >= 500,
      );
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("application/json")) {
      throw new HttpAsrDiarizationParserError("INVALID_RESPONSE", "ASR response must be application/json", false);
    }
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > this.maxResponseBytes) {
      throw new HttpAsrDiarizationParserError("RESPONSE_TOO_LARGE", "ASR response exceeded the byte limit", false);
    }
    const responseBytes = await readBoundedBody(response, this.maxResponseBytes);
    let envelope: unknown;
    try {
      envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(responseBytes));
    } catch {
      throw new HttpAsrDiarizationParserError("INVALID_RESPONSE", "ASR response is not valid UTF-8 JSON", false);
    }
    return validateEnvelope(envelope, document.citation.digest, {
      max_duration_ms: this.maxDurationMs,
      max_turns: this.maxTurns,
      max_speakers: this.maxSpeakers,
      max_text_characters: this.maxTextCharacters,
      max_turn_characters: this.maxTurnCharacters,
      max_identity_characters: this.maxIdentityCharacters,
    });
  }
}

interface AsrLimits {
  readonly max_duration_ms: number;
  readonly max_turns: number;
  readonly max_speakers: number;
  readonly max_text_characters: number;
  readonly max_turn_characters: number;
  readonly max_identity_characters: number;
}

function validateEnvelope(value: unknown, expectedDigest: string, limits: AsrLimits): IndexConversationSource {
  if (!isRecord(value) || value.schema_version !== 1 || value.contract !== "firefly.asr-diarization.v1" ||
    value.document_digest !== expectedDigest || !isRecord(value.provider) || !isRecord(value.diarization) ||
    !Array.isArray(value.turns)) {
    throw invalidResponse("ASR response envelope or document digest is invalid");
  }
  const providerId = requiredString(value.provider.provider_id, 200, "provider ID");
  const modelId = optionalString(value.provider.model_id, 200, "model ID");
  const modelVersion = optionalString(value.provider.model_version, 200, "model version");
  if (typeof value.diarization.enabled !== "boolean") throw invalidResponse("ASR diarization state is invalid");
  if (!Number.isSafeInteger(value.duration_ms) || (value.duration_ms as number) < 1 ||
    (value.duration_ms as number) > limits.max_duration_ms) {
    throw invalidResponse("ASR duration is invalid or exceeds the configured limit");
  }
  const durationMs = value.duration_ms as number;
  const sourceLanguage = optionalString(value.language, 100, "source language");
  if (value.turns.length === 0) {
    throw new HttpAsrDiarizationParserError("NO_EXTRACTABLE_SPEECH", "ASR response contains no speech turns", false);
  }
  if (value.turns.length > limits.max_turns) throw invalidResponse("ASR response exceeds the turn limit");

  const turnIds = new Set<string>();
  const speakers = new Set<string>();
  let previousStart = -1;
  let totalCharacters = 0;
  const turns = value.turns.map((rawTurn, index): IndexConversationTurn => {
    if (!isRecord(rawTurn) || rawTurn.sequence !== index + 1) {
      throw invalidResponse("ASR turn sequence must be contiguous and ordered from 1");
    }
    const turnId = requiredString(rawTurn.turn_id, limits.max_identity_characters, "turn ID");
    const speakerId = requiredString(rawTurn.speaker_id, limits.max_identity_characters, "speaker ID");
    if (turnIds.has(turnId)) throw invalidResponse("ASR turn IDs must be unique");
    turnIds.add(turnId);
    speakers.add(speakerId);
    if (speakers.size > limits.max_speakers) throw invalidResponse("ASR response exceeds the speaker limit");
    const content = requiredString(rawTurn.content, limits.max_turn_characters, "turn content", false);
    totalCharacters += content.length;
    if (totalCharacters > limits.max_text_characters) throw invalidResponse("ASR response exceeds the text limit");
    if (!Number.isSafeInteger(rawTurn.start_ms) || !Number.isSafeInteger(rawTurn.end_ms) ||
      (rawTurn.start_ms as number) < 0 || (rawTurn.end_ms as number) <= (rawTurn.start_ms as number) ||
      (rawTurn.end_ms as number) > durationMs || (rawTurn.start_ms as number) < previousStart) {
      throw invalidResponse(`ASR turn ${index + 1} has invalid or unstable media offsets`);
    }
    previousStart = rawTurn.start_ms as number;
    if (typeof rawTurn.confidence !== "number" || !Number.isFinite(rawTurn.confidence) ||
      rawTurn.confidence < 0 || rawTurn.confidence > 1) {
      throw invalidResponse(`ASR turn ${index + 1} has invalid confidence`);
    }
    const language = optionalString(rawTurn.language, 100, "turn language");
    return {
      turn_id: turnId,
      sequence: index + 1,
      speaker_id: speakerId,
      content,
      start_ms: rawTurn.start_ms as number,
      end_ms: rawTurn.end_ms as number,
      confidence: rawTurn.confidence,
      ...(language ? { language } : {}),
    };
  });
  if (!value.diarization.enabled && speakers.size > 1) {
    throw invalidResponse("ASR response cannot expose multiple speakers when diarization is disabled");
  }

  return {
    kind: "conversation",
    turns,
    duration_ms: durationMs,
    ...(sourceLanguage ? { language: sourceLanguage } : {}),
    extraction: {
      method: "asr",
      provider_id: providerId,
      diarization: value.diarization.enabled,
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
        throw new HttpAsrDiarizationParserError("RESPONSE_TOO_LARGE", "ASR response exceeded the byte limit", false);
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
    throw configurationError("ASR endpoint must be an absolute URL");
  }
  const local = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1" || endpoint.hostname === "::1";
  if (endpoint.protocol !== "https:" && !(allowInsecureLocalhost && local && endpoint.protocol === "http:")) {
    throw configurationError("ASR endpoint must use HTTPS; HTTP is allowed only for explicitly enabled localhost");
  }
  if (endpoint.username || endpoint.password || endpoint.hash) {
    throw configurationError("ASR endpoint cannot contain credentials or fragments");
  }
  return endpoint;
}

function validateHeaders(headers: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const forbidden = new Set(["accept", "content-type", "content-length", "host", "connection", "transfer-encoding"]);
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.trim().toLowerCase();
    if (!normalized || forbidden.has(normalized) || /[\r\n]/u.test(name) || /[\r\n]/u.test(value)) {
      throw configurationError(`ASR header is forbidden: ${name}`);
    }
    result[normalized] = value;
  }
  return result;
}

function requiredString(value: unknown, maximum: number, label: string, trim = true): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw invalidResponse(`ASR ${label} is invalid`);
  return trim ? value.trim() : value;
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
    throw configurationError(`ASR parser ${label} must be between ${minimum} and ${maximum}`);
  }
}

function invalidResponse(message: string): HttpAsrDiarizationParserError {
  return new HttpAsrDiarizationParserError("INVALID_RESPONSE", message, false);
}

function configurationError(message: string): HttpAsrDiarizationParserError {
  return new HttpAsrDiarizationParserError("INVALID_CONFIGURATION", message, false);
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 2_048) : "ASR request failed";
}
