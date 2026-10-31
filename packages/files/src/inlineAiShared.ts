import type { ModelRef } from "@polyth/contracts";

export const MAX_INLINE_AI_SELECTION_CHARS = 16_000;

export const DEFAULT_EXPLAIN_PROMPT =
  "Explain this code from {{path}} in plain language. Be concise.\n\n{{selection}}";
export const DEFAULT_FIX_PROMPT =
  "Fix this code from {{path}}. Return only the corrected code. No markdown fences, no explanation.\n\n{{selection}}";

export type InlineAiAction = "explain" | "fix";

export interface InlineAiSettings {
  explainPrompt: string;
  fixPrompt: string;
  modelOverride?: string;
}

export const defaultInlineAiSettings = (): InlineAiSettings => ({
  explainPrompt: DEFAULT_EXPLAIN_PROMPT,
  fixPrompt: DEFAULT_FIX_PROMPT,
});

export function substituteInlineAiPrompt(
  template: string,
  vars: { selection: string; path: string; language: string },
): string {
  return template
    .replaceAll("{{selection}}", vars.selection)
    .replaceAll("{{path}}", vars.path)
    .replaceAll("{{language}}", vars.language);
}

export type InlineAiModelRef = ModelRef & { harnessId?: string };

export function parseModelOverride(raw: string | undefined): InlineAiModelRef | undefined {
  if (!raw?.trim()) return undefined;
  const parts = raw.trim().split("/");
  if (parts.length < 2) return undefined;
  const harnessId = parts.length >= 3 ? parts[0] : undefined;
  const providerID = parts.length >= 3 ? parts[1]! : parts[0]!;
  const modelID = parts.length >= 3 ? parts.slice(2).join("/") : parts[1]!;
  if (!providerID || !modelID) return undefined;
  return harnessId
    ? { harnessId, providerID, modelID }
    : { providerID, modelID };
}
