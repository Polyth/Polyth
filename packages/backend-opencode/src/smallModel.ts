// Direct provider transport for short, stateless utility completions.  This
// intentionally lives in the OpenCode backend package: feature packages never
// see provider credentials or make provider HTTP calls.
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
  if (typeof value !== "string" || !value.trim()) throw new Error("provider returned an empty completion");
  return value.trim();
};

/** Attempt a direct request.  Missing credentials/capabilities are reported as
 * `unsupported` so the server utility service can use its reliable oneShot
 * adapter; provider failures remain real failures and are never retried as a
 * session turn (which could double-bill). */
export async function completeSmallModelDirect(
  request: SmallModelCompletionRequest,
): Promise<SmallModelCompletionResult> {
  const model = request.model;
  if (!model) throw unsupported("unresolved");
  const started = performance.now();
  const signal = timeoutSignal(request.signal, request.timeoutMs);
  const compatible = OPENAI_COMPATIBLE[model.providerID.toLowerCase()];

  if (compatible) {
    const key = process.env[compatible.keyEnv];
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
    if (!response.ok) throw new Error(`provider completion failed (${response.status})`);
    const body = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    return {
      text: nonEmptyText(contentText(body.choices?.[0]?.message?.content)),
      providerID: model.providerID, modelID: model.modelID, inputTruncated: false,
      transport: "direct", latencyMs: Math.round(performance.now() - started),
    };
  }

  if (model.providerID.toLowerCase() === "anthropic") {
    const key = process.env.ANTHROPIC_API_KEY;
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
    if (!response.ok) throw new Error(`provider completion failed (${response.status})`);
    const body = await response.json() as { content?: unknown };
    return {
      text: nonEmptyText(contentText(body.content)),
      providerID: model.providerID, modelID: model.modelID, inputTruncated: false,
      transport: "direct", latencyMs: Math.round(performance.now() - started),
    };
  }
  throw unsupported(model.providerID);
}
