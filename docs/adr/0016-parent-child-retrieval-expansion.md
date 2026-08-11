# ADR 0016: Recall child chunks and expand governed parent context

- Status: accepted
- Date: 2026-08-11

## Context

Small chunks improve lexical and vector recall, but often omit the section context needed to interpret a result. Indexing large sections directly increases embedding cost, reduces retrieval precision and makes a fixed TopK consume an unpredictable context budget. Expanding a recalled child into a parent also creates a second authorization boundary: the parent must not become visible merely because one of its children was returned.

## Decision

Represent Markdown sources with two explicit chunk levels. A `parent` stores a complete section and its structural path. A `child` stores retrieval-sized content and references a parent in the same Memory and retrieval index version. Migration 010 adds `chunk_level`, `parent_chunk_id` and `structure_path`, plus database constraints and a composite foreign key that prevent cross-Memory or cross-version parent references.

`MarkdownParentChildChunker` derives sections from Markdown heading hierarchy and emits deterministic ordinals, stable IDs and structural citation locators. A length-bounded heading path is included in child retrieval text so a concept present only in a heading remains searchable. Parent chunks never carry embeddings. Only child chunks are embedded and only child chunks participate in PostgreSQL FTS and pgvector recall. The structural ready gate requires at least one retrievable child per document, valid parent-child relationships, no parent embeddings and at least one child for every parent.

Expansion occurs after rank fusion, child authorization and dynamic evidence selection. `PostgresParentChildExpander` loads the selected child's parent only from the active index, rechecks tenant and Memory ACL, and preserves immutable evidence identities. The Retrieval Gateway independently reauthorizes expanded evidence, deduplicates parents shared by multiple children and rejects expanders that exceed the context token budget. If a parent does not fit in the remaining budget, the authorized child remains in the EvidencePack.

Plain-text chunking remains a compatibility mode. This decision implements structural chunking only for Markdown; PDF layout, code AST, tables, conversations and multimodal region chunkers require separate implementations behind the same contract.

## Consequences

- Recall precision and generation context can evolve independently without pretending TopK is fixed.
- Parent content cannot enter retrieval through an embedding or FTS match.
- Expansion cannot bypass active-index, tenant, Memory ACL or token-budget boundaries.
- Multiple selected children can share one parent without duplicating context.
- Parent storage increases index size, while embedding cost remains limited to children.
- Neighbor, entity, temporal and region expansion remain future governed expansion strategies.
