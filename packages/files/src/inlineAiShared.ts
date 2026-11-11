import type { ModelRef } from "@polyth/contracts";

export const MAX_INLINE_AI_SELECTION_CHARS = 16_000;

export const DEFAULT_EXPLAIN_PROMPT =
  "Explain this code from {{path}} in plain language. Be concise.\n\n{{selection}}";
export const DEFAULT_FIX_PROMPT =
  "Fix this code from {{path}}. Return only the corrected code. No markdown fences, no explanation.\n\n{{selection}}";

export type InlineAiAction = "explain" | "fix";

/**
 * Sent with every Explain/Fix request, whatever the user's own prompt says. The
 * prompt names a file path, and a model that believes it has tools answers a
 * path by "reading" it: the reply was a written-out Read call instead of an
 * explanation.
 */
export const INLINE_AI_SYSTEM_PROMPT =
  "You help with a selection from a file open in an editor. You have no tools and cannot open files or run commands. " +
  "The selected text in the request is everything you get, so work from it alone. Reply with the answer itself, " +
  "never with a tool call or markup that imitates one.";

/** Markup a model writes when it tries to call a tool in plain text. */
const TOOL_CALL_MARKUP = /<\/?(?:antml:)?(?:invoke|function_calls|parameter|tool_call|tool_use)\b/i;

/**
 * True when a reply contains a tool call written as text that the selection did
 * not already contain, so it is an attempt to use a tool rather than an answer.
 * A selection that itself contains such markup keeps its legitimate fixes.
 */
export function replyIsToolCall(reply: string, selection: string): boolean {
  return TOOL_CALL_MARKUP.test(reply) && !TOOL_CALL_MARKUP.test(selection);
}

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
