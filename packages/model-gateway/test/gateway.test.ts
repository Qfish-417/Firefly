import assert from "node:assert/strict";
import test from "node:test";

import {
  ModelGatewayError,
  RoutedModelGateway,
  type GenerationRequest,
  type GenerationStreamEvent,
  type GenerationTransport,
  type ModelDescriptor,
  type ModelRoutingPolicy,
  type ModelTarget,
  type TransportCall,
  type TransportGenerationResult,
  type TransportStreamEvent,
} from "../src/index.ts";

const usage = {
  input_tokens: 20,
  output_tokens: 10,
  cached_input_tokens: 0,
  total_tokens: 30,
  cost_usd: 0.001,
} as const;

const baseRequest: GenerationRequest = {
  request_id: "model-request.unit",
  workload: "learning-scientist.analyze",
  system_prompt: "Return JSON.",
  user_prompt: "Analyze evidence.",
  max_output_tokens: 200,
  budget: { max_tokens: 500, max_cost_usd: 0.1, max_duration_ms: 10_000 },
  snapshots: {
    prompt: "prompt:test:v1",
    tools: "tools:none:v1",
    knowledge: "knowledge:test:v1",
  },
};

test("gateway falls back to the next route after a retryable provider error", async () => {
  const failing = new FakeTransport("first", async () => {
    throw new ModelGatewayError("PROVIDER_ERROR", "provider unavailable", true);
  });
  const succeeding = new FakeTransport("second", async () => ({
    text: "{\"ok\":true}",
    finish_reason: "stop",
    usage,
  }));
  const gateway = new RoutedModelGateway({
    policy: policy([
      route("route.first", "first", "provider-a", "model-a"),
      route("route.second", "second", "provider-b", "model-b"),
    ]),
    transports: [failing, succeeding],
    wait: async () => undefined,
  });

  const result = await gateway.generate(baseRequest);

  assert.equal(result.route_id, "route.second");
  assert.equal(result.snapshots.model, "model:provider-b/model-b:v1");
  assert.equal(failing.calls, 1);
  assert.equal(succeeding.calls, 1);
});

test("gateway skips an unavailable catalog model and uses the next configured route", async () => {
  const unavailable = new MissingModelTransport("missing");
  const succeeding = new FakeTransport("second", async () => ({
    text: "fallback",
    finish_reason: "stop",
    usage,
  }));
  const gateway = new RoutedModelGateway({
    policy: policy([
      route("route.missing", "missing", "provider-a", "removed-model"),
      route("route.second", "second", "provider-b", "model-b"),
    ]),
    transports: [unavailable, succeeding],
  });

  assert.equal((await gateway.generate(baseRequest)).route_id, "route.second");
});

test("gateway rejects a request before provider execution when no route fits cost budget", async () => {
  const transport = new FakeTransport("only", async () => ({
    text: "unused",
    finish_reason: "stop",
    usage,
  }), 1000, 1000);
  const gateway = new RoutedModelGateway({
    policy: policy([route("route.expensive", "only", "provider-a", "model-a")]),
    transports: [transport],
  });

  await assert.rejects(
    gateway.generate({ ...baseRequest, budget: { ...baseRequest.budget, max_cost_usd: 0.000001 } }),
    (error: unknown) => error instanceof ModelGatewayError && error.code === "BUDGET_EXCEEDED",
  );
  assert.equal(transport.calls, 0);
});

test("stream fallback is allowed only before any text is emitted", async () => {
  const transport = new FakeTransport(
    "streaming",
    async () => ({ text: "unused", finish_reason: "stop", usage }),
    1,
    1,
    async function* () {
      yield { type: "text_delta", text: "partial" };
      throw new ModelGatewayError("PROVIDER_ERROR", "connection lost", true);
    },
  );
  const gateway = new RoutedModelGateway({
    policy: policy([route("route.streaming", "streaming", "provider-a", "model-a")]),
    transports: [transport],
  });

  const consume = async () => {
    for await (const _event of gateway.stream(baseRequest)) {
      // Consume until the stream reports its terminal failure.
    }
  };
  await assert.rejects(
    consume(),
    (error: unknown) => error instanceof ModelGatewayError && error.code === "PARTIAL_STREAM_FAILURE",
  );
});

test("successful stream ends after its completed event", async () => {
  const transport = new FakeTransport("streaming", async () => ({
    text: "complete",
    finish_reason: "stop",
    usage,
  }));
  const gateway = new RoutedModelGateway({
    policy: policy([route("route.streaming", "streaming", "provider-a", "model-a")]),
    transports: [transport],
  });
  const events: GenerationStreamEvent[] = [];

  for await (const event of gateway.stream(baseRequest)) {
    events.push(event);
  }

  assert.deepEqual(events.map((event) => event.type), ["text_delta", "completed"]);
});

test("embed and rerank remain explicit unavailable capabilities without providers", async () => {
  const gateway = new RoutedModelGateway({ policy: policy([]), transports: [] });
  await assert.rejects(
    gateway.embed({
      request_id: "embed.unit",
      workload: "memory.embed",
      inputs: ["text"],
      budget: baseRequest.budget,
    }),
    (error: unknown) => error instanceof ModelGatewayError && error.code === "CAPABILITY_UNAVAILABLE",
  );
  await assert.rejects(
    gateway.rerank({
      request_id: "rerank.unit",
      workload: "memory.rerank",
      query: "question",
      documents: ["document"],
      top_k: 1,
      budget: baseRequest.budget,
    }),
    (error: unknown) => error instanceof ModelGatewayError && error.code === "CAPABILITY_UNAVAILABLE",
  );
});

class FakeTransport implements GenerationTransport {
  calls = 0;
  readonly id: string;
  private readonly handler: (call: TransportCall) => Promise<TransportGenerationResult>;
  private readonly inputCost: number;
  private readonly outputCost: number;
  private readonly streamHandler:
    | ((call: TransportCall) => AsyncIterable<TransportStreamEvent>)
    | undefined;

  constructor(
    id: string,
    handler: (call: TransportCall) => Promise<TransportGenerationResult>,
    inputCost = 1,
    outputCost = 1,
    streamHandler?: (call: TransportCall) => AsyncIterable<TransportStreamEvent>,
  ) {
    this.id = id;
    this.handler = handler;
    this.inputCost = inputCost;
    this.outputCost = outputCost;
    this.streamHandler = streamHandler;
  }

  describe(target: ModelTarget): ModelDescriptor {
    return {
      ...target,
      api: "fake",
      context_window: 10_000,
      max_output_tokens: 2_000,
      input_cost_per_million: this.inputCost,
      output_cost_per_million: this.outputCost,
      snapshot: `model:${target.provider}/${target.model}:v1`,
    };
  }

  generate(call: TransportCall): Promise<TransportGenerationResult> {
    this.calls += 1;
    return this.handler(call);
  }

  stream(call: TransportCall): AsyncIterable<TransportStreamEvent> {
    this.calls += 1;
    if (this.streamHandler) {
      return this.streamHandler(call);
    }
    const handler = this.handler;
    return (async function* () {
      const result = await handler(call);
      yield { type: "text_delta", text: result.text } as const;
      yield { type: "completed", result } as const;
    })();
  }
}

class MissingModelTransport implements GenerationTransport {
  readonly id: string;

  constructor(id: string) {
    this.id = id;
  }

  describe(_target: ModelTarget): ModelDescriptor {
    throw new ModelGatewayError("MODEL_NOT_FOUND", "model removed from catalog", false);
  }

  generate(_call: TransportCall): Promise<TransportGenerationResult> {
    throw new Error("unavailable route must not execute");
  }

  async *stream(_call: TransportCall): AsyncIterable<TransportStreamEvent> {
    throw new Error("unavailable route must not execute");
  }
}

function route(routeId: string, transportId: string, provider: string, model: string) {
  return {
    route_id: routeId,
    transport_id: transportId,
    provider,
    model,
    capabilities: ["generate", "stream"] as const,
  };
}

function policy(routes: readonly ReturnType<typeof route>[]): ModelRoutingPolicy {
  return {
    snapshot: "routing:test:v1",
    routes: { "learning-scientist.analyze": routes },
    retry: { max_attempts: 1, initial_backoff_ms: 0, max_backoff_ms: 0 },
    attempt_timeout_ms: 5_000,
  };
}
