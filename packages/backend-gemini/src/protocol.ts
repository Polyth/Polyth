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

  const stopReason = typeof root?.stopReason === "string" ? root.stopReason : undefined;
  const terminal = stopReason === "max_tokens"
    ? {
        reason: "error" as const,
        error: "Gemini stopped because the context/token limit was reached",
        code: "unknown" as const,
      }
    : stopReason === "max_turn_requests"
      ? {
          reason: "error" as const,
          error: "Gemini stopped after reaching its agent-loop turn limit",
          code: "unknown" as const,
        }
      : undefined;

  return events.length || terminal
    ? {
        ...(events.length ? { events } : {}),
        ...(terminal ? { terminal } : {}),
      }
    : undefined;
}

export function translateGeminiPromptError(
  error: unknown,
  context: AcpPromptTranslationContext,
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
      resumeMode: context.hadToolActivity ? "continue" : "replay",
    },
  };
}
