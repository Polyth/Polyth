// Direct provider transport for short, stateless utility completions.  This
// intentionally lives in the OpenCode backend package: feature packages never
// see provider credentials or make provider HTTP calls.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SmallModelCompletionRequest, SmallModelCompletionResult } from "@polyth/contracts";

type OpenAiCompatible = { keyEnv: string; baseEnv: string; defaultBase: string };

const OPENAI_COMPATIBLE: Record<string, OpenAiCompatible> = {
  openai: { keyEnv: "OPENAI_API_KEY", baseEnv: "OPENAI_BASE_URL", defaultBase: "https://api.openai.com/v1" },
  openrouter: { keyEnv: "OPENROUTER_API_KEY", baseEnv: "OPENROUTER_BASE_URL", defaultBase: "https://openrouter.ai/api/v1" },
  groq: { keyEnv: "GROQ_API_KEY", baseEnv: "GROQ_BASE_URL", defaultBase: "https://api.groq.com/openai/v1" },
  togetherai: { keyEnv: "TOGETHER_API_KEY", baseEnv: "TOGETHER_BASE_URL", defaultBase: "https://api.together.xyz/v1" },
  deepseek: { keyEnv: "DEEPSEEK_API_KEY", baseEnv: "DEEPSEEK_BASE_URL", defaultBase: "https://api.deepseek.com/v1" },
  mistral: { keyEnv: "MISTRAL_API_KEY", baseEnv: "MISTRAL_BASE_URL", defaultBase: "https://api.mistral.ai/v1" },
  xai: { keyEnv: "XAI_API_KEY", baseEnv: "XAI_BASE_URL", defaultBase: "https://api.x.ai/v1" },
};

interface AuthEntry { type?: unknown; key?: unknown; access?: unknown; refresh?: unknown; expires?: unknown; accountId?: unknown }
type AuthStore = Record<string, AuthEntry>;
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

/** OpenCode's credential store is deliberately read only here. Values never
 * cross this backend boundary or appear in any DTO/log/API response. */
const readAuth = (): AuthStore => {
  const dataDir = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  try { return JSON.parse(readFileSync(join(dataDir, "opencode", "auth.json"), "utf8")) as AuthStore; }
  catch { return {}; }
};

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value ? value : undefined;

const providerKey = (providerID: string, envName: string): string | undefined =>
  process.env[envName] || stringValue(readAuth()[providerID]?.key);

const jwtAccountId = (token: string): string | undefined => {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
      "https://api.openai.com/auth"?: { chatgpt_account_id?: unknown };
    };
    return stringValue(payload["https://api.openai.com/auth"]?.chatgpt_account_id);
  } catch { return undefined; }
};

const freshOpenAiAccess = async (entry: AuthEntry, signal?: AbortSignal): Promise<{ access: string; accountId?: string }> => {
  const access = stringValue(entry.access);
  const expires = typeof entry.expires === "number" ? entry.expires : 0;
  if (access && expires > Date.now()) return { access, ...(stringValue(entry.accountId) ? { accountId: stringValue(entry.accountId) } : {}) };
  const refresh = stringValue(entry.refresh);
  if (!refresh) throw unsupported("openai");
  const response = await fetch(CODEX_TOKEN_URL, {
    method: "POST", headers: { "content-type": "application/json" }, signal,
    body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refresh, client_id: CODEX_CLIENT_ID }),
  });
  if (!response.ok) throw new Error(`OpenAI OAuth refresh failed (${response.status})`);
  const body = await response.json() as { access_token?: unknown };
  const refreshed = stringValue(body.access_token);
  if (!refreshed) throw new Error("OpenAI OAuth refresh returned no access token");
  return { access: refreshed, ...(stringValue(entry.accountId) ? { accountId: stringValue(entry.accountId) } : {}) };
};

const unsupported = (providerID: string): Error => Object.assign(
  new Error(`direct small-model transport is unavailable for provider ${providerID}`),
  { code: "unsupported" },
);

const timeoutSignal = (signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined => {
  if (!timeoutMs) return signal;
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
};

const contentText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    if (!part || typeof part !== "object") return "";
    const record = part as Record<string, unknown>;
    return typeof record.text === "string" ? record.text : "";
  }).join("");
};

const nonEmptyText = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw Object.assign(new Error("provider returned an empty completion"), { code: "invalid-response" });
  }
  return value.trim();
};

const providerFailure = (status: number): Error => Object.assign(
  new Error(`provider completion failed (${status})`),
  { code: status === 401 || status === 403 ? "auth-rejected" : status === 404 ? "invalid-model" : "unavailable" },
);

/** Attempt a direct request.  Missing credentials/capabilities are reported as
 * `unsupported` so the server utility service can use its reliable oneShot
 * adapter; provider failures remain real failures and are never retried as a
 * session turn (which could double-bill). */
export async function completeSmallModelDirect(
  request: SmallModelCompletionRequest,
): Promise<SmallModelCompletionResult> {
  const auth = readAuth();
  // Model choice is product policy, not an adapter guess. In particular, an
  // OAuth login does not prove that a hard-coded model is available today.
  const model = request.model;
  if (!model) throw unsupported("unresolved");
  const started = performance.now();
  const signal = timeoutSignal(request.signal, request.timeoutMs);
  const compatible = OPENAI_COMPATIBLE[model.providerID.toLowerCase()];

  if (model.providerID.toLowerCase() === "openai" && auth.openai?.type === "oauth") {
    const credentials = await freshOpenAiAccess(auth.openai, signal);
    const accountId = credentials.accountId ?? jwtAccountId(credentials.access);
    const response = await fetch(CODEX_RESPONSES_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credentials.access}`, "content-type": "application/json",
        accept: "text/event-stream", originator: "opencode", "user-agent": "opencode/1.0",
        ...(accountId ? { "chatgpt-account-id": accountId } : {}),
      },
      signal,
      body: JSON.stringify({
        model: model.modelID, ...(request.systemPrompt ? { instructions: request.systemPrompt } : {}),
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: request.prompt }] }],
        stream: true, store: false,
      }),
    });
    if (!response.ok) throw providerFailure(response.status);
    const raw = await response.text();
    let delta = "";
    let complete = "";
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        const event = JSON.parse(line.slice(5).trim()) as { type?: unknown; delta?: unknown; text?: unknown; response?: { error?: { message?: unknown } }; message?: unknown };
        if (event.type === "response.output_text.delta" && typeof event.delta === "string") delta += event.delta;
        if (event.type === "response.output_text.done" && typeof event.text === "string") complete = event.text;
        if (event.type === "response.failed" || event.type === "error") throw new Error(String(event.response?.error?.message ?? event.message ?? "OpenAI response failed"));
      } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
    }
    return {
      text: nonEmptyText(complete || delta), providerID: model.providerID, modelID: model.modelID,
      inputTruncated: false, transport: "direct", latencyMs: Math.round(performance.now() - started),
    };
  }

  if (compatible) {
    const key = providerKey(model.providerID, compatible.keyEnv);
    if (!key) throw unsupported(model.providerID);
    const base = (process.env[compatible.baseEnv] ?? compatible.defaultBase).replace(/\/$/, "");
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      signal,
      body: JSON.stringify({
        model: model.modelID,
        messages: [
          ...(request.systemPrompt ? [{ role: "system", content: request.systemPrompt }] : []),
          { role: "user", content: request.prompt },
        ],
        temperature: 0,
        ...(request.maxOutputTokens ? { max_completion_tokens: request.maxOutputTokens } : {}),
      }),
    });
    if (!response.ok) throw providerFailure(response.status);
    const body = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    return {
      text: nonEmptyText(contentText(body.choices?.[0]?.message?.content)),
      providerID: model.providerID, modelID: model.modelID, inputTruncated: false,
      transport: "direct", latencyMs: Math.round(performance.now() - started),
    };
  }

  if (model.providerID.toLowerCase() === "anthropic") {
    const key = providerKey(model.providerID, "ANTHROPIC_API_KEY");
    if (!key) throw unsupported(model.providerID);
    const base = (process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/$/, "");
    const response = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      signal,
      body: JSON.stringify({
        model: model.modelID, max_tokens: request.maxOutputTokens ?? 512,
        ...(request.systemPrompt ? { system: request.systemPrompt } : {}),
        messages: [{ role: "user", content: request.prompt }],
      }),
    });
    if (!response.ok) throw providerFailure(response.status);
    const body = await response.json() as { content?: unknown };
    return {
      text: nonEmptyText(contentText(body.content)),
      providerID: model.providerID, modelID: model.modelID, inputTruncated: false,
      transport: "direct", latencyMs: Math.round(performance.now() - started),
    };
  }
  throw unsupported(model.providerID);
}
