export type ModelCapability = "generate" | "stream" | "embed" | "rerank";

export interface ModelTarget {
  readonly provider: string;
  readonly model: string;
}

export interface ModelRoute extends ModelTarget {
  readonly route_id: string;
  readonly transport_id: string;
  readonly capabilities: readonly ModelCapability[];
}

export interface RouteRetryPolicy {
  readonly max_attempts: number;
  readonly initial_backoff_ms: number;
  readonly max_backoff_ms: number;
}

export interface ModelRoutingPolicy {
  readonly snapshot: string;
  readonly routes: Readonly<Record<string, readonly ModelRoute[]>>;
  readonly retry: RouteRetryPolicy;
  readonly attempt_timeout_ms: number;
}

export interface ModelBudget {
  readonly max_tokens: number;
  readonly max_cost_usd: number;
  readonly max_duration_ms: number;
}

export interface CustomModelDefinition {
  readonly id: string;
  readonly name?: string;
  readonly context_window: number;
  readonly max_output_tokens: number;
  readonly input_cost_per_million: number;
  readonly output_cost_per_million: number;
  /**
   * Prompt-cache pricing. Hardcoding these to 0 makes cached spend invisible in the billing ledger,
   * which understates real cost and lets a run exceed its budget without the cap noticing. Defaults
   * to `input_cost_per_million` when the relay does not publish separate cache rates.
   */
  readonly cache_read_cost_per_million?: number;
  readonly cache_write_cost_per_million?: number;
  readonly reasoning?: boolean;
}

export interface CustomModelProviderConfiguration {
  readonly id: string;
  readonly name?: string;
  readonly base_url: string;
  readonly api: "openai-completions" | "openai-responses";
  readonly api_key_env?: string;
  readonly allow_insecure_localhost?: boolean;
  /**
   * Extra fields merged into every request body sent to this provider.
   *
   * For vendor extensions that the portable OpenAI subset does not model. The main case is telling a
   * self-hosted reasoning model not to emit its chain of thought into `content`, which otherwise
   * breaks Agents that require strict JSON (measured with vLLM + Qwen3.5-4B:
   * `{"reasoning_effort":"none"}` turns an unparsable `Thinking Process:` reply into valid JSON).
   *
   * Fields the gateway already set win, so this cannot rewrite how a call was framed.
   */
  readonly request_parameters?: Readonly<Record<string, unknown>>;
  readonly models: readonly CustomModelDefinition[];
}

export interface InputSnapshots {
  readonly prompt: string;
  readonly tools: string;
  readonly knowledge: string;
}

export interface InvocationAttribution {
  readonly run_id?: string;
  readonly task_id?: string;
  readonly agent_id?: "learning-director" | "learning-scientist" | "experience-engineer" | "audit-agent";
  readonly tenant_id?: string;
  readonly user_id?: string;
  readonly origin: "business_agent" | "audit_agent" | "system";
}

export interface GenerationRequest {
  readonly request_id: string;
  readonly workload: string;
  readonly system_prompt: string;
  readonly user_prompt: string;
  readonly max_output_tokens: number;
  readonly budget: ModelBudget;
  readonly snapshots: InputSnapshots;
  readonly attribution?: InvocationAttribution;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
}

export interface ModelUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cached_input_tokens: number;
  readonly total_tokens: number;
  readonly cost_usd: number;
}

export interface ExecutionSnapshotSet extends InputSnapshots {
  readonly model: string;
  readonly routing: string;
}

export interface GenerationResult {
  readonly request_id: string;
  readonly text: string;
  readonly finish_reason: "stop" | "length";
  readonly route_id: string;
  readonly usage: ModelUsage;
  readonly latency_ms: number;
  readonly snapshots: ExecutionSnapshotSet;
}

export type ModelInvocationStatus = "succeeded" | "failed";

/** A privacy-preserving record for one provider attempt. Raw prompts are never included. */
export interface ModelInvocationRecord {
  readonly invocation_id: string;
  readonly request_id: string;
  readonly workload: string;
  readonly capability: "generate" | "stream" | "embed" | "rerank";
  readonly route_id: string;
  readonly transport_id: string;
  readonly provider: string;
  readonly model: string;
  readonly attempt: number;
  readonly status: ModelInvocationStatus;
  readonly started_at_ms: number;
  readonly completed_at_ms: number;
  readonly latency_ms: number;
  readonly usage?: ModelUsage;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
  readonly attribution?: InvocationAttribution;
  readonly snapshots: {
    readonly prompt: string;
    readonly tools: string;
    readonly knowledge: string;
    readonly model?: string;
    readonly routing?: string;
  };
}

export interface ModelInvocationObserver {
  record(record: ModelInvocationRecord): void | Promise<void>;
}

export type GenerationStreamEvent =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "completed"; readonly result: GenerationResult };

export interface ModelDescriptor extends ModelTarget {
  readonly api: string;
  readonly context_window: number;
  readonly max_output_tokens: number;
  readonly input_cost_per_million: number;
  readonly output_cost_per_million: number;
  readonly snapshot: string;
}

export interface TransportCall extends GenerationRequest {
  readonly target: ModelTarget;
  readonly effective_max_output_tokens: number;
  readonly timeout_ms: number;
}

export interface TransportGenerationResult {
  readonly text: string;
  readonly finish_reason: "stop" | "length";
  readonly usage: ModelUsage;
}

export type TransportStreamEvent =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "completed"; readonly result: TransportGenerationResult };

export interface GenerationTransport {
  readonly id: string;
  describe(target: ModelTarget): ModelDescriptor;
  generate(call: TransportCall): Promise<TransportGenerationResult>;
  stream(call: TransportCall): AsyncIterable<TransportStreamEvent>;
}

export interface TextGenerationPort {
  generate(request: GenerationRequest): Promise<GenerationResult>;
  stream(request: GenerationRequest): AsyncIterable<GenerationStreamEvent>;
}

export interface EmbeddingRequest {
  readonly request_id: string;
  readonly workload: string;
  readonly inputs: readonly string[];
  readonly budget: ModelBudget;
  readonly signal?: AbortSignal;
}

export interface EmbeddingResult {
  readonly vectors: readonly (readonly number[])[];
  readonly usage: ModelUsage;
}

export interface EmbeddingPort {
  embed(request: EmbeddingRequest): Promise<EmbeddingResult>;
}

export interface RerankRequest {
  readonly request_id: string;
  readonly workload: string;
  readonly query: string;
  readonly documents: readonly string[];
  readonly top_k: number;
  readonly budget: ModelBudget;
  readonly signal?: AbortSignal;
}

export interface RerankResult {
  readonly rankings: readonly { readonly index: number; readonly score: number }[];
  readonly usage: ModelUsage;
}

export interface RerankPort {
  rerank(request: RerankRequest): Promise<RerankResult>;
}
