// Custom-provider domain: slugs, URL policy, protocol allowlist. No OpenCode
// JSON and no secrets — the adapter maps this onto opencode.json.

import {
  CUSTOM_PROVIDER_ADAPTERS,
  type CustomProviderAuthMode,
  type CustomProviderHeaderPatch,
  type CustomProviderProtocol,
} from "@polyth/contracts";

const err = (code: string, message: string) => Object.assign(new Error(message), { code });

export const CUSTOM_PROVIDER_PROTOCOLS: readonly CustomProviderProtocol[] = [
  "openai-compatible",
  "openai-responses",
];

export const CUSTOM_PROVIDER_AUTH_MODES: readonly CustomProviderAuthMode[] = [
  "api-key",
  "none",
];

export { CUSTOM_PROVIDER_ADAPTERS };

export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
export const MAX_NAME_LENGTH = 80;
export const MAX_URL_LENGTH = 2048;
export const MAX_HEADER_COUNT = 32;
export const MAX_HEADER_NAME_LENGTH = 128;
export const MAX_HEADER_VALUE_LENGTH = 4096;
export const MAX_MODEL_LIMIT = 2_000_000;

export interface CustomProviderInput {
  id?: string;
  name: string;
  baseURL: string;
  protocol: CustomProviderProtocol;
  authMode: CustomProviderAuthMode;
  apiKey?: string;
  headerPatch?: CustomProviderHeaderPatch;
}

export interface ValidatedCustomProvider {
  id: string;
  name: string;
  baseURL: string;
  protocol: CustomProviderProtocol;
  npm: string;
  authMode: CustomProviderAuthMode;
  apiKey?: string;
  headerPatch?: CustomProviderHeaderPatch;
}

export function slugifyProviderId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (!slug) return "custom";
  return /^[a-z]/.test(slug) ? slug : `p-${slug}`.slice(0, 48);
}

export function uniqueProviderId(base: string, taken: ReadonlySet<string>): string {
  const root = PROVIDER_ID_PATTERN.test(base) ? base : slugifyProviderId(base);
  if (!taken.has(root)) return root;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${root.slice(0, 58)}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw err("conflict", "could not allocate a unique provider id");
}

export function validateProviderId(id: string): string {
  const trimmed = id.trim().toLowerCase();
  if (!PROVIDER_ID_PATTERN.test(trimmed)) {
    throw err("invalid-input", "provider id must be a lowercase slug (start with a letter, then letters, digits, or hyphens)");
  }
  return trimmed;
}

export function validateModelId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) throw err("invalid-input", "model id is required");
  if (!MODEL_ID_PATTERN.test(trimmed)) {
    throw err("invalid-input", "model id is invalid");
  }
  return trimmed;
}

export function validateModelLimit(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw err("invalid-input", `${label} must be a positive integer`);
  }
  if (value > MAX_MODEL_LIMIT) throw err("invalid-input", `${label} is too large`);
  return value;
}

/** http/https only. Localhost and private LAN are allowed (LM Studio, Ollama, vLLM).
 * Query and hash are rejected so discovery cannot form surprising /models?... URLs. */
export function validateProviderBaseURL(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw err("invalid-input", "base URL is required");
  if (trimmed.length > MAX_URL_LENGTH) throw err("invalid-input", "base URL is too long");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw err("invalid-input", "enter an http or https URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw err("invalid-input", "only http and https URLs are allowed");
  }
  if (url.username || url.password) {
    throw err("invalid-input", "do not put credentials in the URL");
  }
  if (url.search || url.hash) {
    throw err("invalid-input", "base URL must not include a query string or fragment");
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "") || url.origin;
}

export function validateCustomHeaders(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw err("invalid-input", "headers must be an object of string values");
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const name = key.trim();
    if (!name || name.length > MAX_HEADER_NAME_LENGTH || /[\r\n]/.test(name) || !/^[\w!#$%&'*+.^`|~-]+$/.test(name)) {
      throw err("invalid-input", `invalid header name "${key.slice(0, 40)}"`);
    }
    if (typeof value !== "string" || /[\r\n]/.test(value)) {
      throw err("invalid-input", `header "${name}" must be a single-line string`);
    }
    if (value.length > MAX_HEADER_VALUE_LENGTH) throw err("invalid-input", `header "${name}" is too long`);
    out[name] = value;
  }
  if (Object.keys(out).length > MAX_HEADER_COUNT) {
    throw err("invalid-input", `at most ${MAX_HEADER_COUNT} headers are allowed`);
  }
  return Object.keys(out).length ? out : undefined;
}

export function validateHeaderPatch(raw: unknown): CustomProviderHeaderPatch | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw err("invalid-input", "header patch must be an object");
  }
  const rec = raw as Record<string, unknown>;
  const patch: CustomProviderHeaderPatch = {};
  if (rec.clear === true) patch.clear = true;
  if (rec.set !== undefined) {
    const set = validateCustomHeaders(rec.set);
    if (set) patch.set = set;
  }
  if (rec.unset !== undefined) {
    if (!Array.isArray(rec.unset) || rec.unset.some((name) => typeof name !== "string")) {
      throw err("invalid-input", "header unset must be an array of names");
    }
    const unset = rec.unset.map((name) => name.trim()).filter(Boolean);
    if (unset.length > MAX_HEADER_COUNT) throw err("invalid-input", "too many headers to remove");
    if (unset.length) patch.unset = unset;
  }
  return patch.clear || patch.set || patch.unset ? patch : undefined;
}

export function validateProtocol(value: unknown): CustomProviderProtocol {
  if (value === "openai-compatible" || value === "openai-responses") return value;
  throw err("invalid-input", "unsupported API type");
}

export function validateAuthMode(value: unknown): CustomProviderAuthMode {
  if (value === "api-key" || value === "none") return value;
  throw err("invalid-input", "unsupported authentication mode");
}

export function validateCustomProviderInput(
  input: CustomProviderInput,
  takenIds: ReadonlySet<string>,
  opts: { existingId?: string } = {},
): ValidatedCustomProvider {
  const name = input.name.trim();
  if (!name) throw err("invalid-input", "display name is required");
  if (name.length > MAX_NAME_LENGTH) throw err("invalid-input", "display name is too long");
  const protocol = validateProtocol(input.protocol);
  const authMode = validateAuthMode(input.authMode);
  const baseURL = validateProviderBaseURL(input.baseURL);
  const headerPatch = input.headerPatch;
  if (headerPatch?.set) validateCustomHeaders(headerPatch.set);
  let id: string;
  if (opts.existingId) {
    id = opts.existingId;
  } else if (input.id?.trim()) {
    id = validateProviderId(input.id);
    if (takenIds.has(id)) throw err("conflict", "a provider with this ID already exists");
  } else {
    id = uniqueProviderId(slugifyProviderId(name), takenIds);
  }
  const apiKey = authMode === "api-key" ? input.apiKey?.trim() : undefined;
  if (authMode === "api-key" && !opts.existingId && !apiKey) {
    throw err("invalid-input", "API key is required");
  }
  if (authMode === "api-key" && opts.existingId && input.apiKey !== undefined && !apiKey) {
    // Explicit empty string on edit means preserve, not clear — drop it.
  }
  return {
    id,
    name,
    baseURL,
    protocol,
    npm: CUSTOM_PROVIDER_ADAPTERS[protocol],
    authMode,
    ...(apiKey ? { apiKey } : {}),
    ...(headerPatch ? { headerPatch } : {}),
  };
}

export function redactProviderError(message: string, secrets: readonly string[] = []): string {
  let out = message;
  const unique = [...new Set(secrets.filter((secret) => secret && secret.length >= 4))];
  unique.sort((a, b) => b.length - a.length);
  for (const secret of unique) {
    out = out.split(secret).join("***");
  }
  return out
    .replace(/Bearer\s+\S+/gi, "Bearer ***")
    .replace(/api[_-]?key["']?\s*[:=]\s*["']?[^"'\s]+/gi, "api_key=***")
    .replace(/x-api-key["']?\s*[:=]\s*["']?[^"'\s]+/gi, "x-api-key=***")
    .replace(/(authorization|x-api-key|api-key)\s*[:=]\s*\S+/gi, "$1=***");
}

export function modelsUrl(baseURL: string): string {
  const base = baseURL.replace(/\/+$/, "");
  return `${base}/models`;
}
