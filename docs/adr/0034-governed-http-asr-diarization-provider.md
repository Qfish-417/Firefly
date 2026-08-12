# ADR 0034: Govern ASR and diarization as a versioned audio provider

## Status

Accepted

## Context

The canonical transcript parser accepts normalized JSON, but audio artifacts still lacked a real provider boundary. ASR and speaker-diarization vendors expose incompatible identities, timestamps and confidence semantics. Passing object-store URLs or provider-native responses into indexing would leak storage authority and make media citations unstable.

## Decision

Add `HttpAsrDiarizationParser` as a fixed-endpoint adapter. It accepts only hydrated audio bytes whose SHA-256 digest matches the immutable Artifact Citation. Source MIME and byte size are allowlisted and bounded. Requests use multipart data so immutable metadata and source bytes remain distinct. HTTPS is mandatory except for explicitly enabled localhost development; redirects, URL credentials and reserved transport-header overrides are rejected.

Responses declare `schema_version: 1` and `contract: firefly.asr-diarization.v1`, echo the input digest and identify the provider plus optional model/version. They include diarization state, bounded audio duration and turns ordered contiguously from one. Each turn carries unique identity, explicit speaker identity, non-empty text, ordered millisecond offsets within the source duration, confidence in `[0,1]` and optional language. A response with diarization disabled cannot claim multiple speakers. Response bytes, turns, speakers and text are bounded.

Validated output becomes `IndexConversationSource`. Speaker labels never imply user/assistant roles, and relative media offsets are not converted into manufactured wall-clock timestamps. `ConversationTurnChunker` propagates media range, minimum confidence, language, provider/model lineage and diarization state into Citation locators.

## Consequences

- ASR and diarization vendors remain replaceable behind one deterministic contract.
- Providers receive verified bytes rather than object-store credentials or arbitrary fetch URLs.
- Audio evidence can cite exact replay ranges and retain derived-model quality provenance.
- Concrete engines, credentials, data residency, retention, cost controls and human review remain deployment concerns.
- Empty speech, inconsistent diarization, unstable ordering and invalid timing fail closed.
