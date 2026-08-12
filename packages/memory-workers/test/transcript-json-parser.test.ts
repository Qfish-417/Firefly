import assert from "node:assert/strict";
import test from "node:test";

import {
  ConversationTurnChunker,
  ParserBackedIndexSourcePort,
  TranscriptJsonParser,
  TranscriptJsonParserError,
  type IndexSourceDocument,
} from "../src/index.ts";

const digest = `sha256:${"e".repeat(64)}` as const;

function transcriptDocument(value: unknown, sourceType = "application/vnd.firefly.transcript+json"): IndexSourceDocument {
  return {
    memory_id: "memory.parser.transcript",
    content: typeof value === "string" ? value : JSON.stringify(value),
    source_type: sourceType,
    entity_keys: ["mission.solar"],
    citation: {
      artifact_id: "artifact.parser.transcript",
      uri: "s3://parser-test/session.json",
      digest,
      locator: { path: "transcripts/session.json" },
    },
  };
}

function validEnvelope(): unknown {
  return {
    schema_version: 1,
    turns: [
      {
        turn_id: "turn-1",
        sequence: 1,
        speaker_id: "learner-7",
        role: "user",
        content: "Why does the output fall at night?",
        started_at: "2026-08-12T10:00:00Z",
        ended_at: "2026-08-12T10:00:04Z",
      },
      {
        turn_id: "turn-2",
        sequence: 2,
        speaker_id: "director",
        role: "assistant",
        content: "The available sunlight changes over time.",
        started_at: "2026-08-12T10:00:05+00:00",
      },
    ],
  };
}

test("transcript parser preserves canonical turn identity, role and timestamps", () => {
  const source = new TranscriptJsonParser().parse(transcriptDocument(validEnvelope()));

  assert.equal(source.kind, "conversation");
  assert.deepEqual(source.turns.map((turn) => [turn.turn_id, turn.sequence, turn.speaker_id, turn.role]), [
    ["turn-1", 1, "learner-7", "user"],
    ["turn-2", 2, "director", "assistant"],
  ]);
  assert.equal(source.turns[0]?.ended_at, "2026-08-12T10:00:04Z");
});

test("transcript parser and ConversationTurnChunker form a structured indexing path", async () => {
  const document = transcriptDocument(validEnvelope());
  const sourcePort = new ParserBackedIndexSourcePort({ load: async () => [document] }, {
    parsers: [new TranscriptJsonParser()],
  });
  const parsed = await sourcePort.load({ schema_version: 1 } as never);
  const chunks = new ConversationTurnChunker({ max_child_characters: 128, max_parent_characters: 256 }).chunk(parsed[0]!);

  assert.deepEqual(chunks.map((chunk) => chunk.chunk_level), ["parent", "child", "child"]);
  assert.equal(chunks[1]?.citation.locator?.turn_id, "turn-1");
  assert.equal(chunks[1]?.citation.locator?.speaker_id, "learner-7");
  assert.match(chunks[2]?.content ?? "", /^\[director\/assistant #2\]/u);
});

test("transcript parser rejects malformed JSON, unknown versions and empty transcripts", () => {
  const parser = new TranscriptJsonParser();
  assert.throws(
    () => parser.parse(transcriptDocument("{")),
    (error: unknown) => error instanceof TranscriptJsonParserError && error.code === "INVALID_JSON",
  );
  assert.throws(
    () => parser.parse(transcriptDocument({ schema_version: 2, turns: [] })),
    (error: unknown) => error instanceof TranscriptJsonParserError && error.code === "UNSUPPORTED_SCHEMA_VERSION",
  );
  assert.throws(
    () => parser.parse(transcriptDocument({ schema_version: 1, turns: [] })),
    (error: unknown) => error instanceof TranscriptJsonParserError && error.code === "INVALID_TRANSCRIPT",
  );
});

test("transcript parser rejects duplicate identity, invalid roles and timestamps", () => {
  const parser = new TranscriptJsonParser();
  assert.throws(
    () => parser.parse(transcriptDocument({
      schema_version: 1,
      turns: [
        { turn_id: "same", sequence: 1, speaker_id: "a", content: "one" },
        { turn_id: "same", sequence: 2, speaker_id: "b", content: "two" },
      ],
    })),
    (error: unknown) => error instanceof TranscriptJsonParserError && error.code === "DUPLICATE_TURN",
  );
  assert.throws(
    () => parser.parse(transcriptDocument({
      schema_version: 1,
      turns: [{ turn_id: "one", sequence: 1, speaker_id: "a", role: "speaker", content: "one" }],
    })),
    (error: unknown) => error instanceof TranscriptJsonParserError && error.code === "INVALID_TRANSCRIPT",
  );
  assert.throws(
    () => parser.parse(transcriptDocument({
      schema_version: 1,
      turns: [{
        turn_id: "one", sequence: 1, speaker_id: "a", content: "one",
        started_at: "2026-08-12T10:00:05Z", ended_at: "2026-08-12T10:00:04Z",
      }],
    })),
    (error: unknown) => error instanceof TranscriptJsonParserError && error.code === "INVALID_TIMESTAMP",
  );
});

test("transcript parser enforces source, turn, content and MIME limits", () => {
  const parser = new TranscriptJsonParser({ max_source_characters: 1_024, max_turns: 1, max_turn_characters: 4 });
  assert.throws(
    () => parser.parse(transcriptDocument({
      schema_version: 1,
      turns: [
        { turn_id: "one", sequence: 1, speaker_id: "a", content: "one" },
        { turn_id: "two", sequence: 2, speaker_id: "b", content: "two" },
      ],
    })),
    (error: unknown) => error instanceof TranscriptJsonParserError && error.code === "TURN_LIMIT_EXCEEDED",
  );
  assert.throws(
    () => parser.parse(transcriptDocument({
      schema_version: 1,
      turns: [{ turn_id: "one", sequence: 1, speaker_id: "a", content: "12345" }],
    })),
    (error: unknown) => error instanceof TranscriptJsonParserError && error.code === "TURN_CONTENT_TOO_LARGE",
  );
  assert.throws(
    () => parser.parse(transcriptDocument("x".repeat(1_025))),
    (error: unknown) => error instanceof TranscriptJsonParserError && error.code === "SOURCE_TOO_LARGE",
  );
  assert.throws(
    () => parser.parse(transcriptDocument(validEnvelope(), "application/json")),
    (error: unknown) => error instanceof TranscriptJsonParserError && error.code === "INVALID_CONFIGURATION",
  );
});
