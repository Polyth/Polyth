export type WebSearchErrorCode =
  | "aborted"
  | "auth-required"
  | "conflict"
  | "fetch-blocked"
  | "fetch-failed"
  | "fetch-http-error"
  | "fetch-too-large"
  | "fetch-unsupported"
  | "forbidden"
  | "invalid-input"
  | "provider-invalid-response"
  | "provider-unavailable"
  | "rate-limited"
  | "storage-unavailable"
  | "tavily-plan-exhausted"
  | "unavailable";

export function webSearchError(code: WebSearchErrorCode, message: string): Error {
  return Object.assign(new Error(message), { code });
}

const ERROR_CODES = new Set<WebSearchErrorCode>([
  "aborted",
  "auth-required",
  "conflict",
  "fetch-blocked",
  "fetch-failed",
  "fetch-http-error",
  "fetch-too-large",
  "fetch-unsupported",
  "forbidden",
  "invalid-input",
  "provider-invalid-response",
  "provider-unavailable",
  "rate-limited",
  "storage-unavailable",
  "tavily-plan-exhausted",
  "unavailable",
]);

export function webSearchErrorCode(cause: unknown): WebSearchErrorCode | undefined {
  if (!cause || typeof cause !== "object") return undefined;
  const code = (cause as { code?: unknown }).code;
  return typeof code === "string" && ERROR_CODES.has(code as WebSearchErrorCode)
    ? code as WebSearchErrorCode
    : undefined;
}

export function isAutomaticFallbackError(cause: unknown): boolean {
  const code = webSearchErrorCode(cause);
  return code === "auth-required"
    || code === "provider-unavailable"
    || code === "provider-invalid-response"
    || code === "rate-limited"
    || code === "tavily-plan-exhausted";
}
