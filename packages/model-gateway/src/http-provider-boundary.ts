import { ModelGatewayError } from "./errors.ts";

/**
 * Shared egress policy for outbound provider HTTP.
 *
 * Every model provider endpoint is operator-configured, so a compromised or mistyped value is an
 * SSRF and exfiltration path: HTTPS is required, URL credentials are refused, and plaintext HTTP is
 * only reachable for an explicitly enabled loopback host.
 */
export function parseProviderEndpoint(
  raw: string,
  label: string,
  allowInsecureLocalhost: boolean,
): string {
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new TypeError(`${label} endpoint must be a valid URL`);
  }
  if (endpoint.username || endpoint.password) {
    throw new TypeError(`${label} endpoint must not contain URL credentials`);
  }
  if (endpoint.protocol === "https:") return endpoint.toString();
  const local = ["localhost", "127.0.0.1", "::1"].includes(endpoint.hostname);
  if (endpoint.protocol !== "http:" || !allowInsecureLocalhost || !local) {
    throw new TypeError(
      `${label} endpoint must use HTTPS; HTTP is allowed only for explicitly enabled localhost`,
    );
  }
  return endpoint.toString();
}

/**
 * Reads a JSON body with a hard byte cap applied while streaming.
 *
 * A provider that omits `content-length` can otherwise stream unbounded bytes into the process,
 * because the declared-length check alone is advisory.
 */
export async function readBoundedJson(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<Record<string, unknown>> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ModelGatewayError("PROVIDER_ERROR", `${label} provider response exceeded the byte limit`, false);
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ModelGatewayError("PROVIDER_ERROR", `${label} provider response must use application/json`, false);
  }
  let text: string;
  if (!response.body) {
    text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new ModelGatewayError("PROVIDER_ERROR", `${label} provider response exceeded the byte limit`, false);
    }
  } else {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    let bytes = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > maxBytes) {
          throw new ModelGatewayError("PROVIDER_ERROR", `${label} provider response exceeded the byte limit`, false);
        }
        chunks.push(decoder.decode(next.value, { stream: true }));
      }
      chunks.push(decoder.decode());
    } catch (error) {
      // Headers can arrive well before the body finishes. A request signal that fires during the
      // body stream aborts the reader here, not at `fetch`, so without this branch the raw
      // `DOMException: The operation was aborted due to timeout` escapes the gateway untranslated:
      // callers see neither a TIMEOUT code nor a retryable flag, and the audit ledger records
      // nothing. Observed while embedding 64 chunks of 2048 dimensions (~3MB of JSON floats),
      // where body transfer dominates the request.
      if (error instanceof ModelGatewayError) throw error;
      const aborted = error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
      throw new ModelGatewayError(
        aborted ? "TIMEOUT" : "PROVIDER_ERROR",
        aborted
          ? `${label} provider response timed out while streaming the body`
          : `${label} provider response could not be read`,
        true,
        { cause: error instanceof Error ? error : undefined },
      );
    } finally {
      reader.releaseLock();
    }
    text = chunks.join("");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ModelGatewayError("PROVIDER_ERROR", `${label} provider returned invalid JSON`, false);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ModelGatewayError("PROVIDER_ERROR", `${label} provider returned an invalid payload`, false);
  }
  return value as Record<string, unknown>;
}
