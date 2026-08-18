# ADR 0045: Govern OpenAI-compatible model relays as configured pi-ai providers

## Context

The built-in pi-ai catalog covers many hosted providers, but deployments often use an OpenAI-compatible relay, an enterprise gateway, Ollama, vLLM or SGLang. Treating every relay as the built-in `openai` provider would lose endpoint identity, model pricing and authentication ownership. A per-request arbitrary URL would also create an SSRF and data-egress boundary.

## Decision

Add `FIREFLY_MODEL_PROVIDERS` as a configuration-only custom Provider registry. Each entry declares a stable provider ID, fixed base URL, one supported OpenAI wire API (`openai-completions` or `openai-responses`), an optional environment-variable name for the API key, and explicit text model metadata including context, output and price limits.

Custom Providers are materialized through pi-ai `createProvider()` and enter the same `Models` collection as built-ins. FireFly routing, retries, budgets, snapshots, model invocation attribution and audit settlement remain unchanged.

Remote custom endpoints must use HTTPS and cannot contain credentials, query strings or fragments. HTTP is accepted only for `localhost`, `127.0.0.1` or `::1` when `allow_insecure_localhost=true`. Provider IDs cannot replace built-in IDs or another custom Provider. API keys are referenced by environment-variable name and never serialized into routes, snapshots or reports.

The current custom registry is text-first. Image input, model-native tool calls and provider-specific extensions remain outside this boundary. Embedding, reranking, OCR and ASR continue to use their separate governed ports.

## Consequences

- Arbitrary OpenAI-compatible relays can be onboarded without writing a new transport.
- Model pricing and limits are explicit, allowing FireFly budgets and audit reports to remain meaningful.
- The relay still receives prompts and retrieved text; operators must trust its retention and privacy policy.
- A real smoke call remains a separate explicit operation. `model:doctor` only checks catalog, protocol, text support and credential presence and never incurs a model charge.
- Non-OpenAI-compatible protocols still require a dedicated `GenerationTransport`.
