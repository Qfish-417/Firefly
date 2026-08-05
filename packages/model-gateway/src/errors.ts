export type ModelGatewayErrorCode =
  | "INVALID_REQUEST"
  | "ROUTE_NOT_FOUND"
  | "MODEL_NOT_FOUND"
  | "CAPABILITY_UNAVAILABLE"
  | "BUDGET_EXCEEDED"
  | "PROVIDER_ERROR"
  | "PROVIDER_TOOL_CALL_FORBIDDEN"
  | "TIMEOUT"
  | "CANCELED"
  | "PARTIAL_STREAM_FAILURE";

export class ModelGatewayError extends Error {
  readonly code: ModelGatewayErrorCode;
  readonly retryable: boolean;

  constructor(
    code: ModelGatewayErrorCode,
    message: string,
    retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ModelGatewayError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function normalizeModelError(error: unknown): ModelGatewayError {
  if (error instanceof ModelGatewayError) {
    return error;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return new ModelGatewayError("CANCELED", error.message || "Model request was canceled", false, {
      cause: error,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ModelGatewayError("PROVIDER_ERROR", message, true, {
    cause: error instanceof Error ? error : undefined,
  });
}
