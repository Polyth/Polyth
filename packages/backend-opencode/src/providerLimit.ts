// Classify a failed-turn error as a provider capacity failure (rate limit,
// quota exhaustion, or transient overload) and, when the provider said so,
// recover how long to wait. Pure and provider-neutral: it reads the OpenCode
// `session.error` payload (`{ name?, message?, data?: {...} }`) or a bare
// string and never touches the wire. The server layer turns a positive result
// into a scheduled auto-resume; a null result keeps the old generic failure.
import type { RateLimitRetryHint, RateLimitScope } from "@polyth/contracts";

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

// "The provider is refusing because you ran out of allowance / money", not a
// malformed request. Kept deliberately narrow so real bugs still surface.
const QUOTA_RE =
  /\b(quota|insufficient[_\s-]?quota|exceeded your current quota|billing hard limit|credit balance (?:is )?too low|out of credits|not enough credits|payment required|upgrade your plan|monthly (?:spend )?limit)\b/i;
// "Too many requests / tokens in a window" — retry after the window rolls.
const RATE_RE =
  /\b(rate[_\s-]?limits?|ratelimited|too many requests|requests? per (?:sec|second|min|minute|hour|day)|tokens? per (?:min|minute)|\brpm\b|\btpm\b|\btpd\b|resource[_\s-]?exhausted|throttl(?:e|ed|ing)|429)\b/i;
// "Provider is briefly at capacity" — Anthropic 529 overloaded_error, etc.
const OVERLOADED_RE =
  /\b(overloaded|overloaded_error|529|at capacity|server is busy|engine is currently overloaded|temporarily unable to process|please retry shortly)\b/i;
// Weak signal: the error class name itself names a limit even if the message is terse.
const LIMIT_NAME_RE = /(rate.?limit|quota|overload|exhaust|too.?many|throttl|capacity)/i;

const PROVIDER_RE =
  /\b(anthropic|claude|openai|chatgpt|gpt|azure|bedrock|vertex|google|gemini|palm|mistral|groq|deepseek|perplexity|cohere|together|fireworks|openrouter|xai|grok)\b/i;

const canonicalProvider = (raw: string): string => {
  const p = raw.toLowerCase();
  if (p === "claude") return "anthropic";
  if (p === "chatgpt" || p === "gpt") return "openai";
  if (p === "gemini" || p === "palm") return "google";
  if (p === "grok") return "xai";
  return p;
};

const clampSec = (n: number): number =>
  Number.isFinite(n) && n > 0 ? Math.min(86_400, Math.max(1, Math.ceil(n))) : 0;

/** `1m30s`, `2m`, `45s`, `500ms`, `1h` → seconds. */
const parseDuration = (raw: string): number => {
  const t = raw.trim().toLowerCase();
  const plain = Number(t);
  if (Number.isFinite(plain)) return plain;
  let total = 0;
  let matched = false;
  const re = /(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)/g;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    matched = true;
    const value = Number(m[1]);
    const unit = m[2]!;
    if (unit === "ms") total += value / 1000;
    else if (unit.startsWith("s")) total += value;
    else if (unit.startsWith("m") && unit !== "ms") total += value * 60;
    else if (unit.startsWith("h")) total += value * 3600;
  }
  return matched ? total : NaN;
};

const headerValue = (headers: unknown, name: string): string | undefined => {
  const rec = asRecord(headers);
  if (!rec) return undefined;
  for (const [key, value] of Object.entries(rec)) {
    if (key.toLowerCase() !== name) continue;
    if (typeof value === "string" || typeof value === "number") return String(value);
  }
  return undefined;
};

/** Provider-advised wait, in seconds, or 0 when nothing parseable is present. */
export const parseRetryAfterSec = (
  message: string,
  data: Record<string, unknown> | undefined,
  now: number,
): number => {
  // 1. Structured fields OpenCode / the AI SDK may forward verbatim.
  for (const key of ["retryAfter", "retryAfterSec", "retry_after", "retryDelay", "retry_delay"]) {
    const raw = data?.[key];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      // Heuristic: a large value is ms, a small one is already seconds.
      return clampSec(raw > 1000 ? raw / 1000 : raw);
    }
    if (typeof raw === "string") {
      const parsed = parseDuration(raw);
      if (Number.isFinite(parsed)) return clampSec(parsed);
    }
  }
  const headers = data?.responseHeaders ?? data?.headers ?? data?.response_headers;
  const headerRetry = headerValue(headers, "retry-after");
  if (headerRetry !== undefined) {
    const asNum = Number(headerRetry);
    if (Number.isFinite(asNum)) return clampSec(asNum);
    const asDate = Date.parse(headerRetry);
    if (Number.isFinite(asDate)) return clampSec((asDate - now) / 1000);
  }
  for (const resetHeader of ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens", "x-ratelimit-reset"]) {
    const value = headerValue(headers, resetHeader);
    if (value === undefined) continue;
    // A bare 10-13 digit integer is a unix reset timestamp, not a duration.
    if (/^\d{9,13}(?:\.\d+)?$/.test(value.trim())) {
      const epoch = Number(value);
      const ms = epoch > 1e12 ? epoch : epoch * 1000;
      return clampSec((ms - now) / 1000);
    }
    const dur = parseDuration(value);
    if (Number.isFinite(dur) && dur > 0) return clampSec(dur);
  }

  // 2. Free text — the shapes the big providers actually emit.
  const patterns: RegExp[] = [
    /try again in\s+([0-9hms.\s]+?)(?:[.,)\]]|$)/i,
    /retry(?:ing)?(?: again)?(?: after| in)?\s+([0-9]+(?:\.[0-9]+)?\s*(?:ms|s|sec|seconds|m|min|minutes|h|hours))/i,
    /retry[-\s]?after[:\s]+([0-9]+(?:\.[0-9]+)?)/i,
    /"?retryDelay"?[:\s]+"?([0-9hms.]+)"?/i,
    /wait\s+([0-9]+(?:\.[0-9]+)?\s*(?:ms|s|sec|seconds|m|min|minutes))/i,
    /available again in\s+([0-9hms.\s]+?)(?:[.,)\]]|$)/i,
  ];
  for (const re of patterns) {
    const m = message.match(re);
    if (!m || !m[1]) continue;
    const dur = parseDuration(m[1]);
    if (Number.isFinite(dur) && dur > 0) return clampSec(dur);
  }
  // Epoch reset embedded in the message ("resets 1735689600").
  const epochMatch = message.match(/reset[^0-9]{0,16}([0-9]{10,13})/i);
  if (epochMatch?.[1]) {
    const epoch = Number(epochMatch[1]);
    const ms = epoch > 1e12 ? epoch : epoch * 1000;
    return clampSec((ms - now) / 1000);
  }
  // ISO / RFC-1123 reset timestamp.
  const isoMatch = message.match(/reset[^0-9]{0,16}(\d{4}-\d{2}-\d{2}[T ][0-9:.]+Z?)/i);
  if (isoMatch?.[1]) {
    const at = Date.parse(isoMatch[1]);
    if (Number.isFinite(at)) return clampSec((at - now) / 1000);
  }
  return 0;
};

const scopeOf = (
  haystack: string,
  statusCode: number | undefined,
): RateLimitScope | null => {
  if (QUOTA_RE.test(haystack)) return "quota";
  if (OVERLOADED_RE.test(haystack) || statusCode === 529 || statusCode === 503) return "overloaded";
  if (RATE_RE.test(haystack) || statusCode === 429) return "rate";
  if (LIMIT_NAME_RE.test(haystack)) return "rate";
  return null;
};

const numberField = (data: Record<string, unknown> | undefined, key: string): number | undefined => {
  const raw = data?.[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
};

/**
 * Returns a retry hint when `error` looks like a provider capacity failure,
 * otherwise null. `error` is the OpenCode `session.error` payload object or a
 * bare message string. `now` is injectable for deterministic tests.
 */
export const classifyProviderLimit = (
  error: unknown,
  now: number = Date.now(),
): RateLimitRetryHint | null => {
  const record = asRecord(error);
  const nested = asRecord(record?.error);
  const data = asRecord(record?.data) ?? asRecord(nested?.data);
  const name =
    typeof record?.name === "string"
      ? record.name
      : typeof nested?.name === "string"
        ? nested.name
        : "";
  const message =
    typeof error === "string"
      ? error
      : [
          typeof data?.message === "string" ? data.message : "",
          typeof record?.message === "string" ? record.message : "",
          typeof nested?.message === "string" ? nested.message : "",
        ]
          .filter(Boolean)
          .join(" ")
          .trim() || name;
  if (!message && !name) return null;

  const statusCode =
    numberField(data, "statusCode") ??
    numberField(data, "status") ??
    numberField(record, "statusCode") ??
    numberField(record, "status");
  const haystack = `${name} ${message}`;
  const scope = scopeOf(haystack, statusCode);
  if (!scope) return null;

  // A hard, non-retryable auth/config failure can still mention "quota" in
  // passing (e.g. "invalid api key, no quota"): don't wait on those.
  if (/\b(invalid|incorrect|missing|revoked|expired|unauthorized|forbidden|not found|does not exist|unknown model)\b.*\b(api[_\s-]?key|token|credential|model)\b/i.test(message)) {
    return null;
  }

  const providerId =
    typeof data?.providerID === "string"
      ? data.providerID
      : typeof record?.providerID === "string"
        ? record.providerID
        : typeof nested?.providerID === "string"
          ? nested.providerID
          : undefined;
  const sniffed = haystack.match(PROVIDER_RE)?.[1];
  const provider = providerId ?? (sniffed ? canonicalProvider(sniffed) : undefined);

  const retryAfterSec = parseRetryAfterSec(message, data, now);
  return {
    scope,
    ...(provider ? { provider } : {}),
    ...(retryAfterSec > 0 ? { retryAfterSec } : {}),
  };
};
