# Agent API, token and activity monitoring

## Purpose and boundary

This subsystem monitors the three business Agents: `learning-director`, `learning-scientist` and `experience-engineer`.

It is deliberately split into a deterministic ledger and a read-only Audit Agent. The ledger records facts. The Audit Agent derives summaries and alerts. The Audit Agent is not part of the business delegation graph and has no workflow mutation, tool execution or model-generation capability.

## Data flow

```text
Business Agent
  -> Model Gateway request with run/task/Agent attribution
  -> pi-ai provider attempt
  -> privacy-preserving ModelInvocationRecord
  -> PostgreSQL model_invocation + atomic run_budget_usage increment
  -> AuditAgent joins workflow trace and invocation ledger
  -> localhost Admin API
```

One record represents one provider attempt, not one logical request. A fallback or retry therefore increases `model_calls`, and attempts after the first increase `retry_calls`. This is intentional because each attempt can consume time, tokens or money.

## Persisted fields

The ledger stores provider/model/route, capability, attempt status, timestamps, latency, token categories, micro-USD cost, billing source, error metadata, run/task/Agent/user/tenant attribution and immutable prompt/tool/knowledge/model/routing snapshot IDs.

It does not store system or user prompt text, model response text, hidden reasoning, API keys, authorization headers, or retrieved document contents. The activity log records task type, Agent, state, timestamps and accounting metadata. Artifact contents remain behind their existing ACL and Citation boundaries.

## API

Start the existing Admin server after migration:

```powershell
$env:DATABASE_URL = "postgresql://questlab:questlab@127.0.0.1:55432/questlab"
npm run db:migrate
npm run admin:start
```

Global Agent totals are available at `GET /admin/audit/agents`. A run report with totals, Agent breakdown, alerts and redacted activity is available at `GET /admin/audit/runs/{run_id}`.

Costs use `total_cost_microusd`; divide by 1,000,000 for USD. `cached_input_tokens` remains separate while also contributing to the provider-reported `total_tokens` value.

## Alert semantics

| Code | Severity | Condition |
|---|---|---|
| `model_failures` | warning | At least one persisted provider attempt failed |
| `model_retries` | info | At least one attempt number is greater than one |
| `telemetry_gap` | critical | An Agent result says a model ran but no invocation exists for its task |
| `budget_warning` | warning | Persisted model cost reaches 70 percent of run maximum |
| `budget_critical` | critical | Persisted model cost reaches 90 percent of run maximum |

Threshold alerts are deterministic projections, not autonomous decisions. They do not cancel a run. Budget enforcement remains in the Model Gateway and Governance layer.

## Build and extension rules

All model-backed Agent code must attach `run_id`, `task_id`, `agent_id` and `origin=business_agent`. New provider adapters must report normalized usage through the Model Gateway rather than writing the database directly. Replays must preserve the same invocation identity and accounting values.

Before exposing the Admin API beyond localhost, add authenticated operator identity, tenant-scoped query predicates, response audit logging, rate limits and an explicit retention policy. A dashboard or metrics exporter should consume the read-only service; it must not become a second accounting source.

Verification:

```powershell
npm run check
$env:TEST_DATABASE_URL = $env:DATABASE_URL
npm run test:integration
```

The PostgreSQL integration test covers atomic usage settlement, replay idempotency and identity conflicts. Unit tests cover Agent attribution, gateway redaction, report alerts and Admin routes.
