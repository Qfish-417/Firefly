import type { ModelUsage } from "./types.ts";

export type ModelGatewayErrorCode =
  | "INVALID_REQUEST"
  | "ROUTE_NOT_FOUND"
  | "MODEL_NOT_FOUND"
  | "CAPABILITY_UNAVAILABLE"
  | "AUTH_FAILED"
  | "BUDGET_EXCEEDED"
  | "PROVIDER_ERROR"
  | "PROVIDER_TOOL_CALL_FORBIDDEN"
  | "TIMEOUT"
  | "CANCELED"
  | "PARTIAL_STREAM_FAILURE";

export interface ModelGatewayErrorOptions extends ErrorOptions {
  /**
   * Usage the provider already reported and will bill for. Attached whenever a call is rejected
   * *after* the provider produced a response, so the audit ledger can still settle the spend.
   */
  readonly usage?: ModelUsage;
}

export class ModelGatewayError extends Error {
  readonly code: ModelGatewayErrorCode;
  readonly retryable: boolean;
  readonly usage?: ModelUsage;

  constructor(
    code: ModelGatewayErrorCode,
    message: string,
    retryable: boolean,
    options?: ModelGatewayErrorOptions,
  ) {
    super(message, options);
    this.name = "ModelGatewayError";
    this.code = code;
    this.retryable = retryable;
    if (options?.usage) {
      this.usage = options.usage;
    }
  }
}

/** HTTP statuses that must never be retried and must never fail over to another provider. */
const failClosedStatuses = new Map<number, ModelGatewayErrorCode>([
  [400, "INVALID_REQUEST"],
  [401, "AUTH_FAILED"],
  [403, "AUTH_FAILED"],
  [404, "MODEL_NOT_FOUND"],
  [422, "INVALID_REQUEST"],
]);

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
  const failClosed = failClosedStatuses.get(httpStatus(error, message) ?? 0);
  if (failClosed) {
    return new ModelGatewayError(failClosed, message, false, {
      cause: error instanceof Error ? error : undefined,
    });
  }
  return new ModelGatewayError("PROVIDER_ERROR", message, true, {
    cause: error instanceof Error ? error : undefined,
  });
}

/**
 * pi-ai flattens the provider response into a message string, so an explicit status field is
 * preferred and a leading `HTTP <code>` / `<code> <text>` prefix is the documented fallback.
 */
function httpStatus(error: unknown, message: string): number | undefined {
  if (typeof error === "object" && error !== null) {
    for (const field of ["status", "statusCode", "http_status"] as const) {
      const value = (error as Record<string, unknown>)[field];
      if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) {
        return value;
      }
    }
  }
  const match = /^(?:HTTP\s+)?([1-5]\d{2})\b/u.exec(message.trim());
  return match ? Number(match[1]) : undefined;
}
