import type { SpaceStorage } from "@polyth/contracts";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  DEFAULT_EXPLAIN_PROMPT,
  DEFAULT_FIX_PROMPT,
  defaultInlineAiSettings,
  type InlineAiSettings,
} from "./inlineAiShared.ts";

export {
  DEFAULT_EXPLAIN_PROMPT,
  DEFAULT_FIX_PROMPT,
  MAX_INLINE_AI_SELECTION_CHARS,
  defaultInlineAiSettings,
  substituteInlineAiPrompt,
  parseModelOverride,
  type InlineAiAction,
  type InlineAiSettings,
} from "./inlineAiShared.ts";

export const INLINE_AI_SETTINGS_FILE = "files/inline-ai-settings.json";

function settingsPath(storage: SpaceStorage): string {
  return storage.path(INLINE_AI_SETTINGS_FILE);
}

export async function loadInlineAiSettings(storage: SpaceStorage): Promise<InlineAiSettings> {
  try {
    const raw = await readFile(settingsPath(storage), "utf8");
    const parsed = JSON.parse(raw) as Partial<InlineAiSettings>;
    return {
      explainPrompt: typeof parsed.explainPrompt === "string" && parsed.explainPrompt.trim()
        ? parsed.explainPrompt
        : DEFAULT_EXPLAIN_PROMPT,
      fixPrompt: typeof parsed.fixPrompt === "string" && parsed.fixPrompt.trim()
        ? parsed.fixPrompt
        : DEFAULT_FIX_PROMPT,
      ...(typeof parsed.modelOverride === "string" ? { modelOverride: parsed.modelOverride } : {}),
    };
  } catch {
    return defaultInlineAiSettings();
  }
}

export async function saveInlineAiSettings(
  storage: SpaceStorage,
  input: Partial<InlineAiSettings>,
): Promise<InlineAiSettings> {
  const current = await loadInlineAiSettings(storage);
  const next: InlineAiSettings = {
    explainPrompt: typeof input.explainPrompt === "string" && input.explainPrompt.trim()
      ? input.explainPrompt
      : current.explainPrompt,
    fixPrompt: typeof input.fixPrompt === "string" && input.fixPrompt.trim()
      ? input.fixPrompt
      : current.fixPrompt,
    ...(input.modelOverride === ""
      ? {}
      : typeof input.modelOverride === "string"
        ? { modelOverride: input.modelOverride }
        : current.modelOverride !== undefined
          ? { modelOverride: current.modelOverride }
          : {}),
  };
  const path = settingsPath(storage);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(next, null, 2), "utf8");
  return next;
}
