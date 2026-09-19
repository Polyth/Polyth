import type {
  AcpPromptErrorTranslation,
  AcpPromptResultTranslation,
  AcpPromptTranslationContext,
} from "@polyth/backend-acp";
import type { RuntimeEvent } from "@polyth/contracts";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const nonNegativeNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

const usageEvent = (
  modelID: string,
  input: number,
  output: number,
): Extract<RuntimeEvent, { type: "usage/recorded" }> => ({
  type: "usage/recorded",
  model: { providerID: "google", modelID },
  tokens: { input, output },
});

export function translateGeminiPromptResult(
  result: unknown,
  context: AcpPromptTranslationContext,
): AcpPromptResultTranslation | undefined {
  const root = record(result);
  const meta = record(root?._meta);
  const quota = record(meta?.quota);
  const rows = Array.isArray(quota?.model_usage) ? quota.model_usage : [];
  const events: RuntimeEvent[] = [];

  for (const value of rows) {
    const row = record(value);
    const modelID = typeof row?.model === "string" && row.model.trim()
      ? row.model.trim()
      : undefined;
    const tokens = record(row?.token_count);
    const input = nonNegativeNumber(tokens?.input_tokens);
    const output = nonNegativeNumber(tokens?.output_tokens);
    if (!modelID || input === undefined || output === undefined) continue;
    events.push(usageEvent(modelID, input, output));
  }

  if (events.length === 0) {
    const tokens = record(quota?.token_count);
    const input = nonNegativeNumber(tokens?.input_tokens);
    const output = nonNegativeNumber(tokens?.output_tokens);
    if (input !== undefined && output !== undefined && (input > 0 || output > 0)) {
      events.push(usageEvent(context.model?.modelID ?? "unknown", input, output));
    }
  }

  return events.length ? { events } : undefined;
}

export function translateGeminiPromptError(
  error: unknown,
  _context: AcpPromptTranslationContext,
): AcpPromptErrorTranslation | undefined {
  const value = record(error);
  const rpcCode = nonNegativeNumber(value?.rpcCode);
  if (rpcCode !== 429) return undefined;

  return {
    admitted: true,
    error: "Gemini rate limit reached",
    code: "rate-limited",
    retry: {
      scope: "rate",
      provider: "google",
    },
  };
}
