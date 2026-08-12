import type {
  IndexConversationSource,
  IndexConversationTurn,
  IndexSourceDocument,
  IndexSourceParserPort,
} from "./index-build-worker.ts";

const defaultSourceTypes = [
  "application/vnd.firefly.transcript+json",
  "application/x.firefly-transcript+json",
] as const;
const roles = new Set(["user", "assistant", "system", "tool"] as const);

export interface TranscriptJsonParserOptions {
  readonly parser_id?: string;
  readonly source_types?: readonly string[];
  readonly max_source_characters?: number;
  readonly max_turns?: number;
  readonly max_turn_characters?: number;
  readonly max_identity_characters?: number;
}

export class TranscriptJsonParserError extends Error {
  readonly code:
    | "INVALID_CONFIGURATION"
    | "SOURCE_TOO_LARGE"
    | "INVALID_JSON"
    | "UNSUPPORTED_SCHEMA_VERSION"
    | "INVALID_TRANSCRIPT"
    | "TURN_LIMIT_EXCEEDED"
    | "TURN_CONTENT_TOO_LARGE"
    | "DUPLICATE_TURN"
    | "INVALID_TIMESTAMP";
  readonly retryable = false;

  constructor(code: TranscriptJsonParserError["code"], message: string) {
    super(message);
    this.name = "TranscriptJsonParserError";
    this.code = code;
  }
}

/** Parses the versioned canonical transcript envelope emitted by ASR or message-store adapters. */
export class TranscriptJsonParser implements IndexSourceParserPort {
  readonly parser_id: string;
  private readonly sourceTypes: ReadonlySet<string>;
  private readonly maxSourceCharacters: number;
  private readonly maxTurns: number;
  private readonly maxTurnCharacters: number;
  private readonly maxIdentityCharacters: number;

  constructor(options: TranscriptJsonParserOptions = {}) {
    this.parser_id = options.parser_id?.trim() || "firefly-transcript-json-v1";
    const sourceTypes = (options.source_types ?? defaultSourceTypes).map(normalizeSourceType);
    this.sourceTypes = new Set(sourceTypes);
    this.maxSourceCharacters = options.max_source_characters ?? 10_000_000;
    this.maxTurns = options.max_turns ?? 100_000;
    this.maxTurnCharacters = options.max_turn_characters ?? 100_000;
    this.maxIdentityCharacters = options.max_identity_characters ?? 256;

    if (!this.parser_id || this.sourceTypes.size === 0 || this.sourceTypes.size !== sourceTypes.length || sourceTypes.some((type) => !type)) {
      throw configurationError("Transcript parser ID and source types must be non-empty and unique");
    }
    validateInteger(this.maxSourceCharacters, 1_024, 50_000_000, "source character limit");
    validateInteger(this.maxTurns, 1, 1_000_000, "turn limit");
    validateInteger(this.maxTurnCharacters, 1, 5_000_000, "turn character limit");
    validateInteger(this.maxIdentityCharacters, 1, 1_024, "identity character limit");
  }

  supports(sourceType: string): boolean {
    return this.sourceTypes.has(normalizeSourceType(sourceType));
  }

  parse(document: IndexSourceDocument): IndexConversationSource {
    if (!this.supports(document.source_type)) {
      throw configurationError(`Unsupported transcript source type: ${document.source_type}`);
    }
    if (document.content.length > this.maxSourceCharacters) {
      throw new TranscriptJsonParserError("SOURCE_TOO_LARGE", "Transcript source exceeds the configured character limit");
    }

    let value: unknown;
    try {
      value = JSON.parse(document.content);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown JSON syntax error";
      throw new TranscriptJsonParserError("INVALID_JSON", detail.slice(0, 2_048));
    }
    if (!isRecord(value) || !Object.hasOwn(value, "schema_version")) {
      throw invalidTranscript("Transcript must be an object with schema_version and turns");
    }
    if (value.schema_version !== 1) {
      throw new TranscriptJsonParserError("UNSUPPORTED_SCHEMA_VERSION", "Transcript schema_version must be 1");
    }
    if (!Array.isArray(value.turns) || value.turns.length === 0) {
      throw invalidTranscript("Transcript turns must be a non-empty array");
    }
    if (value.turns.length > this.maxTurns) {
      throw new TranscriptJsonParserError("TURN_LIMIT_EXCEEDED", "Transcript exceeds the configured turn limit");
    }

    const turnIds = new Set<string>();
    const sequences = new Set<number>();
    const turns = value.turns.map((turn, index) => {
      const parsed = this.parseTurn(turn, index);
      if (turnIds.has(parsed.turn_id) || sequences.has(parsed.sequence)) {
        throw new TranscriptJsonParserError(
          "DUPLICATE_TURN",
          `Transcript turn ${index + 1} duplicates a turn_id or sequence`,
        );
      }
      turnIds.add(parsed.turn_id);
      sequences.add(parsed.sequence);
      return parsed;
    });
    return { kind: "conversation", turns };
  }

  private parseTurn(value: unknown, index: number): IndexConversationTurn {
    if (!isRecord(value)) throw invalidTranscript(`Transcript turn ${index + 1} must be an object`);
    const turnId = requiredIdentity(value.turn_id, "turn_id", index, this.maxIdentityCharacters);
    const speakerId = requiredIdentity(value.speaker_id, "speaker_id", index, this.maxIdentityCharacters);
    if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0) {
      throw invalidTranscript(`Transcript turn ${index + 1} requires a non-negative safe integer sequence`);
    }
    if (typeof value.content !== "string" || !value.content.trim()) {
      throw invalidTranscript(`Transcript turn ${index + 1} requires non-empty content`);
    }
    if (value.content.length > this.maxTurnCharacters) {
      throw new TranscriptJsonParserError(
        "TURN_CONTENT_TOO_LARGE",
        `Transcript turn ${index + 1} exceeds the configured character limit`,
      );
    }
    const role = optionalRole(value.role, index);
    const startedAt = optionalTimestamp(value.started_at, "started_at", index);
    const endedAt = optionalTimestamp(value.ended_at, "ended_at", index);
    if (startedAt && endedAt && Date.parse(endedAt) < Date.parse(startedAt)) {
      throw new TranscriptJsonParserError("INVALID_TIMESTAMP", `Transcript turn ${index + 1} ends before it starts`);
    }
    return {
      turn_id: turnId,
      sequence: value.sequence as number,
      speaker_id: speakerId,
      ...(role ? { role } : {}),
      content: value.content,
      ...(startedAt ? { started_at: startedAt } : {}),
      ...(endedAt ? { ended_at: endedAt } : {}),
    };
  }
}

function requiredIdentity(value: unknown, field: string, index: number, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw invalidTranscript(`Transcript turn ${index + 1} ${field} must contain 1 to ${maximum} characters`);
  }
  return value.trim();
}

function optionalRole(value: unknown, index: number): IndexConversationTurn["role"] {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !roles.has(value as "user" | "assistant" | "system" | "tool")) {
    throw invalidTranscript(`Transcript turn ${index + 1} role is invalid`);
  }
  return value as IndexConversationTurn["role"];
}

function optionalTimestamp(value: unknown, field: string, index: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !isIsoTimestamp(value)) {
    throw new TranscriptJsonParserError("INVALID_TIMESTAMP", `Transcript turn ${index + 1} ${field} must be an ISO timestamp`);
  }
  return value;
}

function isIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) && !Number.isNaN(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeSourceType(value: string): string {
  return value.trim().toLowerCase();
}

function validateInteger(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw configurationError(`Transcript parser ${label} must be between ${minimum} and ${maximum}`);
  }
}

function invalidTranscript(message: string): TranscriptJsonParserError {
  return new TranscriptJsonParserError("INVALID_TRANSCRIPT", message);
}

function configurationError(message: string): TranscriptJsonParserError {
  return new TranscriptJsonParserError("INVALID_CONFIGURATION", message);
}
