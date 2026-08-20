import type { RenderMessage } from "../reduce.ts";

export interface PromptHistoryCursor {
  index: number | null;
  draft: string;
}

export interface PromptHistoryStep {
  text: string;
  cursor: PromptHistoryCursor;
}

export const emptyPromptHistoryCursor = (): PromptHistoryCursor => ({ index: null, draft: "" });

/** Derive the per-session history ring from durable visible messages. */
export function promptHistory(messages: readonly RenderMessage[], limit = 100): string[] {
  const values: string[] = [];
  for (const message of messages) {
    if (message.undone) continue;
    if (message.kind === "user" && message.text.trim()) values.push(message.raw ?? message.text);
    if (message.kind === "tool" && message.tool === "shell") {
      const command = message.input.command;
      if (typeof command === "string" && command.trim()) values.push(`!${command}`);
    }
  }
  return values.slice(-Math.max(1, limit));
}

export function stepPromptHistory(
  items: readonly string[],
  currentText: string,
  cursor: PromptHistoryCursor,
  direction: "up" | "down",
): PromptHistoryStep {
  if (items.length === 0) return { text: currentText, cursor };
  if (direction === "up") {
    const index = cursor.index === null
      ? items.length - 1
      : Math.max(0, Math.min(items.length - 1, cursor.index - 1));
    return {
      text: items[index]!,
      cursor: { index, draft: cursor.index === null ? currentText : cursor.draft },
    };
  }
  if (cursor.index === null) return { text: currentText, cursor };
  const index = cursor.index + 1;
  if (index >= items.length) return { text: cursor.draft, cursor: emptyPromptHistoryCursor() };
  return { text: items[index]!, cursor: { ...cursor, index } };
}

export function restorePromptHistoryDraft(
  currentText: string,
  cursor: PromptHistoryCursor,
): PromptHistoryStep {
  return cursor.index === null
    ? { text: currentText, cursor }
    : { text: cursor.draft, cursor: emptyPromptHistoryCursor() };
}
