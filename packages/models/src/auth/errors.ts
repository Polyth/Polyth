import type { AuthErrorCode, AuthErrorDto } from "@polyth/contracts";

const AUTH_CODES = new Set<AuthErrorCode>([
  "AUTH_CAPABILITY_UNAVAILABLE",
  "AUTH_DISCOVERY_FAILED",
  "AUTH_METHOD_UNAVAILABLE",
  "AUTH_INPUT_INVALID",
  "AUTH_CREDENTIAL_INVALID",
  "AUTH_DENIED",
  "AUTH_EXPIRED",
  "AUTH_CALLBACK_FAILED",
  "AUTH_SAVE_FAILED",
  "AUTH_SESSION_STALE",
  "AUTH_RUNTIME_RESTARTED",
  "AUTH_REMOTE_LOOPBACK_UNREACHABLE",
  "AUTH_PROVIDER_UNREACHABLE",
  "AUTH_RATE_LIMITED",
  "AUTH_NETWORK_ERROR",
  "AUTH_PROVIDER_PROTOCOL_CHANGED",
  "AUTH_WELLKNOWN_UNSAFE",
  "AUTH_CANCELLED",
]);

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{8,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\b(access_token|refresh_token|id_token|client_secret|code_verifier|api[_-]?key|password)\s*[:=]\s*\S+/gi,
  /[?&](code|token|access_token|refresh_token|client_secret|code_verifier)=[^&\s]+/gi,
];

export const isAuthErrorCode = (value: string): value is AuthErrorCode => AUTH_CODES.has(value as AuthErrorCode);

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Exact known secrets first, then heuristic patterns as defense-in-depth. */
export const redactSecrets = (value: string, exact: readonly string[] = []): string => {
  let out = value;
  const unique = [...new Set(exact.filter((item) => item.length > 0))].sort((a, b) => b.length - a.length);
  for (const secret of unique) {
    out = out.split(secret).join("[redacted]");
    if (secret.length >= 4) {
      out = out.replace(new RegExp(escapeRegExp(secret), "g"), "[redacted]");
    }
  }
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
};

const USER_MESSAGES: Readonly<Record<AuthErrorCode, string>> = {
  AUTH_CAPABILITY_UNAVAILABLE: "This provider’s sign-in methods are not available on the current runtime.",
  AUTH_DISCOVERY_FAILED: "Could not load sign-in methods for this provider.",
  AUTH_METHOD_UNAVAILABLE: "This sign-in method is temporarily unavailable.",
  AUTH_INPUT_INVALID: "Check the required fields and try again.",
  AUTH_CREDENTIAL_INVALID: "Those credentials were rejected. Check them and try again.",
  AUTH_DENIED: "Sign-in was denied.",
  AUTH_EXPIRED: "This authorization expired. Start again to get a new code.",
  AUTH_CALLBACK_FAILED: "Could not finish authorization.",
  AUTH_SAVE_FAILED: "Credentials could not be saved.",
  AUTH_SESSION_STALE: "Sign-in session expired or is no longer active.",
  AUTH_RUNTIME_RESTARTED: "The model runtime restarted during sign-in. Start again.",
  AUTH_REMOTE_LOOPBACK_UNREACHABLE: "This login expects a browser on the same machine as the runtime.",
  AUTH_PROVIDER_UNREACHABLE: "The provider could not be reached.",
  AUTH_RATE_LIMITED: "The provider asked us to slow down. Wait a moment and retry.",
  AUTH_NETWORK_ERROR: "A network error interrupted sign-in.",
  AUTH_PROVIDER_PROTOCOL_CHANGED: "The provider’s sign-in methods changed. Reload methods and try again.",
  AUTH_WELLKNOWN_UNSAFE: "That organization login document is not safe to use.",
  AUTH_CANCELLED: "Sign-in was cancelled.",
};

export const authError = (
  code: AuthErrorCode,
  options: { details?: string; field?: string; message?: string; secrets?: readonly string[] } = {},
): AuthErrorDto => ({
  code,
  message: options.message ?? USER_MESSAGES[code],
  ...(options.details ? { details: redactSecrets(options.details, options.secrets ?? []).slice(0, 800) } : {}),
  ...(options.field ? { field: options.field } : {}),
});

export const mapUpstreamAuthError = (error: unknown, secrets: readonly string[] = []): AuthErrorDto => {
  const err = error as { code?: unknown; message?: unknown; field?: unknown; status?: unknown };
  const raw = typeof err?.message === "string" ? err.message : String(error ?? "unknown error");
  const details = redactSecrets(raw, secrets);
  const rawCode = typeof err?.code === "string" ? err.code : "";
  const status = typeof err?.status === "number" ? err.status : undefined;
  const field = typeof err?.field === "string" ? err.field : undefined;
  const lower = raw.toLowerCase();

  if (isAuthErrorCode(rawCode)) return authError(rawCode, { details, ...(field ? { field } : {}), secrets });
  if (rawCode.startsWith("AUTH_")) return authError("AUTH_CALLBACK_FAILED", { details, ...(field ? { field } : {}), secrets });
  if (rawCode === "unsupported" || rawCode === "capability-unsupported") {
    return authError("AUTH_CAPABILITY_UNAVAILABLE", { details, secrets });
  }
  if (rawCode === "invalid-input" || /invalid (input|code|key)/i.test(raw)) {
    return authError("AUTH_INPUT_INVALID", { details, ...(field ? { field } : {}), secrets });
  }
  if (status === 401 || /invalid (api )?key|unauthorized|credential/i.test(lower)) {
    return authError("AUTH_CREDENTIAL_INVALID", { details, secrets });
  }
  if (status === 403 || /\bdenied\b|access_denied|user cancelled|canceled/i.test(lower)) {
    return authError("AUTH_DENIED", { details, secrets });
  }
  if (status === 429 || /rate limit/i.test(lower)) return authError("AUTH_RATE_LIMITED", { details, secrets });
  if (/expired|expir/i.test(lower)) return authError("AUTH_EXPIRED", { details, secrets });
  if (/stale|superseded/i.test(lower)) return authError("AUTH_SESSION_STALE", { details, secrets });
  if (/terminated|econnrefused|fetch failed|reconnect/i.test(lower)) {
    return authError("AUTH_RUNTIME_RESTARTED", { details, secrets });
  }
  if (rawCode === "unavailable") return authError("AUTH_PROVIDER_UNREACHABLE", { details, secrets });
  if (status === 404 || rawCode.startsWith("http-404")) return authError("AUTH_METHOD_UNAVAILABLE", { details, secrets });
  if (status !== undefined && status >= 500) return authError("AUTH_PROVIDER_UNREACHABLE", { details, secrets });
  if (/network|enotfound|etimedout/i.test(lower)) return authError("AUTH_NETWORK_ERROR", { details, secrets });
  return authError("AUTH_CALLBACK_FAILED", { details, secrets });
};

export const throwAuthError = (error: AuthErrorDto, secrets: readonly string[] = []): never => {
  const safe = authError(error.code, {
    message: error.message,
    ...(error.details ? { details: error.details } : {}),
    ...(error.field ? { field: error.field } : {}),
    secrets,
  });
  throw Object.assign(new Error(safe.message), {
    code: safe.code,
    ...(safe.details ? { details: safe.details } : {}),
    ...(safe.field ? { field: safe.field } : {}),
  });
};
