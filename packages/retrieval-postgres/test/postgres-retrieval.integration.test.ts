import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import type { EmbeddingPort } from "@firefly/model-gateway";
import {
  MemoryPolicyError,
  MemoryRepository,
  RetrievalIndexPolicyError,
  RetrievalIndexRepository,
  createDatabase,
  migrateToLatest,
} from "@firefly/persistence";
import { CandidateSourceEvidenceExpander, RetrievalGateway, type RetrievalHit } from "@firefly/retrieval-service";
import { sql } from "kysely";

import {
  ChunkIdentityConflictError,
  PostgresLexicalRetriever,
  PostgresMemoryAuthorization,
  PostgresMemoryIndexer,
  PostgresParentChildExpander,
  PostgresRelationExpansionCandidateSource,
  PostgresRetrievalPolicyError,
  PostgresStructuredEventAggregator,
  PostgresVectorRetriever,
} from "../src/index.ts";

const connectionString = process.env.TEST_DATABASE_URL;
const digest = (character: string) => `sha256:${character.repeat(64)}` as const;

test(
  "PostgreSQL hybrid retrieval enforces ACL and propagates memory deletion",
  { skip: connectionString ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    assert.ok(connectionString);
    await migrateToLatest(connectionString);
    const db = createDatabase(connectionString);

    try {
      await sql`
        TRUNCATE TABLE
          questlab.outbox_event,
          questlab.structured_edge,
          questlab.structured_event,
          questlab.retrieval_index_version,
          questlab.memory_record
        RESTART IDENTITY CASCADE
      `.execute(db);
      const memories = new MemoryRepository(db);
      const indexes = new RetrievalIndexRepository(db);
      const indexer = new PostgresMemoryIndexer(db);
      const principal = { tenant_id: "tenant.retrieval", user_id: "user.retrieval.01" };

      await memories.capture({
        memory_id: "memory.retrieval.public",
        tenant_id: "tenant.retrieval",
        owner_type: "platform",
        owner_id: "platform",
        scope: "public",
        stage: "structured",
        kind: "document",
        content_digest: digest("1"),
        confidence: 1,
        sensitivity: "public",
        status: "active",
      });
      await memories.capture({
        memory_id: "memory.retrieval.user",
        tenant_id: "tenant.retrieval",
        owner_type: "user",
        owner_id: "user.retrieval.01",
        scope: "user_private",
        stage: "structured",
        kind: "observation",
        content_digest: digest("2"),
        confidence: 0.95,
        sensitivity: "private",
        status: "active",
      });
      await memories.capture({
        memory_id: "memory.retrieval.other",
        tenant_id: "tenant.retrieval",
        owner_type: "user",
        owner_id: "user.retrieval.02",
        scope: "user_private",
        stage: "structured",
        kind: "observation",
        content_digest: digest("3"),
        confidence: 0.9,
        sensitivity: "private",
        status: "active",
      });
      await memories.capture({
        memory_id: "memory.retrieval.foreign-public",
        tenant_id: "tenant.other",
        owner_type: "platform",
        owner_id: "platform",
        scope: "public",
        stage: "structured",
        kind: "document",
        content_digest: digest("4"),
        confidence: 1,
        sensitivity: "public",
        status: "active",
      });

      const buildV1 = indexBuild("v1", "tenant.retrieval", "watermark.01");
      const buildReplays = await Promise.all([indexes.createBuild(buildV1), indexes.createBuild(buildV1)]);
      assert.deepEqual(buildReplays.map((version) => version.index_version_id), [buildV1.index_version_id, buildV1.index_version_id]);

      const publicParent = parentChunk(
        "public-parent",
        "memory.retrieval.public",
        "# Solar Output\n\nSolar output changes with daylight. Battery reserves support the full night cycle.",
      );
      await indexer.index(publicParent);
      const publicChild = chunk("public", "memory.retrieval.public", "Solar output changes with daylight.", [1, 0, 0], 1);
      await indexer.index({
        ...publicChild,
        parent_chunk_id: publicParent.chunk_id,
        structure_path: ["Solar Output"],
        citation: {
          ...publicChild.citation,
          locator: { ...publicChild.citation.locator, region_id: "solar-output" },
        },
      });
      const privateChunk = chunk(
        "private",
        "memory.retrieval.user",
        "Private solar output observation for the current learner.",
        [0.95, 0.05, 0],
      );
      await indexer.index(privateChunk);
      await indexer.index(privateChunk);
      await assert.rejects(
        indexer.index({
          ...chunk("wrong-parent", "memory.retrieval.user", "Cross-memory parent reference.", [1, 0, 0], 1),
          parent_chunk_id: publicParent.chunk_id,
        }),
        (error: unknown) => error instanceof PostgresRetrievalPolicyError,
      );
      await indexer.index(chunk("secret", "memory.retrieval.other", "Secret solar output record.", [1, 0, 0]));
      await assert.rejects(
        indexer.index(chunk("other-dimension", "memory.retrieval.public", "Unrelated dimension probe.", [1, 0], 1)),
        (error: unknown) => error instanceof PostgresRetrievalPolicyError,
      );
      const foreignBuild = indexBuild("foreign", "tenant.other", "watermark.foreign");
      await indexes.createBuild(foreignBuild);
      await assert.rejects(
        indexer.index(chunk("foreign", "memory.retrieval.public", "Cross tenant chunk.", [1, 0, 0], 1, foreignBuild.index_version_id)),
        (error: unknown) => error instanceof PostgresRetrievalPolicyError,
      );
      await indexer.index(chunk(
        "foreign-public",
        "memory.retrieval.foreign-public",
        "Public solar output reference from another tenant.",
        [1, 0, 0],
        0,
        foreignBuild.index_version_id,
      ));
      await indexes.completeBuild(indexBuildResult(foreignBuild, "ready", 1, 1));
      await indexes.activate(foreignBuild.index_version_id, new Date("2026-08-10T09:00:00Z"));
      const changedPrivateContent = "Changed content under an existing Chunk ID.";
      await assert.rejects(
        indexer.index({
          ...privateChunk,
          content: changedPrivateContent,
          chunk_digest: contentDigest(changedPrivateContent),
        }),
        (error: unknown) => error instanceof ChunkIdentityConflictError,
      );
      await indexes.completeBuild(indexBuildResult(buildV1, "ready", 3, 4));
      await indexes.activate(buildV1.index_version_id, new Date("2026-08-10T09:00:00Z"));
      assert.equal((await indexes.getActive("tenant.retrieval", "memory.hybrid"))?.index_version_id, buildV1.index_version_id);

      const lexical = new PostgresLexicalRetriever(db);
      const embeddings: EmbeddingPort = {
        embed: async ({ inputs }) => ({
          vectors: inputs.map(() => [1, 0, 0]),
          usage: {
            input_tokens: 3,
            output_tokens: 0,
            cached_input_tokens: 0,
            total_tokens: 3,
            cost_usd: 0,
          },
        }),
      };
      const vector = new PostgresVectorRetriever({
        db,
        embeddings,
        embedding_model: "embedding.integration.v1",
        embedding_budget: { max_tokens: 100, max_cost_usd: 0.01, max_duration_ms: 1_000 },
      });
      const authorization = new PostgresMemoryAuthorization(db);
      const call = {
        query_id: "query.retrieval.integration",
        query: "solar output",
        principal,
        purpose: "answer_current_user",
        max_results: 10,
        filters: {},
      } as const;

      const lexicalHits = await lexical.retrieve(call);
      assert.deepEqual(lexicalHits.map((hit) => hit.id).sort(), ["chunk.foreign-public", "chunk.private", "chunk.public"]);
      const vectorHits = await vector.retrieve(call);
      assert.deepEqual(vectorHits.map((hit) => hit.id).sort(), ["chunk.foreign-public", "chunk.private", "chunk.public"]);

      // `approximate` reorders the work so the vector index runs before authorization. That is only
      // acceptable if the ACL still decides what comes out, so it is asserted here rather than trusted:
      // the tenant-scoped secret must stay absent even though the fast path reached the rows first.
      const approximateVector = new PostgresVectorRetriever({
        db,
        embeddings,
        embedding_model: "embedding.integration.v1",
        embedding_budget: { max_tokens: 100, max_cost_usd: 0.01, max_duration_ms: 1_000 },
        ann_recall_mode: "approximate",
      });
      const approximateHits = await approximateVector.retrieve(call);
      assert.deepEqual(
        approximateHits.map((hit) => hit.id).sort(),
        ["chunk.foreign-public", "chunk.private", "chunk.public"],
      );
      assert.equal(approximateHits.some((hit) => hit.id === "chunk.secret"), false);
      assert.equal(approximateHits.some((hit) => hit.id === publicParent.chunk_id), false);
      assert.equal(lexicalHits.some((hit) => hit.id === publicParent.chunk_id), false);
      assert.equal(await authorization.canRead({ principal, purpose: call.purpose, hit: secretHit() }), false);

      // The batch form is an optimisation, so it has to agree with the per-hit form exactly — including
      // the denials. Anything it lets through that `canRead` rejects is an authorization bypass, and a
      // fast bypass is worse than a slow check.
      const mixed = [...lexicalHits, secretHit()];
      const batch = await authorization.canReadAll({ principal, purpose: call.purpose, hits: mixed });
      const serial = new Set<string>();
      for (const hit of mixed) {
        if (await authorization.canRead({ principal, purpose: call.purpose, hit })) serial.add(hit.id);
      }
      assert.deepEqual([...batch].sort(), [...serial].sort());
      assert.equal(batch.has(secretHit().id), false);

      // A tampered citation must not pass just because the chunk id is readable: the batch join binds
      // all four columns, so swapping the digest has to drop the row.
      const tampered = lexicalHits.map((hit) => ({
        ...hit,
        citation: { ...hit.citation, digest: `sha256:${"0".repeat(64)}` as `sha256:${string}` },
      }));
      assert.equal((await authorization.canReadAll({ principal, purpose: call.purpose, hits: tampered })).size, 0);

      // An empty purpose is refused in both forms.
      assert.equal((await authorization.canReadAll({ principal, purpose: "  ", hits: lexicalHits })).size, 0);
      const publicHit = lexicalHits.find((hit) => hit.id === "chunk.public");
      assert.ok(publicHit);
      assert.equal(
        await authorization.canRead({
          principal,
          purpose: call.purpose,
          hit: { ...publicHit, citation: { ...publicHit.citation, digest: digest("9") } },
        }),
        false,
      );

      const gateway = new RetrievalGateway({
        retrievers: [lexical, vector],
        authorization,
      });
      const pack = await gateway.retrieve({
        query_id: call.query_id,
        original_query: call.query,
        intent: "fact_lookup",
        agent_id: "learning-director",
        principal,
        purpose: call.purpose,
        token_budget: 1_000,
        estimated_chunk_tokens: 80,
        require_citations: true,
      });
      assert.equal(pack.status, "sufficient");
      // All three authorized chunks reach the pack. Previously only two did, because `marginal_gain`
      // stopped selection as soon as two candidates scored equally — the tie that Reciprocal Rank
      // Fusion produces whenever both retrievers rank the same document first. The ACL boundary is
      // asserted separately above (`secretHit` is denied, the parent projection never surfaces), so
      // the third chunk appearing here is correct selection, not a widened authorization scope.
      assert.deepEqual(pack.evidence.map((item) => item.evidence_id).sort(), ["chunk.foreign-public", "chunk.private", "chunk.public"]);

      const expandedGateway = new RetrievalGateway({
        retrievers: [lexical, vector],
        authorization,
        expander: new PostgresParentChildExpander(db),
      });
      const expandedPack = await expandedGateway.retrieve({
        query_id: "query.retrieval.parent",
        original_query: "solar daylight",
        intent: "fact_lookup",
        agent_id: "learning-director",
        principal,
        purpose: call.purpose,
        token_budget: 1_000,
        estimated_chunk_tokens: 80,
        require_citations: true,
        filters: { memory_id: "memory.retrieval.public" },
      });
      assert.deepEqual(expandedPack.evidence.map((item) => item.evidence_id), [publicParent.chunk_id]);
      assert.match(expandedPack.evidence[0]?.untrusted_content ?? "", /Battery reserves support the full night cycle/);
      assert.equal(expandedPack.evidence[0]?.citation.locator?.chunk_level, "parent");

      const neighbor = chunk(
        "public-neighbor",
        "memory.retrieval.public",
        "Battery reserve context for the active region.",
        [0, 1, 0],
        2,
      );
      await indexer.index({
        ...neighbor,
        parent_chunk_id: publicParent.chunk_id,
        structure_path: ["Solar Output"],
        entity_keys: publicChild.entity_keys,
        citation: {
          ...neighbor.citation,
          locator: { ...neighbor.citation.locator, region_id: "solar-output" },
        },
      });
      const relationCandidates = await new PostgresRelationExpansionCandidateSource({ db }).listCandidates({
        hits: [publicHit],
        principal,
        purpose: call.purpose,
        max_candidates_per_anchor: 4,
      });
      assert.deepEqual(relationCandidates.map((candidate) => ({
        anchor_id: candidate.anchor_id,
        relation: candidate.relation,
        hit_id: candidate.hit.id,
      })), [{
        anchor_id: "chunk.public",
        relation: "region",
        hit_id: "chunk.public-neighbor",
      }]);
      const relationGateway = new RetrievalGateway({
        retrievers: [lexical],
        authorization,
        expander: new CandidateSourceEvidenceExpander(
          new PostgresRelationExpansionCandidateSource({ db }),
        ),
      });
      const relationPack = await relationGateway.retrieve({
        query_id: "query.retrieval.region-expansion",
        original_query: "solar output",
        intent: "fact_lookup",
        agent_id: "learning-director",
        principal,
        purpose: call.purpose,
        token_budget: 1_000,
        estimated_chunk_tokens: 80,
        require_citations: true,
        filters: { memory_id: "memory.retrieval.public" },
      });
      assert.deepEqual(relationPack.evidence.map((item) => item.evidence_id), [
        "chunk.public",
        "chunk.public-neighbor",
      ]);

      const buildV2 = indexBuild("v2", "tenant.retrieval", "watermark.02");
      await indexes.createBuild(buildV2);
      await indexer.index(chunk(
        "public.v2",
        "memory.retrieval.public",
        "Solar output changes with daylight in the active revision.",
        [1, 0, 0],
        0,
        buildV2.index_version_id,
      ));
      assert.deepEqual((await lexical.retrieve(call)).map((hit) => hit.id).sort(), ["chunk.foreign-public", "chunk.private", "chunk.public"]);
      await indexes.completeBuild(indexBuildResult(buildV2, "ready", 1, 1));
      await indexes.activate(buildV2.index_version_id, new Date("2026-08-10T11:00:00Z"));
      assert.deepEqual((await lexical.retrieve(call)).map((hit) => hit.id).sort(), ["chunk.foreign-public", "chunk.public.v2"]);
      const versions = await db
        .selectFrom("questlab.retrieval_index_version")
        .select(["index_version_id", "status"])
        .where("tenant_id", "=", principal.tenant_id)
        .where("logical_name", "=", "memory.hybrid")
        .execute();
      assert.deepEqual(
        Object.fromEntries(versions.map((version) => [version.index_version_id, version.status])),
        { "index.memory.v1": "retired", "index.memory.v2": "active" },
      );
      await assert.rejects(
        indexes.completeBuild({ ...indexBuildResult(buildV2, "ready", 2, 2), chunk_count: 2 }),
        (error: unknown) => error instanceof RetrievalIndexPolicyError,
      );

      await memories.recordEvent({
        event_id: "event.retrieval.private",
        tenant_id: principal.tenant_id,
        subject_id: principal.user_id,
        event_type: "solar_observation",
        object: { output_changed: true },
        scope: "user_private",
        owner_id: principal.user_id,
        occurred_from: new Date("2026-08-10T10:00:00Z"),
        dedupe_key: "solar:user.retrieval.01:2026-08-10",
        source_memory_ids: [privateChunk.memory_id],
        confidence: 0.95,
      });
      await memories.recordEdge({
        edge_id: "edge.retrieval.private",
        tenant_id: principal.tenant_id,
        source_node_id: "concept.solar",
        predicate: "prerequisite_of",
        target_node_id: "concept.storage",
        direction: "directed",
        scope: "user_private",
        owner_id: principal.user_id,
        valid_from: new Date("2026-08-10T10:00:00Z"),
        dedupe_key: "edge:solar:prerequisite:storage",
        source_memory_ids: [privateChunk.memory_id],
        confidence: 0.95,
      });
      await assert.rejects(
        memories.deleteMemory({
          deletion_id: "deletion.retrieval.unauthorized",
          memory_id: privateChunk.memory_id,
          principal: { tenant_id: principal.tenant_id, user_id: "user.retrieval.02" },
          requested_by: "user.retrieval.02",
          reason: "unauthorized test",
          propagation_targets: ["object_store", "cache"],
        }),
        (error: unknown) => error instanceof MemoryPolicyError,
      );

      const receipt = await memories.deleteMemory({
        deletion_id: "deletion.retrieval.01",
        memory_id: privateChunk.memory_id,
        principal,
        requested_by: principal.user_id,
        reason: "user requested erasure",
        propagation_targets: ["object_store", "cache"],
        occurred_at: new Date("2026-08-10T12:00:00Z"),
      });
      assert.equal(receipt.removed_chunk_count, 1);
      assert.equal(receipt.invalidated_event_count, 1);
      assert.equal(receipt.invalidated_edge_count, 1);
      assert.equal(receipt.propagation_status, "pending");
      assert.equal(receipt.propagation_completed_at, null);

      let deletionStatus = await memories.acknowledgeDeletion({
        schema_version: 1,
        ack_id: "ack.deletion.cache.01",
        deletion_id: receipt.deletion_id,
        target: "cache",
        status: "failed",
        attempt: 1,
        occurred_at: "2026-08-10T12:01:00.000Z",
        evidence_refs: [],
        error: { code: "cache.timeout", message: "Cache deletion timed out", retryable: true },
      });
      assert.equal(deletionStatus.receipt.propagation_status, "failed");
      deletionStatus = await memories.acknowledgeDeletion({
        schema_version: 1,
        ack_id: "ack.deletion.object-store.01",
        deletion_id: receipt.deletion_id,
        target: "object_store",
        status: "completed",
        attempt: 1,
        occurred_at: "2026-08-10T12:02:00.000Z",
        evidence_refs: [],
      });
      assert.equal(deletionStatus.receipt.propagation_status, "failed");
      const cacheRetry = {
        schema_version: 1,
        ack_id: "ack.deletion.cache.02",
        deletion_id: receipt.deletion_id,
        target: "cache",
        status: "completed",
        attempt: 2,
        occurred_at: "2026-08-10T12:03:00.000Z",
        evidence_refs: [],
      } as const;
      deletionStatus = await memories.acknowledgeDeletion(cacheRetry);
      assert.equal(deletionStatus.receipt.propagation_status, "completed");
      assert.equal(deletionStatus.receipt.propagation_completed_at?.toISOString(), cacheRetry.occurred_at);
      const acknowledgementReplay = await memories.acknowledgeDeletion(cacheRetry);
      assert.equal(acknowledgementReplay.receipt.propagation_status, "completed");
      await assert.rejects(
        memories.acknowledgeDeletion({ ...cacheRetry, occurred_at: "2026-08-10T12:04:00.000Z" }),
        (error: unknown) => error instanceof MemoryPolicyError,
      );

      const replay = await memories.deleteMemory({
        deletion_id: "deletion.retrieval.replay",
        memory_id: privateChunk.memory_id,
        principal,
        requested_by: principal.user_id,
        reason: "retry",
        propagation_targets: ["cache", "object_store"],
      });
      assert.equal(replay.deletion_id, receipt.deletion_id);
      assert.equal(replay.propagation_status, "completed");

      const afterDeletion = await lexical.retrieve(call);
      assert.deepEqual(afterDeletion.map((hit) => hit.id).sort(), ["chunk.foreign-public", "chunk.public.v2"]);
      const aggregate = await memories.aggregateReadableEvents(principal, {
        subject_id: principal.user_id,
        event_type: "solar_observation",
      });
      assert.equal(aggregate.value, 0);
      const deletionEvents = await db
        .selectFrom("questlab.outbox_event")
        .select(["event_type", "payload"])
        .where("event_type", "=", "MemoryDeleted")
        .execute();
      assert.equal(deletionEvents.length, 1);
      assert.equal(deletionEvents[0]?.payload.memory_id, privateChunk.memory_id);
      const propagationEvents = await db
        .selectFrom("questlab.outbox_event")
        .select(["event_type", "payload"])
        .where("event_type", "=", "MemoryDeletionPropagationRequested")
        .execute();
      assert.equal(propagationEvents.length, 2);
      assert.deepEqual(propagationEvents.map((event) => event.payload.target).sort(), ["cache", "object_store"]);
      const completedEvents = await db
        .selectFrom("questlab.outbox_event")
        .select("event_id")
        .where("event_type", "=", "MemoryDeletionPropagationCompleted")
        .execute();
      assert.equal(completedEvents.length, 1);
    } finally {
      await db.destroy();
    }
  },
);

test(
  "PostgreSQL structured aggregation compares deduplicated counts and selects event time without crossing ACLs",
  { skip: connectionString ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    assert.ok(connectionString);
    await migrateToLatest(connectionString);
    const db = createDatabase(connectionString);
    try {
      await sql`
        TRUNCATE TABLE
          questlab.outbox_event,
          questlab.structured_edge,
          questlab.structured_event,
          questlab.retrieval_index_version,
          questlab.memory_record
        RESTART IDENTITY CASCADE
      `.execute(db);
      const memories = new MemoryRepository(db);
      const principal = { tenant_id: "tenant.structured", user_id: "user.structured" };
      for (const memory of [
        { memory_id: "memory.structured.owner", tenant_id: principal.tenant_id, owner_id: principal.user_id, marker: "a" },
        { memory_id: "memory.structured.hidden-user", tenant_id: principal.tenant_id, owner_id: "user.hidden", marker: "b" },
        { memory_id: "memory.structured.hidden-tenant", tenant_id: "tenant.hidden", owner_id: "user.foreign", marker: "c" },
      ]) {
        await memories.capture({
          memory_id: memory.memory_id,
          tenant_id: memory.tenant_id,
          owner_type: "user",
          owner_id: memory.owner_id,
          scope: "user_private",
          stage: "structured",
          kind: "event",
          content_digest: digest(memory.marker),
          confidence: 1,
          sensitivity: "private",
          status: "active",
        });
      }
      const record = (input: {
        readonly event_id: string;
        readonly tenant_id?: string;
        readonly subject_id: string;
        readonly owner_id?: string;
        readonly occurred_from: string;
        readonly occurred_to?: string;
        readonly dedupe_key: string;
        readonly source_memory_id?: string;
        readonly conflict?: boolean;
      }) => memories.recordEvent({
        event_id: input.event_id,
        tenant_id: input.tenant_id ?? principal.tenant_id,
        subject_id: input.subject_id,
        event_type: "lesson_completed",
        object: { lesson_id: input.dedupe_key },
        scope: "user_private",
        owner_id: input.owner_id ?? principal.user_id,
        occurred_from: new Date(input.occurred_from),
        ...(input.occurred_to ? { occurred_to: new Date(input.occurred_to) } : {}),
        dedupe_key: input.dedupe_key,
        source_memory_ids: [input.source_memory_id ?? "memory.structured.owner"],
        confidence: 0.95,
        ...(input.conflict ? { conflict_status: "conflict" as const } : {}),
      });
      await record({ event_id: "event.left.1", subject_id: "learner.left", occurred_from: "2026-08-01T01:00:00Z", occurred_to: "2026-08-01T01:30:00Z", dedupe_key: "lesson:left:1" });
      await record({ event_id: "event.left.1.duplicate", subject_id: "learner.left", occurred_from: "2026-08-01T01:10:00Z", dedupe_key: "lesson:left:1" });
      await record({ event_id: "event.left.2", subject_id: "learner.left", occurred_from: "2026-08-02T01:00:00Z", dedupe_key: "lesson:left:2" });
      await record({ event_id: "event.left.3", subject_id: "learner.left", occurred_from: "2026-08-03T01:00:00Z", dedupe_key: "lesson:left:3" });
      await record({ event_id: "event.left.conflict", subject_id: "learner.left", occurred_from: "2026-08-04T01:00:00Z", dedupe_key: "lesson:left:conflict", conflict: true });
      await record({ event_id: "event.right.1", subject_id: "learner.right", occurred_from: "2026-08-01T02:00:00Z", dedupe_key: "lesson:right:1" });
      await record({ event_id: "event.right.2", subject_id: "learner.right", occurred_from: "2026-08-02T02:00:00Z", dedupe_key: "lesson:right:2" });
      await record({ event_id: "event.hidden.user", subject_id: "learner.left", owner_id: "user.hidden", occurred_from: "2026-08-05T01:00:00Z", dedupe_key: "lesson:left:hidden-user", source_memory_id: "memory.structured.hidden-user" });
      await record({ event_id: "event.hidden.tenant", tenant_id: "tenant.hidden", subject_id: "learner.left", owner_id: "user.foreign", occurred_from: "2026-08-06T01:00:00Z", dedupe_key: "lesson:left:hidden-tenant", source_memory_id: "memory.structured.hidden-tenant" });

      const recordEdge = (input: {
        readonly edge_id: string;
        readonly source: string;
        readonly target: string;
        readonly owner_id?: string;
        readonly source_memory_id?: string;
        readonly valid_to?: string;
      }) => memories.recordEdge({
        edge_id: input.edge_id,
        tenant_id: principal.tenant_id,
        source_node_id: input.source,
        predicate: "prerequisite_of",
        target_node_id: input.target,
        direction: "directed",
        scope: "user_private",
        owner_id: input.owner_id ?? principal.user_id,
        valid_from: new Date("2026-08-01T00:00:00Z"),
        ...(input.valid_to ? { valid_to: new Date(input.valid_to) } : {}),
        dedupe_key: input.edge_id,
        source_memory_ids: [input.source_memory_id ?? "memory.structured.owner"],
        confidence: 0.95,
      });
      await recordEdge({ edge_id: "edge.graph.a-b", source: "concept.a", target: "concept.b" });
      await recordEdge({ edge_id: "edge.graph.b-c", source: "concept.b", target: "concept.c" });
      await recordEdge({ edge_id: "edge.graph.hidden", source: "concept.a", target: "concept.c", owner_id: "user.hidden", source_memory_id: "memory.structured.hidden-user" });
      await recordEdge({ edge_id: "edge.graph.expired", source: "concept.a", target: "concept.c", valid_to: "2026-08-10T00:00:00Z" });

      const aggregator = new PostgresStructuredEventAggregator(db);
      const requestBase = {
        original_query: "structured truth",
        agent_id: "learning-scientist" as const,
        principal,
        purpose: "integration_test",
        token_budget: 500,
        estimated_chunk_tokens: 20,
        require_citations: false,
      };
      const comparison = await aggregator.aggregate({ request: {
        ...requestBase,
        query_id: "query.structured.comparison",
        intent: "comparison",
        structured_query: {
          kind: "compare_event_counts",
          left_subject_id: "learner.left",
          right_subject_id: "learner.right",
          event_type: "lesson_completed",
        },
      } });
      assert.equal(comparison.value, 1);
      assert.deepEqual(comparison.details, {
        kind: "comparison_counts",
        left_subject_id: "learner.left",
        left_value: 3,
        right_subject_id: "learner.right",
        right_value: 2,
        difference: 1,
      });
      assert.deepEqual(comparison.conflicts, ["event.left.conflict"]);
      assert.deepEqual(comparison.excluded_reasons, ["1 conflicting events excluded"]);
      assert.equal(comparison.included_ids.includes("event.left.1.duplicate"), false);
      assert.equal(comparison.included_ids.some((id) => id.startsWith("event.hidden")), false);

      const temporal = async (selector: "first" | "last", subjectId = "learner.left") => aggregator.aggregate({ request: {
        ...requestBase,
        query_id: `query.structured.temporal.${selector}.${subjectId}`,
        intent: "temporal",
        structured_query: { kind: "select_event_time", subject_id: subjectId, event_type: "lesson_completed", selector },
      } });
      const first = await temporal("first");
      assert.equal(first.value, "2026-08-01T01:00:00.000Z");
      assert.deepEqual(first.details, {
        kind: "temporal_event",
        subject_id: "learner.left",
        event_type: "lesson_completed",
        selector: "first",
        event_id: "event.left.1",
        occurred_from: "2026-08-01T01:00:00.000Z",
        occurred_to: "2026-08-01T01:30:00.000Z",
      });
      const last = await temporal("last");
      assert.equal(last.value, "2026-08-03T01:00:00.000Z");
      assert.equal(last.details?.kind === "temporal_event" ? last.details.event_id : undefined, "event.left.3");
      const absent = await temporal("first", "learner.absent");
      assert.equal(absent.value, null);
      assert.deepEqual(absent.included_ids, []);
      assert.equal(absent.details?.kind === "temporal_event" ? absent.details.event_id : undefined, null);
      // The unknown subject is named, so "no event" cannot be misread as "the event type was wrong".
      assert.deepEqual(absent.excluded_reasons, ["subject learner.absent has no readable events of any type"]);

      // An empty result has two causes the rows cannot distinguish: the fact did not happen, or the
      // query named vocabulary that does not exist. Unexplained, a fabricated event_type yields a
      // confident count of 0 and, for comparison, a difference of 0 that reads as equality.
      const unknownType = await aggregator.aggregate({ request: {
        ...requestBase,
        query_id: "query.structured.unknown-type",
        intent: "count_events",
        structured_filters: { subject_id: "learner.left", event_type: "lesson_invented" },
      } });
      assert.equal(unknownType.value, 0);
      assert.deepEqual(unknownType.excluded_reasons, [
        "no readable event of type lesson_invented exists; the count is not a fact about the subject",
      ]);

      const unknownComparison = await aggregator.aggregate({ request: {
        ...requestBase,
        query_id: "query.structured.unknown-comparison",
        intent: "comparison",
        structured_query: {
          kind: "compare_event_counts",
          left_subject_id: "learner.left",
          right_subject_id: "learner.right",
          event_type: "lesson_invented",
        },
      } });
      assert.equal(unknownComparison.value, 0);
      assert.deepEqual(unknownComparison.excluded_reasons, [
        "no readable event of type lesson_invented exists; the count is not a fact about the subject",
      ]);

      // A genuine zero must stay silent, or every legitimately empty answer would look like a typo.
      const genuineZero = await aggregator.aggregate({ request: {
        ...requestBase,
        query_id: "query.structured.genuine-zero",
        intent: "count_events",
        structured_filters: {
          subject_id: "learner.right",
          event_type: "lesson_completed",
          from: "2027-01-01T00:00:00Z",
          to: "2027-02-01T00:00:00Z",
        },
      } });
      assert.equal(genuineZero.value, 0);
      assert.deepEqual(genuineZero.excluded_reasons, []);

      // The probe must not confirm vocabulary the principal cannot read. `event.hidden.tenant` exists
      // under tenant.hidden with event_type lesson_completed, so a probe that ignored ACLs would
      // report the type as known to a foreign tenant and leak which vocabulary that tenant uses.
      const foreignPresence = await memories.probeEventVocabulary(
        { tenant_id: "tenant.other" },
        { subject_id: "learner.left", event_type: "lesson_completed" },
      );
      assert.equal(foreignPresence.event_type_known, false);
      assert.equal(foreignPresence.subject_known, false);
      const ownerPresence = await memories.probeEventVocabulary(principal, {
        subject_id: "learner.left",
        event_type: "lesson_completed",
      });
      assert.equal(ownerPresence.event_type_known, true);
      assert.equal(ownerPresence.subject_known, true);

      const relationPath = await aggregator.aggregate({ request: {
        ...requestBase,
        query_id: "query.structured.path",
        intent: "multi_hop",
        structured_query: {
          kind: "find_relation_path",
          start_node_id: "concept.a",
          target_node_id: "concept.c",
          predicates: ["prerequisite_of"],
          direction: "outbound",
          max_hops: 3,
          as_of: "2026-08-16T00:00:00Z",
        },
      } });
      assert.equal(relationPath.value, 2);
      assert.deepEqual(relationPath.included_ids, ["edge.graph.a-b", "edge.graph.b-c"]);
      assert.deepEqual(relationPath.details, {
        kind: "relation_path",
        start_node_id: "concept.a",
        target_node_id: "concept.c",
        direction: "outbound",
        found: true,
        hop_count: 2,
        node_ids: ["concept.a", "concept.b", "concept.c"],
        path_hops: [
          { edge_id: "edge.graph.a-b", from_node_id: "concept.a", to_node_id: "concept.b", predicate: "prerequisite_of" },
          { edge_id: "edge.graph.b-c", from_node_id: "concept.b", to_node_id: "concept.c", predicate: "prerequisite_of" },
        ],
      });

      await assert.rejects(
        aggregator.aggregate({ request: {
          ...requestBase,
          query_id: "query.structured.reversed",
          intent: "temporal",
          structured_query: {
            kind: "select_event_time",
            subject_id: "learner.left",
            event_type: "lesson_completed",
            selector: "first",
            from: "2026-08-02T00:00:00Z",
            to: "2026-08-01T00:00:00Z",
          },
        } }),
        (error: unknown) => error instanceof PostgresRetrievalPolicyError,
      );
    } finally {
      await db.destroy();
    }
  },
);

function chunk(
  suffix: string,
  memoryId: string,
  content: string,
  embedding: readonly number[],
  ordinal = 0,
  indexVersionId = "index.memory.v1",
) {
  return {
    chunk_id: `chunk.${suffix}`,
    memory_id: memoryId,
    index_version_id: indexVersionId,
    ordinal,
    content,
    chunk_digest: contentDigest(content),
    token_count: 20,
    source_type: "memory.document",
    entity_keys: [`concept.${suffix}`],
    citation: {
      artifact_id: `artifact.${suffix}`,
      uri: `s3://retrieval-test/${suffix}.json`,
      digest: digest(suffix === "public" ? "d" : suffix === "private" ? "e" : "f"),
      locator: { section: suffix },
    },
    embedding,
    embedding_model: "embedding.integration.v1",
  } as const;
}

function parentChunk(suffix: string, memoryId: string, content: string) {
  return {
    chunk_id: `chunk.${suffix}`,
    memory_id: memoryId,
    index_version_id: "index.memory.v1",
    ordinal: 0,
    chunk_level: "parent",
    structure_path: ["Solar Output"],
    content,
    chunk_digest: contentDigest(content),
    token_count: 24,
    source_type: "memory.document",
    entity_keys: ["concept.solar"],
    citation: {
      artifact_id: `artifact.${suffix}`,
      uri: `s3://retrieval-test/${suffix}.json`,
      digest: digest("d"),
      locator: { section_path: "Solar Output", chunk_level: "parent" },
    },
  } as const;
}

function indexBuild(suffix: string, tenantId: string, watermark: string) {
  return {
    schema_version: 1,
    build_id: `build.memory.${suffix}`,
    index_version_id: `index.memory.${suffix}`,
    tenant_id: tenantId,
    logical_name: "memory.hybrid",
    index_kind: "hybrid",
    provider: "postgres",
    source_watermark: watermark,
    configuration_digest: digest("a"),
    embedding_model: "embedding.integration.v1",
    embedding_dimensions: 3,
    requested_at: "2026-08-10T08:00:00.000Z",
  } as const;
}

function indexBuildResult(
  build: ReturnType<typeof indexBuild>,
  status: "ready" | "failed",
  documentCount: number,
  chunkCount: number,
) {
  return {
    schema_version: 1,
    build_id: build.build_id,
    index_version_id: build.index_version_id,
    status,
    document_count: documentCount,
    chunk_count: chunkCount,
    source_watermark: build.source_watermark,
    completed_at: "2026-08-10T08:30:00.000Z",
    quality_report: {
      schema_version: 1,
      report_id: `quality.${build.build_id}`,
      build_id: build.build_id,
      index_version_id: build.index_version_id,
      source_watermark: build.source_watermark,
      configuration_digest: build.configuration_digest,
      passed: status === "ready",
      checks: (["structure", "source_watermark", "acl", "recall", "citation"] as const).map((name) => ({
        name,
        passed: status === "ready",
        score: status === "ready" ? 1 : 0,
        threshold: 1,
        sample_size: chunkCount,
        summary: status === "ready" ? `${name} passed` : `${name} failed`,
        evidence_refs: [],
      })),
      evaluated_at: "2026-08-10T08:30:00.000Z",
    },
    ...(status === "failed"
      ? { error: { code: "build.failed", message: "Index build failed", retryable: true } }
      : {}),
  } as const;
}

function contentDigest(content: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function secretHit(): RetrievalHit {
  return {
    id: "chunk.secret",
    content: "must not be visible",
    score: 1,
    token_count: 20,
    source_type: "memory.document",
    entity_keys: ["concept.secret"],
    citation: {
      artifact_id: "artifact.secret",
      uri: "s3://retrieval-test/secret.json",
      digest: digest("f"),
    },
  };
}

/**
 * `to_tsvector('simple', ...)` does not segment Chinese, so a Chinese sentence becomes one lexeme
 * that matches nothing. Measured on a 30720-chunk corpus before migration 018: all 32
 * natural-language queries returned zero rows, which silently degraded hybrid retrieval to
 * vector-only. This locks in the bigram path and, just as importantly, that Latin queries keep their
 * exact-token AND semantics rather than being loosened into OR.
 */
test(
  "Chinese sentences are retrievable without loosening Latin token matching",
  { skip: connectionString ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    assert.ok(connectionString);
    await migrateToLatest(connectionString);
    const db = createDatabase(connectionString);

    try {
      await sql`
        TRUNCATE TABLE
          questlab.outbox_event,
          questlab.structured_edge,
          questlab.structured_event,
          questlab.retrieval_index_version,
          questlab.memory_record
        RESTART IDENTITY CASCADE
      `.execute(db);

      const memories = new MemoryRepository(db);
      const indexes = new RetrievalIndexRepository(db);
      const indexer = new PostgresMemoryIndexer(db);
      const tenantId = "tenant.cjk";

      await memories.capture({
        memory_id: "memory.cjk",
        tenant_id: tenantId,
        owner_type: "tenant",
        owner_id: tenantId,
        scope: "tenant",
        stage: "semantic",
        kind: "fact",
        content_digest: digest("a"),
        confidence: 0.9,
        sensitivity: "internal",
        status: "active",
      });
      await memories.grant("memory.cjk", { type: "tenant", id: tenantId });

      // Lexical-only build: `indexBuild` declares an embedding model, and the indexer requires every
      // child chunk's embedding snapshot to match its index version. This test is about tokenisation,
      // so the vector columns stay out of it.
      const { embedding_model: _model, embedding_dimensions: _dimensions, ...lexicalBuild } =
        indexBuild("cjk", tenantId, "watermark.cjk");
      const build = { ...lexicalBuild, index_kind: "lexical" as const };
      const indexVersionId = build.index_version_id;
      await indexes.createBuild(build);

      const chunks = [
        { id: "chunk.cjk.tilt", content: "固定倾角与纬度的关系：最佳倾角约等于当地纬度。" },
        { id: "chunk.cjk.latin", content: "Inverter clipping begins above a DC to AC ratio of 1.3." },
        // Shares exactly one bigram ('形成') with the query about hotspots below. Bigrams cross word
        // boundaries, so this kind of accidental overlap is common and used to flood the whole result
        // list with confidently wrong documents.
        { id: "chunk.cjk.noise", content: "形成性评估的目的是调整教学，而不是给出最终成绩。" },
      ];
      for (const [ordinal, chunk] of chunks.entries()) {
        await indexer.index({
          chunk_id: chunk.id,
          memory_id: "memory.cjk",
          index_version_id: indexVersionId,
          ordinal: ordinal + 1,
          chunk_level: "child",
          content: chunk.content,
          chunk_digest: `sha256:${createHash("sha256").update(chunk.content).digest("hex")}`,
          token_count: 40,
          source_type: "text/markdown",
          entity_keys: [chunk.id],
          citation: { artifact_id: "artifact.cjk", uri: "s3://cjk/doc.md", digest: digest("c"), locator: {} },
        });
      }

      await indexes.completeBuild({ ...indexBuildResult(indexBuild("cjk", tenantId, "watermark.cjk"), "ready", 1, chunks.length) });
      await indexes.activate(indexVersionId, new Date("2026-08-10T09:00:00Z"));

      const retriever = new PostgresLexicalRetriever(db, "postgres.fts.simple.v1", "memory.hybrid");
      const search = (query: string) =>
        retriever.retrieve({
          query_id: `cjk.${query}`,
          query,
          principal: { tenant_id: tenantId },
          purpose: "learning_support",
          max_results: 10,
          filters: {},
        });

      // The whole point: a natural Chinese question now matches, where it previously returned nothing.
      const natural = await search("固定倾角应该设成多少度");
      assert.ok(natural.some((hit) => hit.id === "chunk.cjk.tilt"), "Chinese sentence must retrieve the Chinese chunk");

      // Space-separated Chinese must keep working through the plain token path.
      const tokenized = await search("倾角 纬度");
      assert.ok(tokenized.some((hit) => hit.id === "chunk.cjk.tilt"));

      // A Latin query must still require every term. "clipping ratio" both appear; "clipping banana"
      // does not, and must not match just because one term did.
      assert.ok((await search("clipping ratio")).some((hit) => hit.id === "chunk.cjk.latin"));
      assert.equal((await search("clipping banana")).length, 0);

      // A Chinese query must not drag in an unrelated Latin chunk through the OR path.
      assert.ok(!natural.some((hit) => hit.id === "chunk.cjk.latin"));

      // One accidental bigram must not qualify as a match. '热斑是怎么形成的' shares only '形成'
      // with the formative-assessment chunk, and returning it would be worse than returning nothing:
      // it fills the lexical leg with wrong documents that then compete in fusion on equal footing.
      const accidental = await search("热斑是怎么形成的");
      assert.ok(
        !accidental.some((hit) => hit.id === "chunk.cjk.noise"),
        "a single shared bigram must not count as a lexical match",
      );
    } finally {
      await db.destroy();
    }
  },
);
