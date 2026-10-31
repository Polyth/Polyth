import { authError } from "./errors.ts";
import { safeHttpUrl } from "./url.ts";

export type ParsedAuthorizationCode =
  | { ok: true; code: string }
  | { ok: false; error: ReturnType<typeof authError> };

const DANGEROUS_SCHEMES = /^(javascript|data|vbscript|file|blob|about|chrome|view-source|ws|wss):/i;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Raw code, or an http(s) callback URL's `code` query param. Never fetches. */
export const parseAuthorizationCode = (input: string): ParsedAuthorizationCode => {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: authError("AUTH_INPUT_INVALID", { field: "code" }) };
  if (DANGEROUS_SCHEMES.test(trimmed)) {
    return { ok: false, error: authError("AUTH_INPUT_INVALID", { field: "code", details: "unsupported URL scheme" }) };
  }
  if (/^https?:\/\//i.test(trimmed) || (HAS_SCHEME.test(trimmed) && trimmed.includes("://"))) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return { ok: false, error: authError("AUTH_INPUT_INVALID", { field: "code", details: "malformed callback URL" }) };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { ok: false, error: authError("AUTH_INPUT_INVALID", { field: "code", details: "unsupported URL scheme" }) };
    }
    const code = (url.searchParams.get("code") ?? url.searchParams.get("authorization_code") ?? "").trim();
    if (code) return { ok: true, code };
    const oauthError = url.searchParams.get("error");
    if (oauthError === "access_denied") {
      const description = url.searchParams.get("error_description") ?? undefined;
      return { ok: false, error: authError("AUTH_DENIED", { field: "code", ...(description ? { details: description } : {}) }) };
    }
    if (oauthError) {
      return { ok: false, error: authError("AUTH_CALLBACK_FAILED", { field: "code", details: oauthError }) };
    }
    return { ok: false, error: authError("AUTH_INPUT_INVALID", { field: "code", details: "callback URL has no code" }) };
  }
  if (HAS_SCHEME.test(trimmed) && /[:/]/.test(trimmed)) {
    return { ok: false, error: authError("AUTH_INPUT_INVALID", { field: "code", details: "unsupported URL scheme" }) };
  }
  return { ok: true, code: trimmed };
};

export interface ExtractedDeviceFlow {
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  expiresIn?: number;
}

const USER_CODE_IN_TEXT = /\b(?:user[_ ]?code|device[_ ]?code|enter(?:\s+the)?\s+code)\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{3,31})\b/i;
const STANDALONE_CODE = /\b([A-Z0-9]{4,8}(?:-[A-Z0-9]{3,8}){1,3})\b/;
const URL_IN_TEXT = /https?:\/\/[^\s)\]>'"]+/gi;

const stringField = (record: Record<string, unknown>, keys: readonly string[]): string | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
};

const numberField = (record: Record<string, unknown>, keys: readonly string[]): number | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  }
};

/**
 * Structured fields first (if an adapter actually supplies them), then
 * instructions. Never treats a generic OAuth authorize URL as a device
 * verification URI — that is left as `authorization.url` for the UI.
 */
export const extractDeviceFlow = (
  input: {
    userCode?: unknown;
    verificationUri?: unknown;
    verificationUriComplete?: unknown;
    expiresIn?: unknown;
    instructions?: unknown;
    url?: unknown;
  } & Record<string, unknown>,
): ExtractedDeviceFlow => {
  const record = input as Record<string, unknown>;
  const structured: ExtractedDeviceFlow = {
    ...(stringField(record, ["userCode", "user_code", "deviceCode", "device_code"])
      ? { userCode: stringField(record, ["userCode", "user_code", "deviceCode", "device_code"]) }
      : {}),
    ...(safeHttpUrl(stringField(record, ["verificationUri", "verification_uri"]))
      ? { verificationUri: safeHttpUrl(stringField(record, ["verificationUri", "verification_uri"])) }
      : {}),
    ...(safeHttpUrl(stringField(record, ["verificationUriComplete", "verification_uri_complete"]))
      ? { verificationUriComplete: safeHttpUrl(stringField(record, ["verificationUriComplete", "verification_uri_complete"])) }
      : {}),
    ...(numberField(record, ["expiresIn", "expires_in"])
      ? { expiresIn: numberField(record, ["expiresIn", "expires_in"]) }
      : {}),
  };

  const instructions = typeof input.instructions === "string" ? input.instructions : "";
  if (!structured.userCode && instructions) {
    const labeled = USER_CODE_IN_TEXT.exec(instructions)?.[1];
    const standalone = STANDALONE_CODE.exec(instructions)?.[1];
    const userCode = labeled ?? standalone;
    if (userCode) structured.userCode = userCode;
  }
  if (!structured.verificationUri && structured.userCode && instructions) {
    const urls = instructions.match(URL_IN_TEXT) ?? [];
    const verification = urls.map((item) => safeHttpUrl(item)).find(Boolean);
    if (verification) structured.verificationUri = verification;
  }
  return structured;
};

export const extractUrls = (text: string): string[] => {
  const found = text.match(URL_IN_TEXT) ?? [];
  const out: string[] = [];
  for (const raw of found) {
    const href = safeHttpUrl(raw);
    if (href && !out.includes(href)) out.push(href);
  }
  return out;
};
