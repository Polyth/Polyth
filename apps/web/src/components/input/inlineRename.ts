// Shared keyboard/blur contract for inline rename fields (sessions, projects,
// anything else edited in place). Every rename field in the app behaves the
// same way, on every responsive presentation, because they all use this.
import { useCallback, useRef } from "react";
import { isCompositionKey } from "./editorCore.ts";

interface RenameKeyEvent {
  key: string;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
  keyCode?: number;
}

export interface InlineRenameHandlers {
  onKeyDown(event: RenameKeyEvent): void;
  onBlur(): void;
}

/**
 * Enter commits, Escape cancels, blur commits.
 *
 * Two things this gets right that a bare `if (e.key === "Enter")` does not:
 *
 * - An Enter that ends an IME composition is choosing a candidate, not
 *   submitting. Committing there would save the raw phonetic text.
 * - Committing detaches the field, and detaching fires blur. Without a latch
 *   the same edit is submitted twice — two rename requests, the second racing
 *   against the first's result.
 *
 * `editing` identifies what is being renamed — `false`/`null` when nothing is,
 * otherwise the row's own id where several rows share one handler. The latch
 * is armed afresh whenever that identity changes, so a second rename behaves
 * exactly like the first, including when the user goes straight from renaming
 * one row to renaming another.
 */
export function useInlineRename(opts: {
  editing: string | boolean | null;
  commit(): void;
  cancel(): void;
}): InlineRenameHandlers {
  const { editing, commit, cancel } = opts;
  const settled = useRef(false);
  const wasEditing = useRef<string | boolean | null>(false);
  if (editing && editing !== wasEditing.current) settled.current = false;
  wasEditing.current = editing;

  const once = useCallback((run: () => void) => {
    if (settled.current) return;
    settled.current = true;
    run();
  }, []);

  return {
    onKeyDown: useCallback((event: RenameKeyEvent) => {
      const like = {
        key: event.key,
        isComposing: event.nativeEvent?.isComposing,
        keyCode: event.nativeEvent?.keyCode ?? event.keyCode,
      };
      if (isCompositionKey(like, false)) return;
      if (event.key === "Enter") once(commit);
      else if (event.key === "Escape") once(cancel);
    }, [commit, cancel, once]),
    onBlur: useCallback(() => once(commit), [commit, once]),
  };
}
