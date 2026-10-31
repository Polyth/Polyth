// Bounded OpenAI-compatible /models probe. Not an inference request — never
// spend user credits. Failure is not fatal; callers fall back to manual models.

import { modelsUrl, redactProviderError, validateProviderBaseURL } from "./customProvider.ts";

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_MAX_MODELS = 512;
const MAX_MODEL_ID_LENGTH = 256;
const MAX_MODEL_NAME_LENGTH = 256;

export interface DiscoveredModel {
  id: string;
  name?: string;
}

export interface DiscoverModelsInput {
  baseURL: string;
  apiKey?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  maxModels?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export type DiscoverModelsResult =
  | { ok: true; models: DiscoveredModel[] }
  | { ok: false; code: "unsupported" | "unreachable" | "auth-rejected" | "invalid-response" | "cancelled"; message: string };

const errResult = (
  code: "unsupported" | "unreachable" | "auth-rejected" | "invalid-response" | "cancelled",
  message: string,
  secrets: readonly string[] = [],
): DiscoverModelsResult => ({ ok: false, code, message: redactProviderError(message, secrets) });

function parseModelList(body: unknown, maxModels: number): DiscoveredModel[] | undefined {
  const rows = (value: unknown): unknown[] | undefined => {
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") {
      const o = value as Record<string, unknown>;
      if (Array.isArray(o.data)) return o.data;
      if (Array.isArray(o.models)) return o.models;
    }
    return undefined;
  };
  const list = rows(body);
  if (!list) return undefined;
  const out: DiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (out.length >= maxModels) break;
    if (typeof entry === "string" && entry && !seen.has(entry)) {
      if (entry.length > MAX_MODEL_ID_LENGTH) continue;
      seen.add(entry);
      out.push({ id: entry });
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id : typeof rec.name === "string" ? rec.name : "";
    if (!id || id.length > MAX_MODEL_ID_LENGTH || seen.has(id)) continue;
    seen.add(id);
    const name = typeof rec.name === "string" && rec.name !== id ? rec.name.slice(0, MAX_MODEL_NAME_LENGTH) : undefined;
    out.push({ id, ...(name ? { name } : {}) });
  }
  return out;
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; tooLarge: true }> {
  const declared = response.headers.get("content-length");
  if (declared) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, tooLarge: true };
    }
  }
  if (!response.body) {
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength > maxBytes) return { ok: false, tooLarge: true };
    return { ok: true, bytes: buf };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, tooLarge: true };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

export async function discoverOpenAiModels(input: DiscoverModelsInput): Promise<DiscoverModelsResult> {
  const secrets = [
    ...(input.apiKey ? [input.apiKey] : []),
    ...Object.values(input.headers ?? {}),
  ];
  let baseURL: string;
  try {
    baseURL = validateProviderBaseURL(input.baseURL);
  } catch (e) {
    return errResult("invalid-response", (e as Error).message, secrets);
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxModels = input.maxModels ?? DEFAULT_MAX_MODELS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  input.signal?.addEventListener("abort", onAbort, { once: true });
  const headers: Record<string, string> = { Accept: "application/json" };
  if (input.apiKey) headers.Authorization = `Bearer ${input.apiKey}`;
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    if (key.toLowerCase() === "authorization" && input.apiKey) continue;
    headers[key] = value;
  }
  try {
    const fetchImpl = input.fetchImpl ?? fetch;
    const response = await fetchImpl(modelsUrl(baseURL), {
      method: "GET",
      headers,
      signal: controller.signal,
      redirect: "error",
    });
    if (response.status === 401 || response.status === 403) {
      return errResult("auth-rejected", "Authentication rejected — update API key", secrets);
    }
    if (response.status === 404 || response.status === 405) {
      return errResult("unsupported", "Model discovery unavailable — add model manually", secrets);
    }
    if (!response.ok) {
      return errResult("unreachable", `Endpoint unreachable — check Base URL (${response.status})`, secrets);
    }
    const body = await readBoundedBody(response, maxBytes);
    if (!body.ok) {
      return errResult("invalid-response", "Model list is too large to import", secrets);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(body.bytes));
    } catch {
      return errResult("invalid-response", "Malformed model response — add model manually", secrets);
    }
    const models = parseModelList(parsed, maxModels);
    if (!models) {
      return errResult("invalid-response", "Malformed model response — add model manually", secrets);
    }
    return { ok: true, models };
  } catch (e) {
    if (controller.signal.aborted && input.signal?.aborted) {
      return errResult("cancelled", "Discovery cancelled", secrets);
    }
    if (controller.signal.aborted) {
      return errResult("unreachable", "Endpoint unreachable — check Base URL", secrets);
    }
    const message = e instanceof Error ? e.message : String(e);
    if (/redirect/i.test(message)) {
      return errResult("unreachable", "Endpoint unreachable — redirects are not followed", secrets);
    }
    return errResult("unreachable", "Endpoint unreachable — check Base URL", secrets);
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
  }
}
