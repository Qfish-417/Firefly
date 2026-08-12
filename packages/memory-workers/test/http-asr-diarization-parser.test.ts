import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  ConversationTurnChunker,
  HttpAsrDiarizationParser,
  HttpAsrDiarizationParserError,
  type IndexSourceDocument,
} from "../src/index.ts";

const bytes = new TextEncoder().encode("audio-fixture");
const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
const document: IndexSourceDocument = {
  memory_id: "memory.asr.http",
  content: "",
  content_bytes: bytes,
  source_type: "audio/wav",
  entity_keys: ["mission.solar"],
  citation: {
    artifact_id: "artifact.asr.http",
    uri: "s3://asr-test/reflection.wav",
    digest,
    locator: { path: "audio/reflection.wav" },
  },
};

function validResponse(): Record<string, unknown> {
  return {
    schema_version: 1,
    contract: "firefly.asr-diarization.v1",
    document_digest: digest,
    provider: {
      provider_id: "asr.example",
      model_id: "speech-large",
      model_version: "2026-08-01",
    },
    diarization: { enabled: true },
    duration_ms: 12_000,
    language: "en",
    turns: [
      {
        turn_id: "turn-1",
        sequence: 1,
        speaker_id: "speaker-1",
        content: "Why does solar output fall at night?",
        start_ms: 500,
        end_ms: 4_000,
        confidence: 0.96,
        language: "en",
      },
      {
        turn_id: "turn-2",
        sequence: 2,
        speaker_id: "speaker-2",
        content: "Available sunlight changes over time.",
        start_ms: 4_200,
        end_ms: 8_500,
        confidence: 0.92,
        language: "en",
      },
    ],
  };
}

test("HTTP ASR parser sends verified audio and preserves diarization provenance", async () => {
  let request: Request | undefined;
  const parser = new HttpAsrDiarizationParser({
    parser_id: "asr.gateway.unit",
    endpoint: "https://asr.test/v1/transcribe",
    source_types: ["audio/wav"],
    fetch: async (input, init) => {
      request = new Request(input, init);
      return Response.json(validResponse());
    },
  });

  const structured = await parser.parse(document);
  assert.equal(request?.method, "POST");
  assert.equal(request?.redirect, "error");
  const form = await request?.formData();
  const metadata = form?.get("metadata");
  const artifact = form?.get("document");
  assert.ok(metadata instanceof File);
  assert.ok(artifact instanceof File);
  assert.equal(Buffer.compare(Buffer.from(await artifact.arrayBuffer()), Buffer.from(bytes)), 0);
  assert.equal(JSON.parse(await metadata.text()).document.citation.digest, digest);
  assert.deepEqual(structured.extraction, {
    method: "asr",
    provider_id: "asr.example",
    model_id: "speech-large",
    model_version: "2026-08-01",
    diarization: true,
  });

  const chunks = new ConversationTurnChunker({ max_child_characters: 128, max_parent_characters: 256 })
    .chunk({ ...document, structured });
  assert.equal(chunks[1]?.citation.locator?.media_start_ms, 500);
  assert.equal(chunks[1]?.citation.locator?.media_end_ms, 4_000);
  assert.equal(chunks[1]?.citation.locator?.confidence, 0.96);
  assert.equal(chunks[1]?.citation.locator?.extraction_provider, "asr.example");
  assert.equal(chunks[1]?.citation.locator?.diarization, "enabled");
});

test("HTTP ASR parser rejects digest mismatch, unstable order and invalid media offsets", async () => {
  const parser = new HttpAsrDiarizationParser({
    endpoint: "https://asr.test/v1/transcribe",
    fetch: async () => Response.json(validResponse()),
  });
  await assert.rejects(
    parser.parse({ ...document, citation: { ...document.citation, digest: `sha256:${"0".repeat(64)}` } }),
    (error: unknown) => error instanceof HttpAsrDiarizationParserError && error.code === "DIGEST_MISMATCH",
  );

  const invalid = validResponse();
  const turns = invalid.turns as Array<{ sequence: number; start_ms: number; end_ms: number }>;
  turns[1]!.sequence = 3;
  turns[1]!.end_ms = 13_000;
  await assert.rejects(
    new HttpAsrDiarizationParser({
      endpoint: "https://asr.test/v1/transcribe",
      fetch: async () => Response.json(invalid),
    }).parse(document),
    (error: unknown) => error instanceof HttpAsrDiarizationParserError && error.code === "INVALID_RESPONSE",
  );
});

test("HTTP ASR parser requires the versioned contract and non-empty speech", async () => {
  const missingContract = validResponse();
  delete missingContract.contract;
  await assert.rejects(
    new HttpAsrDiarizationParser({
      endpoint: "https://asr.test/v1/transcribe",
      fetch: async () => Response.json(missingContract),
    }).parse(document),
    (error: unknown) => error instanceof HttpAsrDiarizationParserError && error.code === "INVALID_RESPONSE",
  );

  const empty = validResponse();
  empty.turns = [];
  await assert.rejects(
    new HttpAsrDiarizationParser({
      endpoint: "https://asr.test/v1/transcribe",
      fetch: async () => Response.json(empty),
    }).parse(document),
    (error: unknown) => error instanceof HttpAsrDiarizationParserError && error.code === "NO_EXTRACTABLE_SPEECH",
  );
});

test("HTTP ASR parser enforces diarization and speaker consistency", async () => {
  const inconsistent = validResponse();
  inconsistent.diarization = { enabled: false };
  await assert.rejects(
    new HttpAsrDiarizationParser({
      endpoint: "https://asr.test/v1/transcribe",
      fetch: async () => Response.json(inconsistent),
    }).parse(document),
    (error: unknown) => error instanceof HttpAsrDiarizationParserError && error.code === "INVALID_RESPONSE",
  );
});

test("HTTP ASR parser rejects insecure endpoints and oversized streamed responses", async () => {
  assert.throws(
    () => new HttpAsrDiarizationParser({ endpoint: "http://asr.example/v1/transcribe" }),
    (error: unknown) => error instanceof HttpAsrDiarizationParserError && error.code === "INVALID_CONFIGURATION",
  );
  const parser = new HttpAsrDiarizationParser({
    endpoint: "https://asr.test/v1/transcribe",
    max_response_bytes: 1_024,
    fetch: async () => Response.json({ ...validResponse(), padding: "x".repeat(2_000) }),
  });
  await assert.rejects(
    parser.parse(document),
    (error: unknown) => error instanceof HttpAsrDiarizationParserError && error.code === "RESPONSE_TOO_LARGE",
  );
});
